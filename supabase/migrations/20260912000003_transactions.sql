-- Transaction ledgers, fulfillment, refunds, immutable snapshots and Outbox
-- Cross-domain function references are resolved after all definitions are installed.
begin;
set local check_function_bodies = false;

-- Every restock/cancel command uses the same inventory lock order as checkout.
CREATE FUNCTION private.lock_order_inventory(p_order_ids uuid[], p_location_id uuid DEFAULT NULL) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare v_stock record;
begin
  for v_stock in
    select im.variant_id, coalesce(p_location_id, im.location_id) as location_id from public.inventory_movements im
    where im.order_id = any(p_order_ids) and im.reason = 'order' and im.delta < 0
    group by im.variant_id, coalesce(p_location_id, im.location_id) order by im.variant_id, coalesce(p_location_id, im.location_id)
  loop
    insert into public.inventory_levels (variant_id, location_id, on_hand)
    values (v_stock.variant_id, v_stock.location_id, 0)
    on conflict on constraint inventory_levels_pkey do nothing;
    perform 1 from public.inventory_levels il
    where il.variant_id = v_stock.variant_id and il.location_id = v_stock.location_id for update;
  end loop;
end;
$$;

-- Recover only an actual deduction. NULL destination releases unshipped stock
-- to original locations; a receipt supplies its explicit inspection destination.
CREATE FUNCTION private.recover_order_stock(p_order_id uuid, p_variant_id uuid, p_quantity integer,
    p_location_id uuid, p_actor_id uuid, p_note text) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare v_deducted bigint; v_recovered bigint; v_source record; v_take integer; v_left integer := p_quantity;
  v_on_hand integer; v_movement bigint;
begin
  if p_quantity is null or p_quantity <= 0 then raise exception 'stock recovery requires a positive quantity'; end if;
  perform 1 from public.orders where id = p_order_id for update nowait;
  if p_location_id is not null and not exists (select 1 from public.locations where id = p_location_id and is_active) then
    raise exception 'receipt location is not active';
  end if;
  select coalesce(sum(-delta::bigint),0) into v_deducted from public.inventory_movements
    where order_id = p_order_id and variant_id = p_variant_id and reason = 'order' and delta < 0;
  select coalesce(sum(delta::bigint),0) into v_recovered from public.inventory_movements
    where order_id = p_order_id and variant_id = p_variant_id and reason in ('cancel','return') and delta > 0;
  if p_quantity > v_deducted - v_recovered then raise exception 'stock recovery exceeds original deduction'; end if;
  perform private.lock_order_inventory(array[p_order_id], p_location_id);
  for v_source in
    select coalesce(p_location_id, im.location_id) as location_id, sum(-im.delta::bigint) as quantity
    from public.inventory_movements im where im.order_id = p_order_id and im.variant_id = p_variant_id
      and im.reason = 'order' and im.delta < 0
    group by coalesce(p_location_id, im.location_id) order by coalesce(p_location_id, im.location_id)
  loop
    if p_location_id is null then
      select coalesce(sum(delta::bigint),0) into v_recovered from public.inventory_movements
        where order_id = p_order_id and variant_id = p_variant_id and location_id = v_source.location_id
          and reason in ('cancel','return') and delta > 0;
      v_take := least(v_left, greatest(v_source.quantity - v_recovered, 0));
    else v_take := v_left; end if;
    if v_take > 0 then
      update public.inventory_levels set on_hand = on_hand + v_take
        where variant_id = p_variant_id and location_id = v_source.location_id returning on_hand into v_on_hand;
      insert into public.inventory_movements(variant_id, location_id, delta, on_hand_after, reason, order_id, actor_id, note)
        values (p_variant_id, v_source.location_id, v_take, v_on_hand,
          case when p_location_id is null then 'cancel' else 'return' end, p_order_id, p_actor_id, p_note) returning id into v_movement;
      v_left := v_left - v_take;
    end if;
    exit when v_left = 0;
  end loop;
  if v_left <> 0 then raise exception 'stock recovery could not be allocated'; end if;
  return v_movement;
end;
$$;

CREATE FUNCTION private.restock_refund_cancellation() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare v_refund commerce.refunds; v_variant uuid;
begin
  if new.restocked_quantity = 0 then return new; end if;
  select * into strict v_refund from commerce.refunds where id = new.refund_id;
  select variant_id into v_variant from public.order_items where id = new.order_item_id;
  perform private.recover_order_stock(new.order_id, v_variant, new.restocked_quantity, null, v_refund.actor_id, v_refund.reason);
  return new;
end;
$$;

CREATE FUNCTION private.canonical_return_quantities(p_items jsonb, p_key text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SET search_path TO '' AS $$
declare v_items jsonb;
begin
  if p_key not in ('order_item_id','return_line_id') or p_key is null then raise exception 'invalid return quantity key'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 100 then
    raise exception 'return items must contain 1 to 100 lines';
  end if;
  if exists (select 1 from jsonb_array_elements(p_items) e where jsonb_typeof(e) <> 'object') then raise exception 'return item must be an object'; end if;
  if exists (select 1 from jsonb_array_elements(p_items) e, jsonb_object_keys(e) k where k not in (p_key, 'quantity')) then
    raise exception 'unsupported return item field';
  end if;
  select jsonb_agg(jsonb_build_object('order_item_id', e -> p_key, 'quantity', e -> 'quantity')) into v_items from jsonb_array_elements(p_items) e;
  v_items := private.canonical_order_item_quantities(v_items);
  select jsonb_agg(jsonb_build_object(p_key, e -> 'order_item_id', 'quantity', e -> 'quantity') order by (e ->> 'order_item_id')::uuid)
    into v_items from jsonb_array_elements(v_items) e;
  return v_items;
end;
$$;

CREATE FUNCTION private.return_line_received(p_id uuid) RETURNS bigint
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $$
  select coalesce(sum(quantity),0) from commerce.return_receipt_lines where return_line_id = p_id;
$$;

CREATE FUNCTION private.lock_return_command(p_order_id uuid, p_key text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  if coalesce(btrim(p_key),'') = '' or length(btrim(p_key)) > 200 then raise exception 'idempotency_key is required (1 to 200 characters)'; end if;
  perform 1 from public.orders where id = p_order_id for update;
  if not found then raise exception 'order not found'; end if;
  -- Order -> return/receipt -> inventory. A real version also fences old RR snapshots.
  update public.orders set updated_at = now() where id = p_order_id;
end;
$$;

CREATE FUNCTION private.return_disposition_json(p_row commerce.return_dispositions) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $$
  select jsonb_build_object('id',p_row.id,'receipt_line_id',p_row.receipt_line_id,'quantity',p_row.quantity,
    'disposition',p_row.disposition,'inventory_movement_id',p_row.inventory_movement_id,'note',p_row.note,'created_at',p_row.created_at);
$$;

CREATE FUNCTION private.return_receipt_json(p_row commerce.return_receipts) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $$
  select jsonb_build_object('id',p_row.id,'return_id',p_row.return_id,'order_id',p_row.order_id,'location_id',p_row.location_id,
    'note',p_row.note,'received_at',p_row.received_at,'lines',coalesce((select jsonb_agg(jsonb_build_object(
      'id',l.id,'return_line_id',l.return_line_id,'quantity',l.quantity,
      'undisposed_quantity',l.quantity - (select coalesce(sum(d.quantity),0) from commerce.return_dispositions d where d.receipt_line_id=l.id),
      'dispositions',coalesce((select jsonb_agg(private.return_disposition_json(d) order by d.created_at,d.id)
        from commerce.return_dispositions d where d.receipt_line_id=l.id),'[]')) order by l.return_line_id)
      from commerce.return_receipt_lines l where l.receipt_id=p_row.id),'[]'));
$$;

CREATE FUNCTION private.return_json(p_row commerce.returns) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $$
  select jsonb_build_object('id',p_row.id,'order_id',p_row.order_id,'fulfillment_id',p_row.fulfillment_id,'status',p_row.status,
    'reason',p_row.reason,'created_at',p_row.created_at,'closed_at',p_row.closed_at,
    'lines',coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'order_item_id',l.order_item_id,'quantity',l.quantity,
      'received_quantity',private.return_line_received(l.id),
      'receivable_quantity',case when p_row.status='open' then l.quantity-private.return_line_received(l.id) else 0 end)
      order by l.order_item_id) from commerce.return_lines l where l.return_id=p_row.id),'[]'),
    'receipts',coalesce((select jsonb_agg(private.return_receipt_json(r) order by r.received_at,r.id)
      from commerce.return_receipts r where r.return_id=p_row.id),'[]'));
$$;

CREATE FUNCTION private.validate_return_fact() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare
  v_row jsonb := to_jsonb(new);
  v_order_id uuid := (v_row ->> 'order_id')::uuid;
  v_return commerce.returns;
  v_receipt commerce.return_receipts;
  v_line commerce.return_receipt_lines;
  v_return_line commerce.return_lines;
  v_variant uuid;
  v_used bigint;
begin
  -- Immutable facts allow only the existing one-way actor erasure exception.
  if tg_op = 'UPDATE' and tg_table_name = 'returns' then
    if to_jsonb(old) ->> 'actor_id' is not null and v_row ->> 'actor_id' is null and v_row-'actor_id' = to_jsonb(old)-'actor_id' then return new; end if;
    if v_row-array['status','closed_at'] is distinct from to_jsonb(old)-array['status','closed_at']
      or to_jsonb(old) ->> 'status' <> 'open' or v_row ->> 'status' not in ('closed','cancelled') then raise exception 'return authorization is immutable except closing'; end if;
    new := jsonb_populate_record(new,jsonb_build_object('closed_at',now()));
  end if;
  perform 1 from public.orders where id = v_order_id for update nowait;
  if not found then raise exception 'return order not found'; end if;
  update public.orders set updated_at=now() where id=v_order_id;
  if tg_table_name = 'returns' then
    if tg_op = 'INSERT' and (v_row ->> 'status' <> 'open' or not exists (
      select 1 from public.fulfillments f where f.id=(v_row ->> 'fulfillment_id')::uuid and f.order_id=v_order_id and f.status in ('shipped','delivered')
    )) then raise exception 'return requires a shipped or delivered fulfillment'; end if;
    if v_row ->> 'status' = 'cancelled' and exists (select 1 from commerce.return_receipts where return_id=(v_row ->> 'id')::uuid) then
      raise exception 'received return cannot be cancelled; close the remainder';
    end if;
  elsif tg_table_name = 'return_lines' then
    select * into v_return from commerce.returns where id=(v_row ->> 'return_id')::uuid;
    if v_return.status is distinct from 'open' then raise exception 'return is not open'; end if;
  elsif tg_table_name = 'return_receipts' then
    select * into v_return from commerce.returns where id=(v_row ->> 'return_id')::uuid;
    if v_return.status is distinct from 'open' then raise exception 'return is not open'; end if;
    if not exists (select 1 from public.locations where id=(v_row ->> 'location_id')::uuid and is_active) then
      raise exception 'receipt location is not active';
    end if;
  elsif tg_table_name = 'return_receipt_lines' then
    select * into v_return_line from commerce.return_lines where id=(v_row ->> 'return_line_id')::uuid;
    select * into v_return from commerce.returns where id=v_return_line.return_id;
    if v_return.status is distinct from 'open' then raise exception 'return is not open'; end if;
    if private.return_line_received(v_return_line.id) + (v_row ->> 'quantity')::integer > v_return_line.quantity then
      raise exception 'receipt quantity exceeds return authorization';
    end if;
  elsif tg_table_name = 'return_dispositions' then
    select * into strict v_line from commerce.return_receipt_lines where id=(v_row ->> 'receipt_line_id')::uuid;
    select * into strict v_receipt from commerce.return_receipts where id=v_line.receipt_id;
    if (v_row ->> 'receipt_id')::uuid <> v_receipt.id or v_order_id <> v_receipt.order_id then raise exception 'disposition receipt ownership mismatch'; end if;
    select coalesce(sum(quantity),0) into v_used from commerce.return_dispositions where receipt_line_id=v_line.id;
    if (v_row ->> 'quantity')::integer > v_line.quantity-v_used then raise exception 'disposition exceeds undisposed receipt quantity'; end if;
    if v_row ->> 'inventory_movement_id' is not null then raise exception 'inventory movement is assigned by disposition'; end if;
    if v_row ->> 'disposition' = 'restock' then
      select oi.variant_id into v_variant from commerce.return_lines l join public.order_items oi on oi.id=l.order_item_id where l.id=v_line.return_line_id;
      new := jsonb_populate_record(new,jsonb_build_object('inventory_movement_id',private.recover_order_stock(
        v_order_id,v_variant,(v_row ->> 'quantity')::integer,v_receipt.location_id,(v_row ->> 'actor_id')::uuid,v_row ->> 'note')));
    end if;
  end if;
  return new;
end;
$$;

CREATE FUNCTION private.assert_return_facts() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare v_order_id uuid := new.order_id; v_return commerce.returns; v_receipt commerce.return_receipts; v_items jsonb;
begin
  for v_return in select * from commerce.returns where order_id=v_order_id loop
    select jsonb_agg(jsonb_build_object('order_item_id',order_item_id,'quantity',quantity) order by order_item_id)
      into v_items from commerce.return_lines where return_id=v_return.id;
    if v_items is null or v_return.request_hash is distinct from private.command_request_hash(jsonb_build_object(
      'fulfillment_id',v_return.fulfillment_id,'items',v_items,'reason',v_return.reason)) then
      raise exception 'return lines do not match authorization fingerprint';
    end if;
    if v_return.status='cancelled' and exists (select 1 from commerce.return_receipts where return_id=v_return.id) then
      raise exception 'cancelled return has receipts';
    end if;
  end loop;
  if exists (
    select 1 from commerce.return_lines l join commerce.returns r on r.id=l.return_id
    join commerce.fulfillment_lines fl on (fl.fulfillment_id,fl.order_item_id)=(l.fulfillment_id,l.order_item_id)
    join public.fulfillments f on f.id=fl.fulfillment_id where l.order_id=v_order_id
    group by fl.fulfillment_id,fl.order_item_id,fl.quantity,f.status
    having sum(case when r.status='open' then l.quantity else private.return_line_received(l.id) end)
      > case when f.status in ('shipped','delivered') then fl.quantity else 0 end
  ) then raise exception 'return commitments exceed shipped quantity'; end if;
  if exists (select 1 from commerce.return_lines l where l.order_id=v_order_id and private.return_line_received(l.id)>l.quantity) then
    raise exception 'receipt quantity exceeds return authorization';
  end if;
  for v_receipt in select * from commerce.return_receipts where order_id=v_order_id loop
    select jsonb_agg(jsonb_build_object('return_line_id',return_line_id,'quantity',quantity) order by return_line_id)
      into v_items from commerce.return_receipt_lines where receipt_id=v_receipt.id;
    if v_items is null or v_receipt.request_hash is distinct from private.command_request_hash(jsonb_build_object(
      'return_id',v_receipt.return_id,'location_id',v_receipt.location_id,'items',v_items,'note',v_receipt.note)) then
      raise exception 'receipt lines do not match receipt fingerprint';
    end if;
  end loop;
  if exists (select 1 from commerce.return_receipt_lines l where l.order_id=v_order_id and
    (select coalesce(sum(quantity),0) from commerce.return_dispositions where receipt_line_id=l.id)>l.quantity) then
    raise exception 'disposition exceeds undisposed receipt quantity';
  end if;
  if exists (select 1 from commerce.return_dispositions d
    join commerce.return_receipt_lines rl on rl.id=d.receipt_line_id
    join commerce.return_lines l on l.id=rl.return_line_id join public.order_items oi on oi.id=l.order_item_id
    join commerce.return_receipts r on r.id=d.receipt_id left join public.inventory_movements im on im.id=d.inventory_movement_id
    where d.order_id=v_order_id and (
      d.request_hash is distinct from private.command_request_hash(jsonb_build_object('receipt_line_id',d.receipt_line_id,'quantity',d.quantity,'disposition',d.disposition,'note',d.note))
      or (d.disposition='restock' and (im.order_id,im.variant_id,im.location_id,im.delta,im.reason)
        is distinct from (d.order_id,oi.variant_id,r.location_id,d.quantity,'return'::text))
    )) then raise exception 'disposition does not match its fingerprint or stock movement'; end if;
  return null;
end;
$$;

CREATE FUNCTION private.return_fact_to_outbox() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare v_row jsonb := to_jsonb(new); v_type text;
begin
  v_type := case tg_table_name when 'returns' then 'return.' || (v_row ->> 'status')
    when 'return_receipts' then 'return.received' else 'return.disposed' end;
  insert into public.order_events(order_id,actor_id,type,data) values (
    (v_row ->> 'order_id')::uuid, case when tg_op='UPDATE' then auth.uid() else (v_row ->> 'actor_id')::uuid end,
    v_type,jsonb_build_object('resource_id',v_row -> 'id','return_id',case when tg_table_name='returns' then v_row -> 'id' else v_row -> 'return_id' end,
      'receipt_id',v_row -> 'receipt_id','disposition',v_row -> 'disposition','quantity',v_row -> 'quantity'));
  return new;
end;
$$;

CREATE FUNCTION public.create_return(fulfillment_id uuid, items jsonb, idempotency_key text, reason text DEFAULT NULL) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare v_order uuid; v_return commerce.returns; v_items jsonb; v_hash text; v_key text := btrim(idempotency_key);
begin
  select order_id into v_order from public.fulfillments where id=create_return.fulfillment_id;
  perform private.lock_return_command(v_order,v_key);
  v_items := private.canonical_return_quantities(items,'order_item_id');
  v_hash := private.command_request_hash(jsonb_build_object('fulfillment_id',fulfillment_id,'items',v_items,'reason',reason));
  select * into v_return from commerce.returns r where r.fulfillment_id=create_return.fulfillment_id and r.idempotency_key=v_key;
  if found then
    if v_return.request_hash<>v_hash then raise exception 'idempotency key was used with different return parameters'; end if;
    return private.return_json(v_return);
  end if;
  insert into commerce.returns(order_id,fulfillment_id,idempotency_key,request_hash,reason,actor_id)
    values (v_order,fulfillment_id,v_key,v_hash,reason,auth.uid()) returning * into v_return;
  insert into commerce.return_lines(return_id,order_id,fulfillment_id,order_item_id,quantity)
    select v_return.id,v_order,fulfillment_id,(e ->> 'order_item_id')::uuid,(e ->> 'quantity')::integer from jsonb_array_elements(v_items) e;
  return private.return_json(v_return);
end;
$$;

CREATE FUNCTION public.receive_return(return_id uuid, location_id uuid, items jsonb, idempotency_key text, note text DEFAULT NULL) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare v_order uuid; v_receipt commerce.return_receipts; v_items jsonb; v_hash text; v_key text := btrim(idempotency_key);
begin
  select order_id into v_order from commerce.returns where id=receive_return.return_id;
  perform private.lock_return_command(v_order,v_key);
  v_items := private.canonical_return_quantities(items,'return_line_id');
  v_hash := private.command_request_hash(jsonb_build_object('return_id',return_id,'location_id',location_id,'items',v_items,'note',note));
  select * into v_receipt from commerce.return_receipts r where r.return_id=receive_return.return_id and r.idempotency_key=v_key;
  if found then
    if v_receipt.request_hash<>v_hash then raise exception 'idempotency key was used with different receipt parameters'; end if;
    return private.return_receipt_json(v_receipt);
  end if;
  insert into commerce.return_receipts(return_id,order_id,location_id,idempotency_key,request_hash,note,actor_id)
    values (return_id,v_order,location_id,v_key,v_hash,note,auth.uid()) returning * into v_receipt;
  insert into commerce.return_receipt_lines(receipt_id,return_id,order_id,return_line_id,quantity)
    select v_receipt.id,return_id,v_order,(e ->> 'return_line_id')::uuid,(e ->> 'quantity')::integer from jsonb_array_elements(v_items) e;
  return private.return_receipt_json(v_receipt);
end;
$$;

CREATE FUNCTION public.dispose_return_receipt(receipt_line_id uuid, quantity integer, disposition text, idempotency_key text, note text DEFAULT NULL) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare v_line commerce.return_receipt_lines; v_disposition commerce.return_dispositions; v_key text := btrim(idempotency_key); v_hash text;
begin
  select * into v_line from commerce.return_receipt_lines where id=dispose_return_receipt.receipt_line_id;
  perform private.lock_return_command(v_line.order_id,v_key);
  v_hash := private.command_request_hash(jsonb_build_object('receipt_line_id',receipt_line_id,'quantity',quantity,'disposition',disposition,'note',note));
  select * into v_disposition from commerce.return_dispositions d where d.receipt_line_id=dispose_return_receipt.receipt_line_id and d.idempotency_key=v_key;
  if found then
    if v_disposition.request_hash<>v_hash then raise exception 'idempotency key was used with different disposition parameters'; end if;
    return private.return_disposition_json(v_disposition);
  end if;
  insert into commerce.return_dispositions(receipt_line_id,receipt_id,order_id,quantity,disposition,idempotency_key,request_hash,note,actor_id)
    values (receipt_line_id,v_line.receipt_id,v_line.order_id,quantity,disposition,v_key,v_hash,note,auth.uid()) returning * into v_disposition;
  return private.return_disposition_json(v_disposition);
end;
$$;

CREATE FUNCTION public.close_return(return_id uuid, cancel boolean DEFAULT false) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare v_return commerce.returns; v_order uuid; v_status text := case when cancel then 'cancelled' else 'closed' end;
begin
  select order_id into v_order from commerce.returns where id=close_return.return_id;
  perform private.lock_return_command(v_order,'return.close');
  if cancel is null then raise exception 'cancel must be a boolean'; end if;
  select * into strict v_return from commerce.returns where id=close_return.return_id;
  if v_return.status = v_status then return private.return_json(v_return); end if;
  update commerce.returns set status=v_status where id=v_return.id returning * into v_return;
  return private.return_json(v_return);
end;
$$;

CREATE FUNCTION public.get_order_returns(order_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
declare v_returns jsonb; v_lines jsonb;
begin
  if not exists (select 1 from public.orders o where o.id=get_order_returns.order_id
    and (o.customer_id=public.current_customer_id() or public.is_admin() or auth.role()='service_role')) then raise exception 'order not found'; end if;
  select coalesce(jsonb_agg(private.return_json(r) order by r.created_at,r.id),'[]') into v_returns
    from commerce.returns r where r.order_id=get_order_returns.order_id;
  select coalesce(jsonb_agg(jsonb_build_object('fulfillment_id',fl.fulfillment_id,'order_item_id',fl.order_item_id,
    'shipped_quantity',case when f.status in ('shipped','delivered') then fl.quantity else 0 end,
    'authorized_unreceived_quantity',b.authorized,'received_quantity',b.received,
    'available_quantity',case when f.status in ('shipped','delivered') then fl.quantity-b.authorized-b.received else 0 end)
    order by fl.fulfillment_id,fl.order_item_id),'[]') into v_lines
  from commerce.fulfillment_lines fl join public.fulfillments f on f.id=fl.fulfillment_id
  cross join lateral (select coalesce(sum(case when r.status='open' then l.quantity-private.return_line_received(l.id) else 0 end),0) as authorized,
    coalesce(sum(private.return_line_received(l.id)),0) as received from commerce.return_lines l join commerce.returns r on r.id=l.return_id
    where l.fulfillment_id=fl.fulfillment_id and l.order_item_id=fl.order_item_id) b
  where fl.order_id=get_order_returns.order_id;
  return jsonb_build_object('order_id',order_id,'lines',v_lines,'returns',v_returns);
end;
$$;

CREATE FUNCTION private.schedule_order_totals() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare
  v_row jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_id uuid := (v_row ->> case when tg_table_name = 'orders' then 'id' else 'order_id' end)::uuid;
begin
  insert into private.order_validation_queue(order_id) values (v_id) on conflict do nothing;
  return null;
end;
$$;

CREATE FUNCTION private.assert_order_totals() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare
  v_id uuid := new.order_id;
  v_order public.orders;
  v_subtotal numeric;
  v_discount numeric;
  v_count bigint;
begin
  -- Consume BEFORE checking. Subsequent writes (including after an explicit
  -- SET CONSTRAINTS flush) must enqueue a fresh check. Both queue and checks
  -- participate in subtransaction rollback; no non-transactional cache exists.
  delete from private.order_validation_queue where order_id = v_id;
  if not found then return null; end if;
  select * into v_order from public.orders where id = v_id for update;
  if not found then return null; end if;
  select count(*), coalesce(sum(total),0), coalesce(sum(discount_total),0)
  into v_count, v_subtotal, v_discount from public.order_items where order_id = v_id;
  if v_count = 0 or (v_subtotal, v_discount) is distinct from (v_order.subtotal, v_order.discount_total) then
    raise exception 'order line totals do not match header %', v_id;
  end if;
  perform private.assert_pricing_breakdown(private.order_pricing_json(v_id));
  if v_order.tax_context ->> 'status' <> 'unrecorded' and v_order.tax_context ->> 'destination_country'
     is distinct from v_order.shipping_address ->> 'country' then raise exception 'tax destination does not match order'; end if;
  return null;
end;
$$;

CREATE FUNCTION private.protect_order_pricing() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare
  v_row jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_order public.orders;
begin
  if tg_op = 'UPDATE' and to_jsonb(new) -> 'order_id' is distinct from to_jsonb(old) -> 'order_id' then
    raise exception 'pricing ownership is immutable';
  end if;
  select * into v_order from public.orders where id = (v_row ->> 'order_id')::uuid for update nowait;
  if not found then raise exception 'pricing order not found'; end if;
  if v_order.status <> 'open' or v_order.financial_status <> 'pending'
    or private.order_snapshot_has_payment_intent(v_order.id)
    or exists (select 1 from commerce.checkout_quotes where order_id = v_order.id and status = 'converted') then
    raise exception 'order pricing snapshot is immutable';
  end if;
  -- Serialize metadata-only detail edits against payment-intent snapshots too.
  update public.orders set updated_at = now() where id = v_order.id;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

CREATE FUNCTION private.allocate_refund_cancellation() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_refund commerce.refunds;
  v_request_id uuid;
  v_request_line commerce.refund_request_lines;
  v_available integer;
begin
  perform 1 from public.orders o where o.id = new.order_id for update nowait;
  update public.orders set updated_at = now() where id = new.order_id;
  select * into v_refund from commerce.refunds r where r.id = new.refund_id;
  if not found or v_refund.order_id <> new.order_id then raise exception 'refund not found for order'; end if;
  v_request_id := nullif(v_refund.metadata ->> 'refund_request_id', '')::uuid;
  select b.available_quantity into v_available
  from private.order_item_fulfillment_balance(new.order_item_id, new.quantity, v_request_id) b;
  if not found then raise exception 'refund order item not found'; end if;
  if v_request_id is not null then
    select * into v_request_line from commerce.refund_request_lines l
    where l.refund_request_id = v_request_id and l.order_item_id = new.order_item_id;
    if not found or (v_request_line.order_id, v_request_line.quantity, v_request_line.amount)
       is distinct from (new.order_id, new.quantity, new.amount) then
      raise exception 'refund line does not match its request';
    end if;
    new.cancelled_quantity := v_request_line.cancelled_quantity;
    if new.cancelled_quantity > v_available then
      raise exception 'reserved refund cancellation is no longer available';
    end if;
  else
    new.cancelled_quantity := least(new.quantity, v_available);
  end if;
  if new.restocked_quantity <> 0 then raise exception 'restocked quantity is derived from unshipped cancellation'; end if;
  new.restocked_quantity := case when v_refund.status = 'succeeded' and v_refund.restock_requested and exists (
    select 1 from public.inventory_movements im join public.order_items oi on oi.variant_id = im.variant_id
    where oi.id = new.order_item_id and im.order_id = new.order_id and im.reason = 'order' and im.delta < 0
  ) then new.cancelled_quantity else 0 end;
  if new.restocked_quantity > 0 and v_refund.payment_transaction_id is null then
    raise exception 'inventory release requires a successful refund payment';
  end if;
  return new;
end;
$$;

CREATE FUNCTION private.allocate_refund_request_cancellation() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_available integer;
begin
  -- Same order lock as fulfillment and both refund entry points.
  perform 1 from public.orders o where o.id = new.order_id for update;
  select b.available_quantity into v_available
  from private.order_item_fulfillment_balance(new.order_item_id) b;
  if not found then raise exception 'refund order item not found'; end if;
  new.cancelled_quantity := least(new.quantity, v_available);
  return new;
end;
$$;

CREATE FUNCTION private.assert_refund_lines_total() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_refund_id uuid := coalesce(new.refund_id, old.refund_id);
  v_order_item_id uuid := coalesce(new.order_item_id, old.order_item_id);
  v_refund_amount numeric(12, 2);
  v_line_amount numeric(12, 2);
  v_ordered_quantity integer;
  v_item_amount numeric(12, 2);
  v_refunded_quantity integer;
  v_refunded_item_amount numeric(12, 2);
begin
  select r.amount into v_refund_amount
  from commerce.refunds r where r.id = v_refund_id;
  select coalesce(sum(rl.amount), 0) into v_line_amount
  from commerce.refund_lines rl where rl.refund_id = v_refund_id;
  if v_line_amount > v_refund_amount then
    raise exception 'refund line amount % does not match refund amount %',
      v_line_amount, v_refund_amount;
  end if;

  select oi.quantity, oi.line_total into v_ordered_quantity, v_item_amount
  from public.order_items oi where oi.id = v_order_item_id;
  select coalesce(sum(rl.quantity), 0), coalesce(sum(rl.amount), 0)
  into v_refunded_quantity, v_refunded_item_amount
  from commerce.refund_lines rl where rl.order_item_id = v_order_item_id;
  if v_refunded_quantity > v_ordered_quantity
     or v_refunded_item_amount > v_item_amount then
    raise exception 'cumulative refund lines exceed order item %', v_order_item_id;
  end if;
  return coalesce(new, old);
end;
$$;

-- Generic JSON builders/aggregates are catalog-STABLE, but these UUID/integer-only
-- inputs are deterministic. Keep IMMUTABLE; the lint exception pins this SQL and
-- tests cover canonical output/hash across input permutations and session settings.
CREATE FUNCTION private.canonical_order_item_quantities(p_items jsonb) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO ''
    AS $_$
declare
  v_item jsonb;
  v_result jsonb;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'items must be a non-empty array';
  end if;
  for v_item in select value from jsonb_array_elements(p_items)
  loop
    if jsonb_typeof(v_item) <> 'object'
       or coalesce(v_item ->> 'order_item_id', '') = '' then
      raise exception 'each item requires order_item_id';
    end if;
    perform (v_item ->> 'order_item_id')::uuid;
    if coalesce(v_item ->> 'quantity', '') !~ '^[1-9][0-9]*$' then
      raise exception 'item quantity must be a positive integer';
    end if;
  end loop;
  select jsonb_agg(jsonb_build_object(
           'order_item_id', x.order_item_id, 'quantity', x.quantity)
           order by x.order_item_id)
  into v_result
  from (
    select (e.value ->> 'order_item_id')::uuid order_item_id,
           sum((e.value ->> 'quantity')::integer)::integer quantity
    from jsonb_array_elements(p_items) e
    group by (e.value ->> 'order_item_id')::uuid
  ) x;
  return v_result;
end;
$_$;

CREATE FUNCTION private.command_request_hash(p_request jsonb) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT
    SET search_path TO ''
    AS $$
  select pg_catalog.encode(extensions.digest(p_request::text, 'sha256'), 'hex');
$$;

CREATE FUNCTION private.create_fulfillment(order_id uuid, items jsonb, carrier text DEFAULT ''::text, tracking_number text DEFAULT ''::text, tracking_url text DEFAULT NULL::text) RETURNS public.fulfillments
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_order public.orders;
  v_fulfillment public.fulfillments;
  v_item jsonb;
  v_balance record;
  v_qty integer;
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  if items is null or jsonb_typeof(items) <> 'array' or jsonb_array_length(items) = 0 then
    raise exception 'items must be a non-empty array';
  end if;
  select * into v_order from public.orders o where o.id = create_fulfillment.order_id for update;
  if not found then raise exception 'order not found'; end if;
  if v_order.status <> 'open' then raise exception 'order is not open (current: %)', v_order.status; end if;
  if v_order.financial_status = 'refunded' then raise exception 'refunded order cannot be fulfilled'; end if;
  for v_item in select value from jsonb_array_elements(items)
  loop
    v_qty := coalesce((v_item ->> 'quantity')::integer, 0);
    if v_qty <= 0 then raise exception 'fulfillment quantity must be positive'; end if;
    if not exists (
      select 1 from public.order_items oi
      where oi.id = (v_item ->> 'order_item_id')::uuid and oi.order_id = v_order.id
    ) then
      raise exception 'order item % does not belong to this order', v_item ->> 'order_item_id';
    end if;
    select * into v_balance
    from private.order_item_fulfillment_balance((v_item ->> 'order_item_id')::uuid);
    if v_qty > v_balance.available_quantity then
      raise exception 'fulfillment quantity exceeds remaining (available %, requested %; refunded or reserved units excluded)',
        v_balance.available_quantity, v_qty;
    end if;
  end loop;
  insert into public.fulfillments
    (order_id, items, carrier, tracking_number, tracking_url, status, shipped_at)
  values (v_order.id, items, carrier, tracking_number, tracking_url, 'shipped', now())
  returning * into v_fulfillment;
  perform private.refresh_order_fulfillment(v_order.id);
  insert into public.order_events (order_id, actor_id, type, data)
  values (v_order.id, auth.uid(), 'fulfillment_created',
          jsonb_build_object('fulfillment_id', v_fulfillment.id, 'tracking_number', tracking_number));
  return v_fulfillment;
end;
$$;

CREATE FUNCTION private.enqueue_outbox_event(p_aggregate_type text, p_aggregate_id uuid, p_event_type text, p_payload jsonb, p_idempotency_key text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_event_id uuid;
begin
  insert into commerce.outbox_events
    (aggregate_type, aggregate_id, event_type, payload, idempotency_key)
  values (p_aggregate_type, p_aggregate_id, p_event_type,
          coalesce(p_payload, '{}'), p_idempotency_key)
  on conflict (idempotency_key) do update
    set idempotency_key = excluded.idempotency_key
  returning event_id into v_event_id;
  return v_event_id;
end;
$$;

CREATE FUNCTION private.fulfillment_json(p_fulfillment public.fulfillments) RETURNS jsonb
    LANGUAGE sql IMMUTABLE STRICT
    SET search_path TO ''
    AS $$
  select jsonb_build_object(
    'id', p_fulfillment.id, 'order_id', p_fulfillment.order_id,
    'status', p_fulfillment.status, 'carrier', p_fulfillment.carrier,
    'tracking_number', p_fulfillment.tracking_number,
    'tracking_url', p_fulfillment.tracking_url,
    'shipped_at', p_fulfillment.shipped_at,
    'delivered_at', p_fulfillment.delivered_at,
    'created_at', p_fulfillment.created_at
  );
$$;

CREATE FUNCTION private.order_event_to_outbox() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  perform private.enqueue_outbox_event(
    'order', new.order_id, new.type,
    new.data || jsonb_build_object('order_event_id', new.id, 'actor_id', new.actor_id),
    'order-event:' || new.id
  );
  return new;
end;
$$;

CREATE FUNCTION private.order_item_fulfillment_balance(p_order_item_id uuid, p_unrecorded_refund_quantity integer DEFAULT 0, p_exclude_request_id uuid DEFAULT NULL::uuid) RETURNS TABLE(ordered_quantity integer, fulfilled_quantity integer, cancelled_quantity integer, reserved_quantity integer, available_quantity integer)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  with facts as (
    select oi.quantity, oi.refunded_quantity,
           coalesce((
             select sum(fl.quantity) from commerce.fulfillment_lines fl
             join public.fulfillments f on f.id = fl.fulfillment_id
             where fl.order_item_id = oi.id and f.status <> 'cancelled'
           ), 0)::integer as fulfilled,
           coalesce((
             select sum(rl.quantity) from commerce.refund_lines rl
             join commerce.refunds r on r.id = rl.refund_id and r.status = 'succeeded'
             where rl.order_item_id = oi.id
           ), 0)::integer as ledger_refunded,
           coalesce((
             select sum(rl.cancelled_quantity) from commerce.refund_lines rl
             join commerce.refunds r on r.id = rl.refund_id and r.status = 'succeeded'
             where rl.order_item_id = oi.id
           ), 0)::integer as ledger_cancelled,
           coalesce((
             select sum(l.cancelled_quantity) from commerce.refund_request_lines l
             join commerce.refund_requests r on r.id = l.refund_request_id
             where l.order_item_id = oi.id
               and r.status in ('requested', 'submitted', 'processing')
               and (p_exclude_request_id is null or r.id <> p_exclude_request_id)
           ), 0)::integer as reserved
    from public.order_items oi where oi.id = p_order_item_id
  ), balanced as (
    select *, ledger_cancelled + least(
      -- Pre-ledger legacy refunds have no relational lines. Never use their
      -- ambiguous unshipped quantity as permission to ship refunded stock.
      greatest(refunded_quantity - ledger_refunded - p_unrecorded_refund_quantity, 0),
      greatest(quantity - fulfilled - ledger_cancelled, 0)
    ) as cancelled from facts
  )
  select quantity, fulfilled, cancelled, reserved,
         greatest(quantity - fulfilled - cancelled - reserved, 0)
  from balanced;
$$;

CREATE FUNCTION private.payment_intent_to_outbox() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if tg_op = 'INSERT' or new.status <> old.status then
    perform private.enqueue_outbox_event(
      'payment_intent', new.id, 'payment_intent.' || new.status,
      jsonb_build_object('payment_intent_id', new.id, 'order_id', new.order_id,
                         'provider', new.provider, 'status', new.status,
                         'amount', new.amount, 'currency', new.currency),
      'payment-intent:' || new.id || ':status:' || new.status
    );
  end if;
  return new;
end;
$$;

CREATE FUNCTION private.payment_transaction_to_outbox() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if tg_op = 'INSERT' or new.status <> old.status then
    perform private.enqueue_outbox_event(
      'payment_transaction', new.id, 'payment_transaction.' || new.status,
      jsonb_build_object('transaction_id', new.id, 'order_id', new.order_id,
                         'payment_intent_id', new.payment_intent_id,
                         'provider', new.provider, 'kind', new.kind,
                         'status', new.status, 'amount', new.amount,
                         'currency', new.currency),
      'payment-transaction:' || new.id || ':status:' || new.status
    );
  end if;
  return new;
end;
$$;

CREATE FUNCTION private.prevent_refunded_fulfillment_cancellation() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if new.status <> 'cancelled' or old.status = 'cancelled' then return new; end if;
  perform 1 from public.orders o where o.id = old.order_id for update nowait;
  if exists (select 1 from commerce.returns r where r.fulfillment_id=old.id and
    (r.status='open' or exists (select 1 from commerce.return_receipts where return_id=r.id))) then
    raise exception 'fulfillment has return authorizations or receipts; cannot cancel';
  end if;
  if exists (
    select 1 from commerce.fulfillment_lines fl
    join public.order_items oi on oi.id = fl.order_item_id
    where fl.fulfillment_id = old.id and (
      oi.refunded_quantity > 0 or exists (
        select 1 from commerce.refund_request_lines l
        join commerce.refund_requests r on r.id = l.refund_request_id
        where l.order_item_id = oi.id
          and r.status in ('requested', 'submitted', 'processing')
      )
    )
  ) then
    raise exception 'fulfillment has refunded items or active refund requests; use the return flow';
  end if;
  return new;
end;
$$;

CREATE FUNCTION private.protect_audit_row() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception '% is append-only', tg_table_name;
  end if;

  -- GDPR 只允许把 actor_id 单向匿名化；流水的业务事实永远不可改写。
  if old.actor_id is null
     or new.actor_id is not null
     or (to_jsonb(new) - 'actor_id') is distinct from (to_jsonb(old) - 'actor_id') then
    raise exception '% is append-only', tg_table_name;
  end if;
  return new;
end;
$$;

CREATE FUNCTION private.protect_fulfillment_record() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception 'fulfillments are append-only';
  end if;
  if (new.order_id, new.items, new.created_at)
     is distinct from (old.order_id, old.items, old.created_at) then
    raise exception 'fulfillment commercial fields are immutable';
  end if;
  if new.status <> old.status then
    perform 1 from public.orders where id=old.order_id for update nowait;
    update public.orders set updated_at=now() where id=old.order_id;
  end if;
  if new.status <> old.status and not (
    (old.status = 'pending' and new.status in ('shipped', 'cancelled'))
    or (old.status = 'shipped' and new.status in ('delivered', 'cancelled'))
  ) then
    raise exception 'invalid fulfillment transition: % -> %', old.status, new.status;
  end if;
  if new.status = 'shipped' and new.shipped_at is null then
    new.shipped_at := now();
  end if;
  if new.status = 'delivered' and new.delivered_at is null then
    new.delivered_at := now();
  end if;
  return new;
end;
$$;

CREATE FUNCTION private.protect_immutable_row() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  raise exception '% is immutable', tg_table_name;
end;
$$;

CREATE FUNCTION private.protect_order_item_snapshot() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_status text;
  v_financial_status text;
  v_order_id uuid := coalesce(new.order_id, old.order_id);
begin
  select o.status, o.financial_status into v_status, v_financial_status
  from public.orders o where o.id = v_order_id;
  if not found or (v_status = 'open' and v_financial_status = 'pending') then
    return coalesce(new, old);
  end if;
  if tg_op <> 'UPDATE' then
    raise exception 'locked order items are immutable';
  end if;
  -- Generated line_total / line_key are not yet recomputed in BEFORE NEW;
  -- their source fields (including attributes) remain protected.
  if coalesce(current_setting('commerce.refund_write', true), 'off') <> 'on'
     or (to_jsonb(new) - array['refunded_quantity', 'refunded_amount', 'line_total', 'line_key'])
        is distinct from
        (to_jsonb(old) - array['refunded_quantity', 'refunded_amount', 'line_total', 'line_key'])
     or new.refunded_quantity < old.refunded_quantity
     or new.refunded_amount < old.refunded_amount then
    raise exception 'locked order item snapshot is immutable';
  end if;
  return new;
end;
$$;

CREATE FUNCTION private.protect_outbox_event() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception 'outbox events cannot be deleted';
  end if;
  if (new.event_id, new.aggregate_type, new.aggregate_id, new.event_type,
      new.payload, new.idempotency_key, new.created_at)
     is distinct from
     (old.event_id, old.aggregate_type, old.aggregate_id, old.event_type,
      old.payload, old.idempotency_key, old.created_at) then
    raise exception 'outbox event payload is immutable';
  end if;
  if new.attempts < old.attempts then
    raise exception 'outbox attempts cannot decrease';
  end if;
  if to_jsonb(new) = to_jsonb(old) then return new; end if;
  if old.status = 'published' and to_jsonb(new) is distinct from to_jsonb(old) then
    raise exception 'published outbox events are immutable';
  end if;
  if new.status <> old.status and not (
    (old.status in ('pending', 'failed') and new.status = 'processing')
    or (old.status = 'processing' and new.status in ('published', 'failed'))
  ) then
    raise exception 'invalid outbox transition: % -> %', old.status, new.status;
  end if;
  if new.status = 'processing' then
    if new.locked_at is null or coalesce(new.locked_by, '') = ''
       or new.lease_token is null or new.lease_token is not distinct from old.lease_token
       or new.lease_expires_at is null or new.lease_expires_at <= new.locked_at
       or new.attempts <> old.attempts + 1 then
      raise exception 'processing outbox event requires a new lease attempt';
    end if;
  elsif new.locked_at is not null or new.locked_by is not null
        or new.lease_token is not null or new.lease_expires_at is not null then
    raise exception 'non-processing outbox event cannot retain a lease';
  end if;
  if new.status = 'published' and new.published_at is null then
    raise exception 'published outbox event requires published_at';
  end if;
  return new;
end;
$$;

CREATE FUNCTION private.protect_paid_order_snapshot() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if (old.financial_status <> 'pending' or new.financial_status <> 'pending')
     and (new.customer_id, new.email, new.currency, new.subtotal,
          new.discount_total, new.shipping_total, new.tax_total, new.total,
          new.shipping_address, new.billing_address, new.shipping_method_id,
          new.shipping_method_name, new.discount_code, new.customer_note,
          new.created_at, new.tax_context)
         is distinct from
         (old.customer_id, old.email, old.currency, old.subtotal,
          old.discount_total, old.shipping_total, old.tax_total, old.total,
          old.shipping_address, old.billing_address, old.shipping_method_id,
          old.shipping_method_name, old.discount_code, old.customer_note,
          old.created_at, old.tax_context) then
    raise exception 'paid order commercial snapshot is immutable';
  end if;
  return new;
end;
$$;

CREATE FUNCTION private.recalculate_order_fulfillment() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if new.status = old.status then return new; end if;
  perform private.refresh_order_fulfillment(new.order_id);
  insert into public.order_events (order_id, actor_id, type, data)
  values (new.order_id, auth.uid(),
          case when new.status = 'cancelled' then 'fulfillment_cancelled' else 'fulfillment_' || new.status end,
          jsonb_build_object('fulfillment_id', new.id, 'before', old.status, 'after', new.status));
  return new;
end;
$$;

CREATE FUNCTION private.refresh_fulfillment_after_refund() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  perform private.refresh_order_fulfillment(new.order_id);
  return new;
end;
$$;

CREATE FUNCTION private.refresh_order_fulfillment(p_order_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_all boolean;
  v_any boolean;
  v_order public.orders;
  v_fulfillment_status text;
  v_status text;
  v_completed_at timestamptz;
begin
  select * into v_order from public.orders o where o.id = p_order_id for update;
  if not found then return; end if;
  select coalesce(bool_and(b.ordered_quantity - b.cancelled_quantity <= b.fulfilled_quantity), false),
         coalesce(bool_or(b.fulfilled_quantity > 0), false)
  into v_all, v_any
  from public.order_items oi
  cross join lateral private.order_item_fulfillment_balance(oi.id) b
  where oi.order_id = p_order_id;
  -- An entirely cancelled order has no physical fulfillment.
  v_all := v_all and v_any;
  v_fulfillment_status := case when v_all then 'fulfilled'
                               when v_any then 'partially_fulfilled' else 'unfulfilled' end;
  v_status := v_order.status;
  v_completed_at := v_order.completed_at;
  if v_order.status <> 'cancelled' and v_all
     and v_order.financial_status in ('paid', 'partially_refunded') then
    v_status := 'completed';
    v_completed_at := coalesce(v_completed_at, now());
  elsif not v_all and v_order.financial_status in ('paid', 'partially_refunded') then
    if v_status = 'completed' then v_status := 'open'; end if;
    v_completed_at := null;
  end if;
  -- Multi-line/deferred calls should not repeatedly rewrite an unchanged order.
  update public.orders o
  set fulfillment_status = v_fulfillment_status, status = v_status, completed_at = v_completed_at
  where o.id = p_order_id and (o.fulfillment_status, o.status, o.completed_at)
    is distinct from (v_fulfillment_status, v_status, v_completed_at);
end;
$$;

CREATE FUNCTION private.proportional_refund(p_amount numeric, p_units numeric, p_take numeric, p_used_units numeric, p_used_amount numeric) RETURNS numeric
    LANGUAGE plpgsql IMMUTABLE SET search_path TO '' AS $$
begin
  if p_take <= 0 or p_units <= 0 or p_used_units + p_take > p_units or p_used_amount > p_amount then
    raise exception 'refund exceeds component balance';
  end if;
  return case when p_used_units + p_take = p_units then p_amount - p_used_amount
    else least(round(p_amount * p_take / p_units, 2), p_amount - p_used_amount) end;
end;
$$;

CREATE FUNCTION private.refund_component_used(p_kind text, p_tax_id uuid, p_shipping_id uuid, p_exclude_request uuid DEFAULT NULL, p_exclude_refund uuid DEFAULT NULL) RETURNS numeric
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $$
  select coalesce(sum(amount), 0) from (
    select c.amount from commerce.refund_components c join commerce.refunds r on r.id = c.refund_id
    where r.status = 'succeeded' and c.kind = p_kind and r.id is distinct from p_exclude_refund
      and (c.tax_line_id = p_tax_id or c.shipping_line_id = p_shipping_id)
    union all select c.amount from commerce.refund_request_components c join commerce.refund_requests r on r.id = c.refund_request_id
    where r.status in ('requested','submitted','processing') and c.kind = p_kind and r.id is distinct from p_exclude_request
      and (c.tax_line_id = p_tax_id or c.shipping_line_id = p_shipping_id)
  ) x;
$$;

CREATE FUNCTION private.item_refund_tax(p_tax_id uuid, p_quantity integer, p_exclude_request uuid DEFAULT NULL, p_exclude_refund uuid DEFAULT NULL, p_unrecorded_quantity integer DEFAULT 0) RETURNS numeric
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $$
  select private.proportional_refund(t.amount, i.quantity, p_quantity,
    i.refunded_quantity - p_unrecorded_quantity + (select coalesce(sum(l.quantity), 0)
      from commerce.refund_request_lines l join commerce.refund_requests r on r.id = l.refund_request_id
      where l.order_item_id = i.id and r.status in ('requested','submitted','processing') and r.id is distinct from p_exclude_request),
    private.refund_component_used('tax', t.id, null, p_exclude_request, p_exclude_refund))
  from commerce.order_tax_lines t join public.order_items i on i.id = t.order_item_id where t.id = p_tax_id;
$$;

CREATE FUNCTION private.plan_refund(p_order_id uuid, p_items jsonb, p_amount numeric, p_shipping_amount numeric, p_available numeric) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare
  v_items jsonb;
  v_line public.order_items;
  v_shipping commerce.order_shipping_lines;
  v_item jsonb;
  v_tax commerce.order_tax_lines;
  v_lines jsonb := '[]'::jsonb;
  v_components jsonb := '[]'::jsonb;
  v_source text;
  v_quantity integer;
  v_used_quantity integer;
  v_used numeric;
  v_amount numeric := 0;
  v_line_amount numeric;
  v_tax_amount numeric;
begin
  if p_amount is not null and (p_items is not null or p_shipping_amount is not null) then
    raise exception 'pass either items/shipping_amount or amount, not both';
  end if;
  if p_amount is not null and (p_amount NOT BETWEEN 0.01 AND 9999999999.99 OR p_amount <> round(p_amount, 2))
     or p_shipping_amount is not null and (p_shipping_amount NOT BETWEEN 0.01 AND 9999999999.99 OR p_shipping_amount <> round(p_shipping_amount, 2)) then
    raise exception 'refund amount must be finite positive USD with at most two decimal places';
  end if;
  if p_items is not null then
    v_source := 'items'; v_items := private.canonical_order_item_quantities(p_items);
    if jsonb_array_length(v_items) > 100 then raise exception 'refund request is limited to 100 lines'; end if;
    for v_item in select value from jsonb_array_elements(v_items) loop
      v_quantity := (v_item ->> 'quantity')::integer;
      select * into v_line from public.order_items where id = (v_item ->> 'order_item_id')::uuid and order_id = p_order_id for update;
      if not found then raise exception 'order item % does not belong to this order', v_item ->> 'order_item_id'; end if;
      select coalesce(sum(l.quantity),0), coalesce(sum(l.amount),0) into v_used_quantity, v_used
        from commerce.refund_request_lines l join commerce.refund_requests r on r.id = l.refund_request_id
        where l.order_item_id = v_line.id and r.status in ('requested','submitted','processing');
      if v_line.refunded_quantity + v_used_quantity + v_quantity > v_line.quantity then
        raise exception 'refund quantity exceeds available request balance for item %', v_line.id;
      end if;
      v_line_amount := private.proportional_refund(v_line.line_total, v_line.quantity, v_quantity,
        v_line.refunded_quantity + v_used_quantity, v_line.refunded_amount + v_used);
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('order_item_id', v_line.id, 'quantity', v_quantity, 'amount', v_line_amount));
      v_amount := v_amount + v_line_amount;
      for v_tax in select * from commerce.order_tax_lines where order_item_id = v_line.id order by id loop
        v_amount := v_amount + private.item_refund_tax(v_tax.id, v_quantity);
      end loop;
    end loop;
  end if;
  if p_shipping_amount is not null then
    v_source := coalesce(v_source, 'shipping');
    select * into v_shipping from commerce.order_shipping_lines where order_id = p_order_id;
    if not found then raise exception 'order has no refundable shipping line'; end if;
    v_used := private.refund_component_used('shipping', null, v_shipping.id);
    if p_shipping_amount > v_shipping.total - v_used then raise exception 'shipping refund exceeds component balance'; end if;
    v_components := v_components || jsonb_build_array(jsonb_build_object('kind', 'shipping', 'shipping_line_id', v_shipping.id, 'amount', p_shipping_amount));
    v_amount := v_amount + p_shipping_amount;
    for v_tax in select * from commerce.order_tax_lines where shipping_line_id = v_shipping.id order by id loop
      v_tax_amount := private.proportional_refund(v_tax.amount, v_shipping.total, p_shipping_amount, v_used,
        private.refund_component_used('tax', v_tax.id, null));
      if v_tax_amount > 0 then
        v_components := v_components || jsonb_build_array(jsonb_build_object('kind', 'tax', 'tax_line_id', v_tax.id, 'amount', v_tax_amount));
        v_amount := v_amount + v_tax_amount;
      end if;
    end loop;
  end if;
  if v_source is null then
    v_source := case when p_amount is null then 'remaining' else 'custom_amount' end;
    v_amount := coalesce(p_amount, p_available);
    v_components := jsonb_build_array(jsonb_build_object('kind', 'unallocated', 'amount', v_amount));
  end if;
  if v_amount <= 0 or v_amount > p_available then raise exception 'refund amount % exceeds available refundable balance %', v_amount, p_available; end if;
  return jsonb_build_object('source', v_source, 'amount', v_amount, 'lines', v_lines, 'components', v_components);
end;
$$;

CREATE FUNCTION private.validate_refund_component() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare
  v_request boolean := tg_table_name = 'refund_request_components';
  v_id uuid := (to_jsonb(new) ->> case when v_request then 'refund_request_id' else 'refund_id' end)::uuid;
  v_request_id uuid;
  v_header jsonb;
  v_tax commerce.order_tax_lines;
  v_shipping commerce.order_shipping_lines;
  v_limit numeric;
  v_used numeric;
  v_expected numeric;
  v_quantity integer;
  v_shipping_amount numeric;
begin
  perform 1 from public.orders where id = new.order_id for update nowait;
  if v_request then
    select to_jsonb(r) into v_header from commerce.refund_requests r where id = v_id and order_id = new.order_id;
    if v_header ->> 'status' is distinct from 'requested' then raise exception 'component requires a requested refund'; end if;
    v_request_id := v_id;
  else
    select to_jsonb(r) into v_header from commerce.refunds r where id = v_id and order_id = new.order_id;
    if v_header is null then raise exception 'refund component has no header'; end if;
    v_request_id := (v_header -> 'metadata' ->> 'refund_request_id')::uuid;
  end if;
  if new.kind = 'unallocated' then
    if v_header ->> 'source' not in ('custom_amount','remaining','legacy') then raise exception 'item/shipping refunds cannot be unallocated'; end if;
  elsif new.kind = 'shipping' then
    select * into strict v_shipping from commerce.order_shipping_lines where id = new.shipping_line_id and order_id = new.order_id;
    v_limit := v_shipping.total;
  else
    select * into strict v_tax from commerce.order_tax_lines where id = new.tax_line_id and order_id = new.order_id;
    v_limit := v_tax.amount;
  end if;
  v_used := private.refund_component_used(new.kind, new.tax_line_id, new.shipping_line_id, v_request_id, case when not v_request then v_id end);
  if v_limit is not null and new.amount > v_limit - v_used then raise exception 'refund component exceeds refundable balance'; end if;
  if not v_request and v_request_id is not null then
    if not exists (select 1 from commerce.refund_request_components c
      where c.refund_request_id = v_request_id and c.order_id = new.order_id and c.kind = new.kind
        and c.tax_line_id is not distinct from new.tax_line_id and c.shipping_line_id is not distinct from new.shipping_line_id
        and c.amount = new.amount) then raise exception 'refund component does not match request'; end if;
  elsif new.kind = 'tax' then
    if v_tax.order_item_id is not null then
      if v_request then select quantity into v_quantity from commerce.refund_request_lines where refund_request_id = v_id and order_item_id = v_tax.order_item_id;
      else select quantity into v_quantity from commerce.refund_lines where refund_id = v_id and order_item_id = v_tax.order_item_id; end if;
      if v_quantity is null then raise exception 'item tax refund requires a quantity line'; end if;
      v_expected := private.item_refund_tax(v_tax.id, v_quantity, v_request_id, case when not v_request then v_id end,
        case when v_request then 0 else v_quantity end);
    else
      select * into strict v_shipping from commerce.order_shipping_lines where id = v_tax.shipping_line_id;
      if v_request then select amount into v_shipping_amount from commerce.refund_request_components where refund_request_id = v_id and shipping_line_id = v_shipping.id;
      else select amount into v_shipping_amount from commerce.refund_components where refund_id = v_id and shipping_line_id = v_shipping.id; end if;
      if v_shipping_amount is null then raise exception 'shipping tax refund requires a shipping component'; end if;
      v_expected := private.proportional_refund(v_tax.amount, v_shipping.total, v_shipping_amount,
        private.refund_component_used('shipping', null, v_shipping.id, v_request_id, case when not v_request then v_id end), v_used);
    end if;
    if new.amount is distinct from v_expected then raise exception 'tax refund does not match proportional allocation'; end if;
  end if;
  return new;
end;
$$;

CREATE FUNCTION private.refund_components_json(p_id uuid, p_request boolean) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $$
  select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'tax_line_id', tax_line_id,
    'shipping_line_id', shipping_line_id, 'amount', amount) order by kind, tax_line_id, shipping_line_id), '[]') from (
    select kind, tax_line_id, shipping_line_id, amount from commerce.refund_components where not p_request and refund_id = p_id
    union all select kind, tax_line_id, shipping_line_id, amount from commerce.refund_request_components where p_request and refund_request_id = p_id
  ) c;
$$;

CREATE FUNCTION private.assert_refund_composition() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare
  v_row jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_request boolean := tg_table_name like 'refund_request%';
  v_id uuid;
  v_header jsonb;
  v_components jsonb;
  v_lines integer;
  v_amount numeric;
  v_extra numeric;
  v_request_id uuid;
begin
  v_id := (v_row ->> case when tg_table_name in ('refunds','refund_requests') then 'id'
    when v_request then 'refund_request_id' else 'refund_id' end)::uuid;
  if v_request then
    select to_jsonb(r) into v_header from commerce.refund_requests r where id = v_id;
    select count(*), coalesce(sum(amount), 0) into v_lines, v_amount from commerce.refund_request_lines where refund_request_id = v_id;
  else
    select to_jsonb(r) into v_header from commerce.refunds r where id = v_id;
    select count(*), coalesce(sum(amount), 0) into v_lines, v_amount from commerce.refund_lines where refund_id = v_id;
  end if;
  if v_header is null then return null; end if;
  v_components := private.refund_components_json(v_id, v_request);
  select coalesce(sum((e ->> 'amount')::numeric), 0) into v_extra from jsonb_array_elements(v_components) e;
  if v_amount + v_extra is distinct from (v_header ->> 'amount')::numeric
    or (v_header ->> 'source' = 'items') is distinct from (v_lines > 0) then
    raise exception 'refund components do not match header';
  end if;
  if v_header ->> 'source' in ('custom_amount','remaining','legacy') and exists (
    select 1 from jsonb_array_elements(v_components) e where e ->> 'kind' <> 'unallocated'
  ) then raise exception 'unallocated refund cannot guess tax or shipping'; end if;
  if v_header ->> 'source' = 'shipping' and not exists (
    select 1 from jsonb_array_elements(v_components) e where e ->> 'kind' = 'shipping'
  ) then raise exception 'shipping refund requires a shipping component'; end if;
  if not v_request then
    v_request_id := (v_header -> 'metadata' ->> 'refund_request_id')::uuid;
    if v_request_id is not null and v_components is distinct from private.refund_components_json(v_request_id, true) then
      raise exception 'completed refund composition does not match request';
    end if;
  end if;
  return null;
end;
$$;

CREATE FUNCTION private.refund_line_taxes() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare
  v_row jsonb := to_jsonb(new);
  v_request boolean := tg_table_name = 'refund_request_lines';
  v_id uuid := (v_row ->> case when v_request then 'refund_request_id' else 'refund_id' end)::uuid;
  v_request_id uuid;
  v_tax_id uuid;
  v_amount numeric;
begin
  if v_request then v_request_id := v_id;
  else select (metadata ->> 'refund_request_id')::uuid into v_request_id from commerce.refunds where id = v_id; end if;
  for v_tax_id in select id from commerce.order_tax_lines where order_item_id = new.order_item_id order by id loop
    if not v_request and v_request_id is not null then
      select amount into v_amount from commerce.refund_request_components
      where refund_request_id = v_request_id and tax_line_id = v_tax_id;
      v_amount := coalesce(v_amount, 0);
    else
      v_amount := private.item_refund_tax(v_tax_id, new.quantity, v_request_id,
        case when not v_request then v_id end, case when v_request then 0 else new.quantity end);
    end if;
    if v_amount > 0 then
      if v_request then
        insert into commerce.refund_request_components(refund_request_id, order_id, kind, tax_line_id, amount)
        values (v_id, new.order_id, 'tax', v_tax_id, v_amount);
      else
        insert into commerce.refund_components(refund_id, order_id, kind, tax_line_id, amount)
        values (v_id, new.order_id, 'tax', v_tax_id, v_amount);
      end if;
    end if;
  end loop;
  return new;
end;
$$;

CREATE FUNCTION private.refund_order(order_id uuid, items jsonb DEFAULT NULL::jsonb, amount numeric DEFAULT NULL::numeric, reason text DEFAULT NULL::text, restock boolean DEFAULT false, provider text DEFAULT 'manual'::text, shipping_amount numeric DEFAULT NULL) RETURNS public.orders
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_order public.orders;
  v_refunded numeric(12, 2);
  v_refundable numeric(12, 2);
  v_amount numeric(12, 2) := 0;
  v_item jsonb;
  v_line record;
  v_qty integer;
  v_line_refund numeric(12, 2);
  v_plan jsonb;
  v_component jsonb;
  v_parent_id uuid;
  v_transaction_id uuid;
  v_refund_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin only';
  end if;
  if restock and items is null then raise exception 'restock requires item-based refund lines'; end if;
  select * into v_order from public.orders where id = refund_order.order_id for update;
  if not found then
    raise exception 'order not found';
  end if;
  if v_order.financial_status not in ('paid', 'partially_refunded') then
    raise exception 'order is not refundable (current: %)', v_order.financial_status;
  end if;

  if restock then perform private.lock_order_inventory(array[v_order.id]); end if;

  -- 已退合计（以成功的 refund 支付记录为准）
  select coalesce(sum(p.amount), 0) into v_refunded
  from commerce.payment_transactions p
  where p.order_id = v_order.id and p.kind = 'refund' and p.status = 'succeeded';
  v_refundable := least(v_order.total, (select coalesce(sum(p.amount), 0) from commerce.payment_transactions p
    where p.order_id = v_order.id and p.kind = 'capture' and p.status = 'succeeded')) - v_refunded;
  if v_refundable <= 0 then
    raise exception 'order already fully refunded';
  end if;

  if exists (select 1 from commerce.refund_requests r where r.order_id = v_order.id and r.status in ('requested','submitted','processing')) then
    raise exception 'order has an active asynchronous refund request';
  end if;
  v_plan := private.plan_refund(v_order.id, items, amount, shipping_amount, v_refundable);
  v_amount := (v_plan ->> 'amount')::numeric;
  perform set_config('commerce.refund_write', 'on', true);
  for v_item in select value from jsonb_array_elements(v_plan -> 'lines') loop
      v_qty := (v_item ->> 'quantity')::integer;
      select oi.* into v_line from public.order_items oi
      where oi.id = (v_item ->> 'order_item_id')::uuid
        and oi.order_id = v_order.id
      for update of oi;
      if not found then
        raise exception 'order item % does not belong to this order', v_item ->> 'order_item_id';
      end if;
      v_line_refund := (v_item ->> 'amount')::numeric;

      update public.order_items oi
      set refunded_quantity = oi.refunded_quantity + v_qty,
          refunded_amount = oi.refunded_amount + v_line_refund
      where oi.id = v_line.id;

  end loop;

  select t.id into v_parent_id from commerce.payment_transactions t
  where t.order_id = v_order.id and t.kind = 'capture' and t.status = 'succeeded'
  order by t.created_at, t.id limit 1;
  insert into commerce.payment_transactions (order_id, parent_transaction_id, provider, kind, status, amount, currency)
  values (v_order.id, v_parent_id, provider, 'refund', 'succeeded', v_amount, v_order.currency) returning id into v_transaction_id;
  insert into commerce.refunds(order_id, payment_transaction_id, status, source, amount, currency, reason, restock_requested, actor_id)
  values (v_order.id, v_transaction_id, 'succeeded', v_plan ->> 'source', v_amount, v_order.currency, reason, restock, auth.uid())
  returning id into v_refund_id;
  for v_item in select value from jsonb_array_elements(v_plan -> 'lines') loop
    insert into commerce.refund_lines(refund_id, order_id, order_item_id, quantity, amount)
    values (v_refund_id, v_order.id, (v_item ->> 'order_item_id')::uuid, (v_item ->> 'quantity')::integer,
      (v_item ->> 'amount')::numeric);
  end loop;
  for v_component in select value from jsonb_array_elements(v_plan -> 'components') loop
    insert into commerce.refund_components(refund_id, order_id, kind, tax_line_id, shipping_line_id, amount)
    values (v_refund_id, v_order.id, v_component ->> 'kind', (v_component ->> 'tax_line_id')::uuid,
      (v_component ->> 'shipping_line_id')::uuid, (v_component ->> 'amount')::numeric);
  end loop;
  perform set_config('commerce.refund_write', 'off', true);

  update public.orders
  set financial_status = case
        when v_refunded + v_amount >= v_order.total then 'refunded'
        else 'partially_refunded' end
  where id = v_order.id
  returning * into v_order;

  insert into public.order_events (order_id, actor_id, type, data)
  values (v_order.id, auth.uid(), 'refund_created',
          jsonb_build_object('amount', v_amount, 'reason', reason,
                             'restock', restock, 'items', items));

  return v_order;
end;
$$;

CREATE FUNCTION private.refund_request_to_outbox() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if tg_op = 'INSERT' or new.status <> old.status then
    perform private.enqueue_outbox_event(
      'refund_request', new.id, 'refund_request.' || new.status,
      jsonb_build_object(
        'refund_request_id', new.id, 'order_id', new.order_id,
        'provider', new.provider, 'status', new.status,
        'amount', new.amount, 'currency', new.currency,
        'provider_reference', new.provider_reference,
        'result_refund_id', new.result_refund_id
      ),
      'refund-request:' || new.id || ':status:' || new.status
    );
  end if;
  return new;
end;
$$;

CREATE FUNCTION private.refund_to_outbox() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  perform private.enqueue_outbox_event(
    'refund', new.id, 'refund.' || new.status,
    jsonb_build_object('refund_id', new.id, 'order_id', new.order_id,
                       'payment_transaction_id', new.payment_transaction_id,
                       'status', new.status, 'amount', new.amount,
                       'currency', new.currency, 'source', new.source),
    'refund:' || new.id || ':status:' || new.status
  );
  return new;
end;
$$;

CREATE FUNCTION private.sync_fulfillment_lines() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if jsonb_typeof(new.items) <> 'array' or jsonb_array_length(new.items) = 0 then
    raise exception 'fulfillment items must be a non-empty array';
  end if;
  insert into commerce.fulfillment_lines
    (fulfillment_id, order_id, order_item_id, quantity, created_at)
  select new.id, new.order_id, (e.value ->> 'order_item_id')::uuid,
         sum((e.value ->> 'quantity')::integer)::integer, new.created_at
  from jsonb_array_elements(new.items) e
  group by (e.value ->> 'order_item_id')::uuid;
  return new;
end;
$$;

CREATE FUNCTION private.sync_order_adjustments() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_adjustment_total numeric(12, 2);
  v_change_id text := gen_random_uuid()::text;
begin
  if tg_op = 'INSERT' then
    if new.discount_total > 0 then
      insert into commerce.order_adjustments
        (order_id, kind, amount, currency, label, source_ref, idempotency_key, actor_id)
      values (new.id, 'discount', -new.discount_total, new.currency, 'Discount',
              'discount_total', 'order:' || new.id || ':initial:discount', auth.uid());
    end if;
    if new.shipping_total > 0 then
      insert into commerce.order_adjustments
        (order_id, kind, amount, currency, label, source_ref, idempotency_key, actor_id)
      values (new.id, 'shipping', new.shipping_total, new.currency, 'Shipping',
              'shipping_total', 'order:' || new.id || ':initial:shipping', auth.uid());
    end if;
    if new.tax_total > 0 then
      insert into commerce.order_adjustments
        (order_id, kind, amount, currency, label, source_ref, idempotency_key, actor_id)
      values (new.id, 'tax', new.tax_total, new.currency, 'Tax',
              'tax_total', 'order:' || new.id || ':initial:tax', auth.uid());
    end if;
  else
    if new.currency <> old.currency then
      raise exception 'order currency is immutable once adjustments exist';
    end if;
    if new.discount_total <> old.discount_total then
      insert into commerce.order_adjustments
        (order_id, kind, amount, currency, label, source_ref, idempotency_key, metadata, actor_id)
      values (new.id, 'discount', old.discount_total - new.discount_total, new.currency,
              'Discount change', 'discount_total',
              'order:' || new.id || ':change:' || v_change_id || ':discount',
              jsonb_build_object('before', old.discount_total, 'after', new.discount_total), auth.uid());
    end if;
    if new.shipping_total <> old.shipping_total then
      insert into commerce.order_adjustments
        (order_id, kind, amount, currency, label, source_ref, idempotency_key, metadata, actor_id)
      values (new.id, 'shipping', new.shipping_total - old.shipping_total, new.currency,
              'Shipping change', 'shipping_total',
              'order:' || new.id || ':change:' || v_change_id || ':shipping',
              jsonb_build_object('before', old.shipping_total, 'after', new.shipping_total), auth.uid());
    end if;
    if new.tax_total <> old.tax_total then
      insert into commerce.order_adjustments
        (order_id, kind, amount, currency, label, source_ref, idempotency_key, metadata, actor_id)
      values (new.id, 'tax', new.tax_total - old.tax_total, new.currency,
              'Tax change', 'tax_total',
              'order:' || new.id || ':change:' || v_change_id || ':tax',
              jsonb_build_object('before', old.tax_total, 'after', new.tax_total), auth.uid());
    end if;
  end if;

  select coalesce(sum(a.amount), 0) into v_adjustment_total
  from commerce.order_adjustments a where a.order_id = new.id;
  if round(new.subtotal + v_adjustment_total, 2) <> new.total then
    raise exception 'order adjustment ledger is unbalanced (subtotal %, adjustments %, total %)',
      new.subtotal, v_adjustment_total, new.total;
  end if;
  return new;
end;
$$;

CREATE FUNCTION private.validate_fulfillment_line() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_order public.orders;
  v_balance record;
  v_status text;
begin
  select * into v_order from public.orders o where o.id = new.order_id for update nowait;
  if not found then raise exception 'order not found'; end if;
  -- Every inserted fact fences old RR snapshots, even if the projected order
  -- status remains partially_fulfilled. Covers RPC and trusted direct INSERT.
  update public.orders set updated_at = now() where id = new.order_id;
  select * into v_balance from private.order_item_fulfillment_balance(new.order_item_id);
  if not found or not exists (
    select 1 from public.order_items oi where oi.id = new.order_item_id and oi.order_id = new.order_id
  ) then
    raise exception 'fulfillment line order item does not belong to its order';
  end if;
  select f.status into v_status from public.fulfillments f where f.id = new.fulfillment_id;
  if v_status <> 'cancelled' then
    if v_order.status <> 'open' or v_order.financial_status = 'refunded' then
      raise exception 'order is not fulfillable';
    end if;
    if new.quantity > v_balance.available_quantity then
      raise exception 'fulfillment quantity exceeds remaining (available %, requested %; refunded or reserved units excluded)',
        v_balance.available_quantity, new.quantity;
    end if;
  end if;
  return new;
end;
$$;

CREATE FUNCTION private.validate_order_financial_status() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_captured numeric(12, 2);
  v_refunded numeric(12, 2);
begin
  if new.financial_status = old.financial_status then
    return new;
  end if;
  select coalesce(sum(t.amount) filter (
           where t.kind = 'capture' and t.status = 'succeeded'), 0),
         coalesce(sum(t.amount) filter (
           where t.kind = 'refund' and t.status = 'succeeded'), 0)
  into v_captured, v_refunded
  from commerce.payment_transactions t where t.order_id = new.id;

  if old.financial_status = 'pending' and new.financial_status = 'paid' then
    if new.total > 0 and v_captured < new.total then
      raise exception 'order cannot be marked paid without sufficient captured funds';
    end if;
  elsif old.financial_status in ('paid', 'partially_refunded')
        and new.financial_status in ('partially_refunded', 'refunded') then
    if v_refunded <= 0 then
      raise exception 'order refund status does not match payment transactions';
    end if;
    if v_refunded > v_captured then
      raise exception 'refund amount exceeds captured amount (refunded %, captured %)',
        v_refunded, v_captured;
    end if;
    if new.financial_status = 'refunded' and v_refunded < new.total then
      raise exception 'order cannot be fully refunded before its total is refunded';
    end if;
    if new.financial_status = 'partially_refunded' and v_refunded >= new.total then
      raise exception 'fully refunded order cannot remain partially_refunded';
    end if;
  else
    raise exception 'invalid order financial transition: % -> %',
      old.financial_status, new.financial_status;
  end if;
  return new;
end;
$$;

CREATE FUNCTION private.validate_payment_transaction() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_intent commerce.payment_intents;
  v_parent commerce.payment_transactions;
  v_order_total numeric(12, 2);
  v_order_currency text;
  v_captured numeric(12, 2);
  v_refunded numeric(12, 2);
begin
  new.provider := lower(btrim(new.provider));
  new.currency := upper(btrim(new.currency));
  if new.idempotency_key is not null then
    new.idempotency_key := btrim(new.idempotency_key);
  end if;

  select o.total, o.currency into v_order_total, v_order_currency
  from public.orders o where o.id = new.order_id for update;
  if not found or v_order_currency <> new.currency then
    raise exception 'payment transaction does not match its order';
  end if;

  if new.payment_intent_id is not null then
    select * into v_intent from commerce.payment_intents i where i.id = new.payment_intent_id;
    if not found
       or (v_intent.order_id, v_intent.provider, v_intent.currency)
          is distinct from (new.order_id, new.provider, new.currency)
       or (new.kind in ('authorization', 'capture') and new.amount > v_intent.amount) then
      raise exception 'payment transaction does not match its intent';
    end if;
  end if;
  if new.parent_transaction_id is not null then
    select * into v_parent from commerce.payment_transactions t
    where t.id = new.parent_transaction_id;
    if not found or v_parent.order_id <> new.order_id then
      raise exception 'payment transaction parent belongs to another order';
    end if;
    if (new.kind = 'refund' and (v_parent.kind <> 'capture' or v_parent.status <> 'succeeded'))
       or (new.kind = 'capture' and v_parent.kind <> 'authorization')
       or (new.kind = 'void' and v_parent.kind not in ('authorization', 'capture'))
       or new.kind = 'authorization' then
      raise exception 'invalid parent transaction for %', new.kind;
    end if;
  end if;

  if tg_op = 'UPDATE' then
    if (new.order_id, new.payment_intent_id, new.parent_transaction_id,
        new.provider, new.kind, new.amount,
        new.currency, new.idempotency_key, new.created_at)
       is distinct from
       (old.order_id, old.payment_intent_id, old.parent_transaction_id,
        old.provider, old.kind, old.amount,
        old.currency, old.idempotency_key, old.created_at) then
      raise exception 'payment transaction commercial fields are immutable';
    end if;
    if old.provider_reference is not null
       and new.provider_reference is distinct from old.provider_reference then
      raise exception 'payment transaction provider reference is immutable';
    end if;
    if new.status <> old.status and not (
      old.status = 'pending' and new.status in ('succeeded', 'failed', 'cancelled')
    ) then
      raise exception 'invalid payment transaction transition: % -> %', old.status, new.status;
    end if;
    new.updated_at := now();
  end if;

  if new.status = 'succeeded'
     and (tg_op = 'INSERT' or old.status <> 'succeeded') then
    select coalesce(sum(t.amount) filter (
             where t.kind = 'capture' and t.status = 'succeeded'), 0),
           coalesce(sum(t.amount) filter (
             where t.kind = 'refund' and t.status = 'succeeded'), 0)
    into v_captured, v_refunded
    from commerce.payment_transactions t where t.order_id = new.order_id;
    if new.kind = 'capture' and v_captured + new.amount > v_order_total then
      raise exception 'captured amount exceeds order total (captured %, requested %, total %)',
        v_captured, new.amount, v_order_total;
    end if;
    if new.kind = 'refund' and v_refunded + new.amount > v_captured then
      raise exception 'refund amount exceeds captured amount (refunded %, requested %, captured %)',
        v_refunded, new.amount, v_captured;
    end if;
  end if;

  if new.status = 'succeeded' and new.processed_at is null then
    new.processed_at := now();
  end if;
  return new;
end;
$$;

CREATE FUNCTION private.validate_refund_header() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_transaction commerce.payment_transactions;
begin
  if new.payment_transaction_id is not null then
    select * into v_transaction from commerce.payment_transactions t
    where t.id = new.payment_transaction_id;
    if not found
       or v_transaction.order_id <> new.order_id
       or v_transaction.kind <> 'refund'
       or (v_transaction.amount, v_transaction.currency, v_transaction.status)
          is distinct from (new.amount, new.currency, new.status) then
      raise exception 'refund header does not match its payment transaction';
    end if;
  end if;
  return new;
end;
$$;

CREATE FUNCTION public.claim_outbox_events(worker_id text, max_events integer DEFAULT 50, lease_seconds integer DEFAULT 300) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_result jsonb;
begin
  if worker_id is null or length(btrim(worker_id)) = 0 or length(worker_id) > 200 then
    raise exception 'worker_id is required and must be at most 200 characters';
  end if;
  if max_events is null or max_events not between 1 and 100 then
    raise exception 'max_events must be between 1 and 100';
  end if;
  if lease_seconds is null or lease_seconds not between 30 and 3600 then
    raise exception 'lease_seconds must be between 30 and 3600';
  end if;

  with candidates as (
    select e.id
    from commerce.outbox_events e
    where e.attempts < 25 and (
      (e.status in ('pending', 'failed') and e.available_at <= clock_timestamp())
      or (e.status = 'processing' and e.lease_expires_at <= clock_timestamp())
    )
    order by e.id
    for update skip locked
    limit max_events
  ), claimed as (
    update commerce.outbox_events e
    set status = 'processing', attempts = e.attempts + 1,
        locked_at = clock_timestamp(), locked_by = btrim(worker_id), last_error = null,
        lease_token = gen_random_uuid(), lease_expires_at = clock_timestamp() + make_interval(secs => lease_seconds)
    from candidates c
    where e.id = c.id
    returning e.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'event_id', c.event_id,
           'aggregate_type', c.aggregate_type,
           'aggregate_id', c.aggregate_id,
           'event_type', c.event_type,
           'payload', c.payload,
           'attempt', c.attempts,
           'lease_token', c.lease_token, 'lease_expires_at', c.lease_expires_at,
           'created_at', c.created_at
         ) order by c.id), '[]'::jsonb)
  into v_result
  from claimed c;
  return v_result;
end;
$$;

CREATE FUNCTION public.complete_outbox_event(event_id uuid, worker_id text, lease_token uuid, succeeded boolean, error_message text DEFAULT NULL::text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if succeeded is null then
    raise exception 'succeeded is required';
  end if;
  update commerce.outbox_events e
  set status = case when succeeded then 'published' else 'failed' end,
      published_at = case when succeeded then now() else null end,
      available_at = case when succeeded then e.available_at
                          else now() + make_interval(
                            secs => least(3600, power(2, least(e.attempts, 10))::integer)
                          ) end,
      last_error = case when succeeded then null else left(error_message, 4000) end,
      locked_at = null, locked_by = null, lease_token = null, lease_expires_at = null
  where e.event_id = complete_outbox_event.event_id
    and e.status = 'processing'
    and e.locked_by = btrim(complete_outbox_event.worker_id)
    and e.lease_token = complete_outbox_event.lease_token
    and e.lease_expires_at > clock_timestamp();
  return found;
end;
$$;

CREATE FUNCTION public.create_fulfillment(order_id uuid, items jsonb, idempotency_key text, carrier text DEFAULT ''::text, tracking_number text DEFAULT ''::text, tracking_url text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_subject_id constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  v_key text := btrim(idempotency_key);
  v_items jsonb;
  v_request_hash text;
  v_response jsonb;
  v_record commerce.command_idempotency;
  v_fulfillment public.fulfillments;
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  if coalesce(v_key, '') = '' or length(v_key) > 200 then
    raise exception 'idempotency_key is required and must be at most 200 characters';
  end if;
  v_items := private.canonical_order_item_quantities(items);
  v_request_hash := private.command_request_hash(jsonb_build_object(
    'order_id', order_id, 'items', v_items, 'carrier', carrier,
    'tracking_number', tracking_number, 'tracking_url', tracking_url
  ));

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'fulfillment.create:' || v_subject_id || ':' || v_key, 0));
  select * into v_record from commerce.command_idempotency c
  where c.scope = 'fulfillment.create' and c.subject_id = v_subject_id
    and c.idempotency_key = v_key;
  if found then
    if v_record.request_hash <> v_request_hash then
      raise exception 'idempotency key was used with different fulfillment parameters';
    end if;
    select * into v_fulfillment from public.fulfillments f
    where f.id = v_record.resource_id and f.order_id = create_fulfillment.order_id;
    if not found then raise exception 'idempotency record points to a missing fulfillment'; end if;
    return private.fulfillment_json(v_fulfillment);
  end if;

  v_fulfillment := private.create_fulfillment(
    order_id, v_items, carrier, tracking_number, tracking_url
  );
  v_response := private.fulfillment_json(v_fulfillment);
  insert into commerce.command_idempotency
    (scope, subject_id, idempotency_key, request_hash, resource_type, resource_id)
  values ('fulfillment.create', v_subject_id, v_key, v_request_hash,
          'fulfillment', v_fulfillment.id);
  return v_response;
end;
$$;

CREATE FUNCTION public.get_order_fulfillment_balance(order_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_order public.orders;
  v_fulfillable boolean;
  v_has_quantity boolean;
  v_lines jsonb;
begin
  select * into v_order from public.orders o
  where o.id = get_order_fulfillment_balance.order_id and (
    o.customer_id = public.current_customer_id() or public.is_admin() or auth.role() = 'service_role'
  );
  if not found then raise exception 'order not found'; end if;
  v_fulfillable := v_order.status = 'open' and v_order.financial_status <> 'refunded'
    and not exists (
      select 1 from commerce.checkout_quotes q where q.order_id = v_order.id
        and q.status = 'converted' and v_order.financial_status = 'pending'
    );
  select coalesce(jsonb_agg(jsonb_build_object(
    'order_item_id', oi.id, 'ordered_quantity', b.ordered_quantity,
    'fulfilled_quantity', b.fulfilled_quantity, 'cancelled_quantity', b.cancelled_quantity,
    'reserved_quantity', b.reserved_quantity,
    'available_quantity', case when v_fulfillable then b.available_quantity else 0 end
  ) order by oi.id), '[]'::jsonb), coalesce(bool_or(b.available_quantity > 0), false)
  into v_lines, v_has_quantity
  from public.order_items oi
  cross join lateral private.order_item_fulfillment_balance(oi.id) b
  where oi.order_id = v_order.id;
  return jsonb_build_object('order_id', v_order.id,
                           'is_fulfillable', v_fulfillable and v_has_quantity, 'lines', v_lines);
end;
$$;

CREATE FUNCTION public.get_order_ledger(order_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_order public.orders;
  v_adjustment_total numeric(12, 2);
  v_captured numeric(12, 2);
  v_refunded numeric(12, 2);
begin
  select * into v_order
  from public.orders o
  where o.id = get_order_ledger.order_id
    and (
      o.customer_id = public.current_customer_id()
      or public.is_admin()
      or coalesce(auth.role(), '') = 'service_role'
    );
  if not found then raise exception 'order not found'; end if;

  select coalesce(sum(a.amount), 0) into v_adjustment_total
  from commerce.order_adjustments a where a.order_id = v_order.id;
  select coalesce(sum(t.amount), 0) into v_captured
  from commerce.payment_transactions t
  where t.order_id = v_order.id and t.kind = 'capture' and t.status = 'succeeded';
  select coalesce(sum(t.amount), 0) into v_refunded
  from commerce.payment_transactions t
  where t.order_id = v_order.id and t.kind = 'refund' and t.status = 'succeeded';

  return jsonb_build_object(
    'order', jsonb_build_object(
      'id', v_order.id, 'order_number', v_order.order_number,
      'status', v_order.status, 'financial_status', v_order.financial_status,
      'fulfillment_status', v_order.fulfillment_status,
      'currency', v_order.currency, 'subtotal', v_order.subtotal,
      'total', v_order.total, 'created_at', v_order.created_at
    ),
    'balances', jsonb_build_object(
      'adjustment_total', v_adjustment_total,
      'captured', v_captured, 'refunded', v_refunded,
      'net_paid', v_captured - v_refunded,
      'is_balanced', round(v_order.subtotal + v_adjustment_total, 2) = v_order.total
        and exists (select 1 from public.order_items oi where oi.order_id = v_order.id)
        and (v_order.subtotal, v_order.discount_total) = (
          select sum(oi.total), sum(oi.discount_total) from public.order_items oi where oi.order_id = v_order.id)
        and v_order.tax_total = (select coalesce(sum(t.amount), 0) from commerce.order_tax_lines t where t.order_id = v_order.id)
        and v_order.shipping_total = (select coalesce(sum(s.total), 0) from commerce.order_shipping_lines s where s.order_id = v_order.id)
        and not exists (select 1 from commerce.refunds r where r.order_id = v_order.id and r.amount <>
          (select coalesce(sum(l.amount), 0) from commerce.refund_lines l where l.refund_id = r.id)
          + (select coalesce(sum(c.amount), 0) from commerce.refund_components c where c.refund_id = r.id))
    ),
    'adjustments', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', a.id, 'order_item_id', a.order_item_id, 'kind', a.kind,
        'amount', a.amount, 'currency', a.currency, 'label', a.label,
        'source_type', a.source_type, 'source_ref', a.source_ref,
        'created_at', a.created_at
      ) order by a.id), '[]'::jsonb)
      from commerce.order_adjustments a where a.order_id = v_order.id
    ),
    'payment_intents', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', i.id, 'provider', i.provider, 'status', i.status,
        'amount', i.amount, 'currency', i.currency,
        'provider_reference', i.provider_reference,
        'created_at', i.created_at, 'updated_at', i.updated_at
      ) order by i.created_at, i.id), '[]'::jsonb)
      from commerce.payment_intents i where i.order_id = v_order.id
    ),
    'transactions', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', t.id, 'payment_intent_id', t.payment_intent_id,
        'parent_transaction_id', t.parent_transaction_id,
        'provider', t.provider, 'kind', t.kind, 'status', t.status,
        'amount', t.amount, 'currency', t.currency,
        'provider_reference', t.provider_reference,
        'processed_at', t.processed_at, 'created_at', t.created_at
      ) order by t.created_at, t.id), '[]'::jsonb)
      from commerce.payment_transactions t where t.order_id = v_order.id
    ),
    'refunds', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', r.id, 'payment_transaction_id', r.payment_transaction_id,
        'status', r.status, 'source', r.source, 'amount', r.amount,
        'currency', r.currency, 'reason', r.reason,
        'restock_requested', r.restock_requested,
        'components', private.refund_components_json(r.id, false),
        'created_at', r.created_at,
        'lines', (select coalesce(jsonb_agg(jsonb_build_object(
          'order_item_id', rl.order_item_id, 'quantity', rl.quantity,
          'amount', rl.amount, 'cancelled_quantity', rl.cancelled_quantity, 'restocked_quantity', rl.restocked_quantity
        ) order by rl.order_item_id), '[]'::jsonb)
        from commerce.refund_lines rl where rl.refund_id = r.id)
      ) order by r.created_at, r.id), '[]'::jsonb)
      from commerce.refunds r where r.order_id = v_order.id
    ),
    'fulfillments', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', f.id, 'status', f.status, 'carrier', f.carrier,
        'tracking_number', f.tracking_number, 'tracking_url', f.tracking_url,
        'shipped_at', f.shipped_at, 'delivered_at', f.delivered_at,
        'created_at', f.created_at,
        'lines', (select coalesce(jsonb_agg(jsonb_build_object(
          'order_item_id', fl.order_item_id, 'quantity', fl.quantity
        ) order by fl.order_item_id), '[]'::jsonb)
        from commerce.fulfillment_lines fl where fl.fulfillment_id = f.id)
      ) order by f.created_at, f.id), '[]'::jsonb)
      from public.fulfillments f where f.order_id = v_order.id
    )
  );
end;
$$;

CREATE FUNCTION public.refund_order(order_id uuid, idempotency_key text, items jsonb DEFAULT NULL::jsonb, amount numeric DEFAULT NULL::numeric, reason text DEFAULT NULL::text, restock boolean DEFAULT false, provider text DEFAULT 'manual'::text, shipping_amount numeric DEFAULT NULL) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_subject_id constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  v_key text := btrim(idempotency_key);
  v_items jsonb := items;
  v_provider text := lower(btrim(provider));
  v_request_hash text;
  v_response jsonb;
  v_record commerce.command_idempotency;
  v_before_refunds uuid[];
  v_refund_id uuid;
  v_order public.orders;
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  if coalesce(v_key, '') = '' or length(v_key) > 200 then
    raise exception 'idempotency_key is required and must be at most 200 characters';
  end if;
  if items is not null then
    v_items := private.canonical_order_item_quantities(items);
  end if;
  v_request_hash := private.command_request_hash(jsonb_build_object(
    'order_id', order_id, 'items', v_items, 'amount', amount,
    'reason', reason, 'restock', restock, 'provider', v_provider, 'shipping_amount', shipping_amount
  ));

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'order.refund:' || v_subject_id || ':' || v_key, 0));
  select * into v_record from commerce.command_idempotency c
  where c.scope = 'order.refund' and c.subject_id = v_subject_id
    and c.idempotency_key = v_key;
  if found then
    if v_record.request_hash <> v_request_hash then
      raise exception 'idempotency key was used with different refund parameters';
    end if;
    select o.* into v_order
    from commerce.refunds r join public.orders o on o.id = r.order_id
    where r.id = v_record.resource_id and r.order_id = refund_order.order_id;
    if not found then raise exception 'idempotency record points to a missing refund'; end if;
    return private.storefront_order_json(v_order);
  end if;

  select coalesce(array_agg(r.id), '{}'::uuid[]) into v_before_refunds
  from commerce.refunds r where r.order_id = refund_order.order_id;
  v_order := private.refund_order(
    order_id, v_items, amount, reason, restock, v_provider, shipping_amount
  );
  perform private.refresh_order_fulfillment(v_order.id);
  select * into v_order from public.orders o where o.id = refund_order.order_id;
  v_response := private.storefront_order_json(v_order);
  select r.id into v_refund_id from commerce.refunds r
  where r.order_id = refund_order.order_id
    and not (r.id = any(v_before_refunds))
  order by r.created_at desc, r.id desc limit 1;
  if not found then raise exception 'refund ledger was not recorded'; end if;

  insert into commerce.command_idempotency
    (scope, subject_id, idempotency_key, request_hash, resource_type, resource_id)
  values ('order.refund', v_subject_id, v_key, v_request_hash,
          'refund', v_refund_id);
  return v_response;
end;
$$;

-- Read contracts are independent of the legacy table API and never return
-- provider credentials/references or internal notes to customer callers.
CREATE FUNCTION private.order_detail_json(p_order public.orders, p_admin boolean) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $$
  select private.storefront_order_json(p_order)
    || jsonb_build_object('pricing',private.order_pricing_json(p_order.id),
      'fulfillments',coalesce((select jsonb_agg(private.fulfillment_json(f) || jsonb_build_object(
        'lines',coalesce((select jsonb_agg(jsonb_build_object('order_item_id',l.order_item_id,'quantity',l.quantity)
          order by l.order_item_id) from commerce.fulfillment_lines l where l.fulfillment_id = f.id),'[]'::jsonb))
        order by f.created_at,f.id) from public.fulfillments f where f.order_id = p_order.id),'[]'::jsonb))
    || case when p_admin then jsonb_build_object('admin_note',p_order.admin_note) else '{}'::jsonb end;
$$;

CREATE FUNCTION public.get_customer_order(order_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
declare v_customer uuid := public.current_customer_id();
begin
  if v_customer is null then raise exception using errcode = '42501', message = 'active customer required'; end if;
  return (select private.order_detail_json(o,false) from public.orders o
    where o.id = order_id and o.customer_id = v_customer);
end;
$$;

CREATE FUNCTION public.get_admin_order(order_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'admin only';
  end if;
  return (select private.order_detail_json(o,true) from public.orders o where o.id = order_id);
end;
$$;

CREATE FUNCTION private.list_orders(p_customer_id uuid, p_page_size integer, p_after_order_number bigint,
    p_status text, p_financial_status text, p_fulfillment_status text, p_admin boolean) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
declare v_items jsonb; v_next bigint;
begin
  if p_page_size is null or p_page_size not between 1 and 100
    or (p_status is not null and p_status not in ('open','completed','cancelled'))
    or (p_financial_status is not null and p_financial_status not in ('pending','paid','partially_refunded','refunded','voided'))
    or (p_fulfillment_status is not null and p_fulfillment_status not in ('unfulfilled','partially_fulfilled','fulfilled')) then
    raise exception using errcode = '22023', message = 'invalid order list filter or page_size';
  end if;
  with candidates as materialized (
    select o.id,o.order_number,o.customer_id,o.email,o.status,o.financial_status,o.fulfillment_status,o.currency,o.total,o.created_at
    from public.orders o where (p_customer_id is null or o.customer_id = p_customer_id)
      and (p_after_order_number is null or o.order_number < p_after_order_number)
      and (p_status is null or o.status = p_status)
      and (p_financial_status is null or o.financial_status = p_financial_status)
      and (p_fulfillment_status is null or o.fulfillment_status = p_fulfillment_status)
    order by o.order_number desc limit p_page_size + 1
  ), page as materialized (select * from candidates order by order_number desc limit p_page_size)
  select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'order_number',p.order_number,'status',p.status,
    'financial_status',p.financial_status,'fulfillment_status',p.fulfillment_status,'currency',p.currency,
    'total',p.total,'created_at',p.created_at)
    || case when p_admin then jsonb_build_object('customer_id',p.customer_id,'email',p.email) else '{}'::jsonb end
    order by p.order_number desc),'[]'::jsonb),
    case when (select count(*) from candidates) > p_page_size then (select min(order_number) from page) end
  into v_items,v_next from page p;
  return jsonb_build_object('items',v_items,'next_cursor',v_next);
end;
$$;

CREATE FUNCTION public.list_customer_orders(page_size integer DEFAULT 20, after_order_number bigint DEFAULT NULL,
    status_filter text DEFAULT NULL, financial_status_filter text DEFAULT NULL, fulfillment_status_filter text DEFAULT NULL) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
declare v_customer uuid := public.current_customer_id();
begin
  if v_customer is null then raise exception using errcode = '42501', message = 'active customer required'; end if;
  return private.list_orders(v_customer,page_size,after_order_number,status_filter,financial_status_filter,fulfillment_status_filter,false);
end;
$$;

CREATE FUNCTION public.list_admin_orders(page_size integer DEFAULT 20, after_order_number bigint DEFAULT NULL,
    customer_id uuid DEFAULT NULL, status_filter text DEFAULT NULL, financial_status_filter text DEFAULT NULL,
    fulfillment_status_filter text DEFAULT NULL) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'admin only';
  end if;
  return private.list_orders(customer_id,page_size,after_order_number,status_filter,financial_status_filter,fulfillment_status_filter,true);
end;
$$;

commit;
