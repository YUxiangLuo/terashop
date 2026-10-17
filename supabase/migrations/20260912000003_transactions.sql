-- Transaction ledgers, fulfillment, refunds, immutable snapshots and Outbox
-- Cross-domain function references are resolved after all definitions are installed.
begin;
set local check_function_bodies = false;

-- Every restock/cancel command uses the same inventory lock order as checkout.
CREATE FUNCTION private.lock_order_inventory(p_order_ids uuid[]) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare v_stock record;
begin
  for v_stock in
    select im.variant_id, im.location_id from public.inventory_movements im
    where im.order_id = any(p_order_ids) and im.reason = 'order' and im.delta < 0
    group by im.variant_id, im.location_id order by im.variant_id, im.location_id
  loop
    insert into public.inventory_levels (variant_id, location_id, on_hand)
    values (v_stock.variant_id, v_stock.location_id, 0)
    on conflict on constraint inventory_levels_pkey do nothing;
    perform 1 from public.inventory_levels il
    where il.variant_id = v_stock.variant_id and il.location_id = v_stock.location_id for update;
  end loop;
end;
$$;

-- Recover only an actual deduction, at the locations it was consumed from.
-- 'cancel' releases unshipped units; 'restock' puts shipped units back on hand.
CREATE FUNCTION private.recover_order_stock(p_order_id uuid, p_variant_id uuid, p_quantity integer,
    p_reason text, p_actor_id uuid, p_note text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare v_deducted bigint; v_recovered bigint; v_source record; v_take integer; v_left integer := p_quantity;
  v_on_hand integer;
begin
  if p_quantity is null or p_quantity <= 0 then raise exception 'stock recovery requires a positive quantity'; end if;
  if p_reason is null or p_reason not in ('cancel','restock') then raise exception 'invalid stock recovery reason'; end if;
  perform 1 from public.orders where id = p_order_id for update nowait;
  select coalesce(sum(-delta::bigint),0) into v_deducted from public.inventory_movements
    where order_id = p_order_id and variant_id = p_variant_id and reason = 'order' and delta < 0;
  select coalesce(sum(delta::bigint),0) into v_recovered from public.inventory_movements
    where order_id = p_order_id and variant_id = p_variant_id and reason in ('cancel','restock') and delta > 0;
  if p_quantity > v_deducted - v_recovered then raise exception 'stock recovery exceeds original deduction'; end if;
  perform private.lock_order_inventory(array[p_order_id]);
  for v_source in
    select im.location_id, sum(-im.delta::bigint) as quantity
    from public.inventory_movements im where im.order_id = p_order_id and im.variant_id = p_variant_id
      and im.reason = 'order' and im.delta < 0
    group by im.location_id order by im.location_id
  loop
    select coalesce(sum(delta::bigint),0) into v_recovered from public.inventory_movements
      where order_id = p_order_id and variant_id = p_variant_id and location_id = v_source.location_id
        and reason in ('cancel','restock') and delta > 0;
    v_take := least(v_left, greatest(v_source.quantity - v_recovered, 0));
    if v_take > 0 then
      update public.inventory_levels set on_hand = on_hand + v_take
        where variant_id = p_variant_id and location_id = v_source.location_id returning on_hand into v_on_hand;
      insert into public.inventory_movements(variant_id, location_id, delta, on_hand_after, reason, order_id, actor_id, note)
        values (p_variant_id, v_source.location_id, v_take, v_on_hand, p_reason, p_order_id, p_actor_id, p_note);
      v_left := v_left - v_take;
    end if;
    exit when v_left = 0;
  end loop;
  if v_left <> 0 then raise exception 'stock recovery could not be allocated'; end if;
end;
$$;

-- Shipped units come back only through an explicit per-line refund quantity.
-- The cap is shipped units minus units already restocked or reserved by active
-- provider refund requests; the order row lock serializes every refund writer.
CREATE FUNCTION private.assert_shipped_restock(p_order_item_id uuid, p_quantity integer, p_exclude_request_id uuid DEFAULT NULL) RETURNS void
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
declare v_item public.order_items; v_shipped bigint; v_used bigint;
begin
  if p_quantity = 0 then return; end if;
  select * into strict v_item from public.order_items where id = p_order_item_id;
  if not exists (select 1 from public.inventory_movements im where im.order_id = v_item.order_id
    and im.variant_id = v_item.variant_id and im.reason = 'order' and im.delta < 0) then
    raise exception 'restock_shipped_quantity requires an inventory-tracked order item';
  end if;
  select coalesce(sum(fl.quantity),0) into v_shipped from commerce.fulfillment_lines fl
    join public.fulfillments f on f.id = fl.fulfillment_id
    where fl.order_item_id = p_order_item_id and f.status in ('shipped','delivered');
  select coalesce(sum(rl.restock_shipped_quantity),0) + coalesce((
      select sum(l.restock_shipped_quantity) from commerce.refund_request_lines l
      join commerce.refund_requests r on r.id = l.refund_request_id
      where l.order_item_id = p_order_item_id and r.status in ('requested','submitted','processing')
        and r.id is distinct from p_exclude_request_id), 0)
    into v_used from commerce.refund_lines rl where rl.order_item_id = p_order_item_id;
  if v_used + p_quantity > v_shipped then
    raise exception 'restock_shipped_quantity exceeds shipped units not yet restocked for item %', p_order_item_id;
  end if;
end;
$$;

CREATE FUNCTION private.restock_refund_line() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare v_refund commerce.refunds; v_variant uuid;
begin
  if new.restocked_quantity = 0 and new.restock_shipped_quantity = 0 then return new; end if;
  select * into strict v_refund from commerce.refunds where id = new.refund_id;
  select variant_id into v_variant from public.order_items where id = new.order_item_id;
  if new.restocked_quantity > 0 then
    perform private.recover_order_stock(new.order_id, v_variant, new.restocked_quantity, 'cancel', v_refund.actor_id, v_refund.reason);
  end if;
  if new.restock_shipped_quantity > 0 then
    perform private.recover_order_stock(new.order_id, v_variant, new.restock_shipped_quantity, 'restock', v_refund.actor_id, v_refund.reason);
  end if;
  return new;
end;
$$;

-- Refund items extend order-item quantities with an optional count of shipped
-- units the customer sent back and the store puts back on hand.
CREATE FUNCTION private.canonical_refund_items(p_items jsonb) RETURNS jsonb
    LANGUAGE plpgsql STABLE SET search_path TO '' AS $$
declare v_items jsonb;
begin
  v_items := private.canonical_order_item_quantities(p_items);
  if exists (select 1 from jsonb_array_elements(p_items) e, jsonb_object_keys(e) k
    where k not in ('order_item_id','quantity','restock_shipped_quantity')) then
    raise exception 'unsupported refund item field';
  end if;
  if exists (select 1 from jsonb_array_elements(p_items) e where e ? 'restock_shipped_quantity'
    and coalesce(e ->> 'restock_shipped_quantity', '') !~ '^[0-9]{1,9}$') then
    raise exception 'restock_shipped_quantity must be a non-negative integer';
  end if;
  select jsonb_agg(c.value || jsonb_build_object('restock_shipped_quantity', coalesce((
      select sum((e ->> 'restock_shipped_quantity')::integer) from jsonb_array_elements(p_items) e
      where (e ->> 'order_item_id')::uuid = (c.value ->> 'order_item_id')::uuid), 0)) order by c.ordinality)
    into v_items from jsonb_array_elements(v_items) with ordinality c;
  if exists (select 1 from jsonb_array_elements(v_items) e
    where (e ->> 'restock_shipped_quantity')::bigint > (e ->> 'quantity')::bigint) then
    raise exception 'restock_shipped_quantity cannot exceed refunded quantity';
  end if;
  return v_items;
end;
$$;

CREATE FUNCTION private.order_has_payment_hold(p_order_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $$
  select exists (select 1 from commerce.provider_money_movements
    where order_id=p_order_id and reconciliation_status='action_required');
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
    if not found or (v_request_line.order_id, v_request_line.quantity, v_request_line.amount, v_request_line.restock_shipped_quantity)
       is distinct from (new.order_id, new.quantity, new.amount, new.restock_shipped_quantity) then
      raise exception 'refund line does not match its request';
    end if;
    new.cancelled_quantity := v_request_line.cancelled_quantity;
    if new.cancelled_quantity > v_available then
      raise exception 'reserved refund cancellation is no longer available';
    end if;
  else
    -- Units declared as shipped-and-returned are not unshipped cancellations.
    new.cancelled_quantity := least(new.quantity - new.restock_shipped_quantity, v_available);
  end if;
  perform private.assert_shipped_restock(new.order_item_id, new.restock_shipped_quantity, v_request_id);
  if new.restocked_quantity <> 0 then raise exception 'restocked quantity is derived from unshipped cancellation'; end if;
  new.restocked_quantity := case when v_refund.status = 'succeeded' and v_refund.restock_requested and exists (
    select 1 from public.inventory_movements im join public.order_items oi on oi.variant_id = im.variant_id
    where oi.id = new.order_item_id and im.order_id = new.order_id and im.reason = 'order' and im.delta < 0
  ) then new.cancelled_quantity else 0 end;
  if (new.restocked_quantity > 0 or new.restock_shipped_quantity > 0)
     and (v_refund.status <> 'succeeded' or v_refund.payment_transaction_id is null) then
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
  new.cancelled_quantity := least(new.quantity - new.restock_shipped_quantity, v_available);
  perform private.assert_shipped_restock(new.order_item_id, new.restock_shipped_quantity);
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
  if private.order_has_payment_hold(v_order.id) then raise exception 'order has an unresolved payment hold'; end if;
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
    'version', p_fulfillment.version,
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
    raise exception 'fulfillment has refunded items or active refund requests; cannot cancel';
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
  if (new.id, new.order_id, new.items, new.created_at, new.version)
     is distinct from (old.id, old.order_id, old.items, old.created_at, old.version) then
    raise exception 'fulfillment commercial fields are immutable';
  end if;
  new.version := old.version + 1;
  if (new.status, new.carrier, new.tracking_number, new.tracking_url)
     is distinct from (old.status, old.carrier, old.tracking_number, old.tracking_url) then
    -- Direct writes already hold the fulfillment row; never wait backwards
    -- for the order lock needed by the audit event's foreign key.
    perform 1 from public.orders where id=old.order_id for update nowait;
  end if;
  if new.status <> old.status then
    update public.orders set updated_at=now() where id=old.order_id;
    if new.status='shipped' and private.order_has_payment_hold(old.order_id) then
      raise exception 'order has an unresolved payment hold';
    end if;
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
  if new.retry_start is distinct from old.retry_start and not (
    old.status = 'exhausted' and new.status = 'pending'
    and new.retry_start = old.attempts and new.attempts = old.attempts
    and exists (select 1 from commerce.outbox_redrives r
      where r.event_id = old.event_id and r.attempts = old.attempts)
  ) then raise exception 'outbox retry budget requires an audited redrive'; end if;
  if to_jsonb(new) = to_jsonb(old) then return new; end if;
  if old.status = 'published' and to_jsonb(new) is distinct from to_jsonb(old) then
    raise exception 'published outbox events are immutable';
  end if;
  if new.status <> old.status and not (
    (old.status in ('pending', 'failed') and new.status = 'processing')
    or (old.status = 'processing' and new.status in ('published', 'failed', 'exhausted'))
    or (old.status = 'failed' and new.status = 'exhausted')
    or (old.status = 'exhausted' and new.status = 'pending' and new.retry_start = old.attempts
      and new.retry_start > old.retry_start)
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
  if (new.carrier, new.tracking_number, new.tracking_url)
     is distinct from (old.carrier, old.tracking_number, old.tracking_url) then
    insert into public.order_events(order_id, actor_id, type, data)
    values (new.order_id, auth.uid(), 'fulfillment_tracking_updated',
      jsonb_build_object('fulfillment_id', new.id, 'version', new.version,
        'before', jsonb_build_object('carrier', old.carrier, 'tracking_number', old.tracking_number, 'tracking_url', old.tracking_url),
        'after', jsonb_build_object('carrier', new.carrier, 'tracking_number', new.tracking_number, 'tracking_url', new.tracking_url)));
  end if;
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
    v_source := 'items'; v_items := private.canonical_refund_items(p_items);
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
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('order_item_id', v_line.id, 'quantity', v_quantity, 'amount', v_line_amount,
        'restock_shipped_quantity', (v_item ->> 'restock_shipped_quantity')::integer));
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

CREATE FUNCTION private.refund_order(order_id uuid, items jsonb DEFAULT NULL::jsonb, amount numeric DEFAULT NULL::numeric, reason text DEFAULT NULL::text, restock boolean DEFAULT false, provider text DEFAULT 'manual'::text, shipping_amount numeric DEFAULT NULL) RETURNS uuid
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

  if restock or exists (select 1 from jsonb_array_elements(items) e where (e ->> 'restock_shipped_quantity')::integer > 0) then
    perform private.lock_order_inventory(array[v_order.id]);
  end if;

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
    insert into commerce.refund_lines(refund_id, order_id, order_item_id, quantity, amount, restock_shipped_quantity)
    values (v_refund_id, v_order.id, (v_item ->> 'order_item_id')::uuid, (v_item ->> 'quantity')::integer,
      (v_item ->> 'amount')::numeric, (v_item ->> 'restock_shipped_quantity')::integer);
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

  return v_refund_id;
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
    if private.order_has_payment_hold(v_order.id) then raise exception 'order has an unresolved payment hold'; end if;
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
  from public.orders o where o.id = new.order_id for update nowait;
  if not found or v_order_currency <> new.currency then
    raise exception 'payment transaction does not match its order';
  end if;
  -- Every ledger writer advances the aggregate's row version. A stale RR
  -- snapshot must abort before summing captures/refunds, even for direct SQL.
  update public.orders set updated_at = clock_timestamp() where id = new.order_id;

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

  -- The final crashed lease must leave processing even though it cannot be
  -- claimed again. Bounded SKIP LOCKED sweeping also handles failed fixtures.
  with exhausted as (
    select e.id from commerce.outbox_events e
    where e.attempts - e.retry_start >= 25 and
      (e.status = 'failed' or (e.status = 'processing' and e.lease_expires_at <= clock_timestamp()))
    order by e.id for update skip locked limit max_events
  )
  update commerce.outbox_events e set status = 'exhausted',
    locked_at = null, locked_by = null, lease_token = null, lease_expires_at = null
  from exhausted x where e.id = x.id;

  with candidates as (
    select e.id
    from commerce.outbox_events e
    where e.attempts - e.retry_start < 25 and (
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
  set status = case when succeeded then 'published'
                   when e.attempts - e.retry_start >= 25 then 'exhausted' else 'failed' end,
      published_at = case when succeeded then now() else null end,
      available_at = case when succeeded then e.available_at
                          else now() + make_interval(
                            secs => least(3600, power(2, least(e.attempts - e.retry_start, 10))::integer)
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

CREATE FUNCTION public.list_admin_outbox_events(page_size integer DEFAULT 20, status_filter text DEFAULT NULL,
    aggregate_id uuid DEFAULT NULL, after_id text DEFAULT NULL) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
declare v_items jsonb; v_next text; v_after_id bigint;
begin
  if not public.is_admin() then raise exception using errcode='42501', message='admin only'; end if;
  begin
    v_after_id := after_id::bigint;
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception using errcode='22023', message='after_id must be a positive bigint string';
  end;
  if page_size is null or page_size not between 1 and 100 or v_after_id < 1
    or (status_filter is not null and status_filter not in ('pending','processing','published','failed','exhausted')) then
    raise exception using errcode='22023', message='invalid page_size, status_filter or after_id';
  end if;
  with candidates as materialized (
    select e.* from commerce.outbox_events e
    where (status_filter is null or e.status=status_filter)
      and (list_admin_outbox_events.aggregate_id is null or e.aggregate_id=list_admin_outbox_events.aggregate_id)
      and (v_after_id is null or e.id<v_after_id)
    order by e.id desc limit page_size+1
  ), page as materialized (select * from candidates order by id desc limit page_size)
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',p.id::text,'event_id',p.event_id,'aggregate_type',p.aggregate_type,'aggregate_id',p.aggregate_id,
    'event_type',p.event_type,'status',p.status,'attempts',p.attempts,'retry_start',p.retry_start,
    'available_at',p.available_at,'lease_expires_at',p.lease_expires_at,'published_at',p.published_at,
    'created_at',p.created_at,'has_error',p.last_error is not null,
    'last_redrive',(select jsonb_build_object('attempts',r.attempts,'worker_id',r.worker_id,'reason',r.reason,'created_at',r.created_at)
      from commerce.outbox_redrives r where r.event_id=p.event_id order by r.attempts desc limit 1)
  ) order by p.id desc),'[]'::jsonb),
    case when (select count(*) from candidates)>page_size then (select min(id)::text from page) end
    into v_items,v_next from page p;
  return jsonb_build_object('items',v_items,'next_after_id',v_next);
end;
$$;

CREATE FUNCTION public.redrive_outbox_event(event_id uuid, expected_attempt integer, worker_id text DEFAULT NULL, reason text DEFAULT NULL) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare v_event commerce.outbox_events; v_redrive commerce.outbox_redrives; v_worker text;
begin
  if auth.role()='service_role' then
    v_worker := btrim(worker_id);
  elsif public.is_admin() then
    if worker_id is not null then raise exception using errcode='22023', message='admin must omit worker_id'; end if;
    v_worker := 'admin:' || auth.uid()::text;
  else
    raise exception using errcode='42501', message='admin or service role only';
  end if;
  if expected_attempt is null or expected_attempt < 25
    or coalesce(length(v_worker),0) not between 1 and 200
    or coalesce(length(btrim(reason)),0) not between 1 and 4000 then
    raise exception 'expected_attempt, worker_id and reason are required';
  end if;
  select * into v_event from commerce.outbox_events e
    where e.event_id = redrive_outbox_event.event_id for update;
  if not found then return false; end if;
  select * into v_redrive from commerce.outbox_redrives r
    where r.event_id = v_event.event_id and r.attempts = expected_attempt;
  if found then
    if (v_redrive.worker_id,v_redrive.reason) is distinct from (v_worker,btrim(reason)) then
      raise exception 'redrive attempt was used with different parameters';
    end if;
    return true;
  end if;
  if v_event.status <> 'exhausted' or v_event.attempts <> expected_attempt then return false; end if;
  insert into commerce.outbox_redrives(event_id,attempts,worker_id,reason)
    values(v_event.event_id,v_event.attempts,v_worker,btrim(reason));
  update commerce.outbox_events e set status = 'pending', retry_start = e.attempts,
    available_at = clock_timestamp() where e.event_id = v_event.event_id;
  return true;
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

CREATE FUNCTION public.update_fulfillment(fulfillment_id uuid, expected_version bigint, changes jsonb, idempotency_key text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare
  v_subject constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  v_key text := btrim(idempotency_key);
  v_hash text;
  v_record commerce.command_idempotency;
  v_fulfillment public.fulfillments;
  v_order uuid;
begin
  if not public.is_admin() then raise exception using errcode='42501', message='admin only'; end if;
  if coalesce(v_key, '')='' or length(v_key)>200 or expected_version is null or expected_version<1 then
    raise exception using errcode='22023', message='valid idempotency_key and expected_version are required';
  end if;
  if changes is null or jsonb_typeof(changes)<>'object' or changes='{}'::jsonb then
    raise exception using errcode='22023', message='changes must be a non-empty object';
  end if;
  if exists (select 1 from jsonb_each(changes) e where
    e.key not in ('status','carrier','tracking_number','tracking_url')
    or (jsonb_typeof(e.value)<>'string' and not (e.key='tracking_url' and e.value='null'::jsonb))) then
    raise exception using errcode='22023', message='unsupported fulfillment field or value';
  end if;
  v_hash := private.command_request_hash(jsonb_build_object('fulfillment_id',fulfillment_id,
    'expected_version',expected_version,'changes',changes));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('fulfillment.update:' || v_subject || ':' || v_key,0));
  select * into v_record from commerce.command_idempotency c
    where c.scope='fulfillment.update' and c.subject_id=v_subject and c.idempotency_key=v_key;
  if found then
    if v_record.request_hash<>v_hash then
      raise exception using errcode='PT409', message='idempotency key was used with different fulfillment parameters';
    end if;
    select * into v_fulfillment from public.fulfillments where id=v_record.resource_id;
    if not found then raise exception using errcode='PT404', message='fulfillment not found'; end if;
    return private.fulfillment_json(v_fulfillment);
  end if;
  select f.order_id into v_order from public.fulfillments f where f.id=fulfillment_id;
  if not found then raise exception using errcode='PT404', message='fulfillment not found'; end if;
  -- Match creation, refund and return commands: order before fulfillment.
  perform 1 from public.orders where id=v_order for update;
  select * into v_fulfillment from public.fulfillments f where f.id=fulfillment_id for update;
  if v_fulfillment.version<>expected_version then
    raise exception using errcode='PT409', message='fulfillment version conflict';
  end if;
  if exists (select 1 from jsonb_each(changes) e where e.value is distinct from to_jsonb(v_fulfillment)->e.key) then
    update public.fulfillments f set
      status=coalesce(changes->>'status',f.status),
      carrier=coalesce(changes->>'carrier',f.carrier),
      tracking_number=coalesce(changes->>'tracking_number',f.tracking_number),
      tracking_url=case when changes ? 'tracking_url' then changes->>'tracking_url' else f.tracking_url end
    where f.id=fulfillment_id returning * into v_fulfillment;
  end if;
  insert into commerce.command_idempotency(scope,subject_id,idempotency_key,request_hash,resource_type,resource_id)
    values ('fulfillment.update',v_subject,v_key,v_hash,'fulfillment',v_fulfillment.id);
  return private.fulfillment_json(v_fulfillment);
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
    and not private.order_has_payment_hold(v_order.id)
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
                           'payment_hold', private.order_has_payment_hold(v_order.id),
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
      'id', v_order.id, 'order_number', v_order.order_number::text,
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
        'id', a.id::text, 'order_item_id', a.order_item_id, 'kind', a.kind,
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
          'amount', rl.amount, 'cancelled_quantity', rl.cancelled_quantity, 'restocked_quantity', rl.restocked_quantity,
          'restock_shipped_quantity', rl.restock_shipped_quantity
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
  v_refund_id uuid;
  v_order public.orders;
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  if coalesce(v_key, '') = '' or length(v_key) > 200 then
    raise exception 'idempotency_key is required and must be at most 200 characters';
  end if;
  if items is not null then
    v_items := private.canonical_refund_items(items);
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

  v_refund_id := private.refund_order(
    order_id, v_items, amount, reason, restock, v_provider, shipping_amount
  );
  perform private.refresh_order_fulfillment(order_id);
  select * into v_order from public.orders o where o.id = refund_order.order_id;
  v_response := private.storefront_order_json(v_order);

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

CREATE FUNCTION private.list_orders(p_customer_id uuid, p_page_size integer, p_after_order_number text,
    p_status text, p_financial_status text, p_fulfillment_status text, p_admin boolean) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
declare v_items jsonb; v_next bigint; v_after bigint;
begin
  if p_after_order_number is not null then
    if p_after_order_number !~ '^(0|-?[1-9][0-9]{0,18})$' then
      raise exception using errcode = '22023', message = 'invalid order cursor';
    end if;
    v_after := p_after_order_number::bigint;
  end if;
  if p_page_size is null or p_page_size not between 1 and 100
    or (p_status is not null and p_status not in ('open','completed','cancelled'))
    or (p_financial_status is not null and p_financial_status not in ('pending','paid','partially_refunded','refunded','voided'))
    or (p_fulfillment_status is not null and p_fulfillment_status not in ('unfulfilled','partially_fulfilled','fulfilled')) then
    raise exception using errcode = '22023', message = 'invalid order list filter or page_size';
  end if;
  with candidates as materialized (
    select o.id,o.order_number,o.customer_id,o.email,o.status,o.financial_status,o.fulfillment_status,o.currency,o.total,o.created_at
    from public.orders o where (p_customer_id is null or o.customer_id = p_customer_id)
      and (v_after is null or o.order_number < v_after)
      and (p_status is null or o.status = p_status)
      and (p_financial_status is null or o.financial_status = p_financial_status)
      and (p_fulfillment_status is null or o.fulfillment_status = p_fulfillment_status)
    order by o.order_number desc limit p_page_size + 1
  ), page as materialized (select * from candidates order by order_number desc limit p_page_size)
  select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'order_number',p.order_number::text,'status',p.status,
    'financial_status',p.financial_status,'fulfillment_status',p.fulfillment_status,'currency',p.currency,
    'total',p.total,'created_at',p.created_at)
    || case when p_admin then jsonb_build_object('customer_id',p.customer_id,'email',p.email) else '{}'::jsonb end
    order by p.order_number desc),'[]'::jsonb),
    case when (select count(*) from candidates) > p_page_size then (select min(order_number) from page) end
  into v_items,v_next from page p;
  return jsonb_build_object('items',v_items,'next_cursor',v_next::text);
end;
$$;

CREATE FUNCTION public.list_customer_orders(page_size integer DEFAULT 20, after_order_number text DEFAULT NULL,
    status_filter text DEFAULT NULL, financial_status_filter text DEFAULT NULL, fulfillment_status_filter text DEFAULT NULL) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
declare v_customer uuid := public.current_customer_id();
begin
  if v_customer is null then raise exception using errcode = '42501', message = 'active customer required'; end if;
  return private.list_orders(v_customer,page_size,after_order_number,status_filter,financial_status_filter,fulfillment_status_filter,false);
end;
$$;

CREATE FUNCTION public.list_admin_orders(page_size integer DEFAULT 20, after_order_number text DEFAULT NULL,
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

CREATE FUNCTION public.update_order_admin_note(order_id uuid, changes jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare v_order public.orders;
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if order_id is null or jsonb_typeof(changes) is distinct from 'object'
    or not (changes ?& array['expected_admin_note','admin_note'])
    or changes-array['expected_admin_note','admin_note']<>'{}'::jsonb
    or jsonb_typeof(changes->'expected_admin_note') not in ('string','null')
    or jsonb_typeof(changes->'admin_note') not in ('string','null')
    or char_length(changes->>'admin_note')>10000 then
    raise exception using errcode='22023', message='expected and new notes required; new note maximum 10000 characters';
  end if;
  select * into v_order from public.orders o where o.id=order_id for no key update nowait;
  if not found then raise exception using errcode='PT404', message='order not found'; end if;
  if v_order.admin_note is distinct from (changes->>'expected_admin_note') then
    raise exception using errcode='PT409', message='internal note changed';
  end if;
  if v_order.admin_note is distinct from (changes->>'admin_note') then
    update public.orders o set admin_note=changes->>'admin_note' where o.id=order_id
      returning * into v_order;
  end if;
  -- Do not copy internal text into customer-readable order events or the outbox.
  return jsonb_build_object('id',v_order.id,'admin_note',v_order.admin_note);
end;
$$;

CREATE FUNCTION public.list_admin_order_events(order_id uuid, page_size integer DEFAULT 20,
    after_id text DEFAULT NULL, type_filter text DEFAULT NULL) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
declare v_items jsonb; v_next text; v_after bigint;
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if order_id is null or page_size is null or page_size not between 1 and 100
    or (after_id is not null and (length(after_id)>19 or after_id !~ '^[1-9][0-9]*$'))
    or (type_filter is not null and (char_length(type_filter) not between 1 and 200)) then
    raise exception using errcode='22023', message='invalid order event filters';
  end if;
  begin v_after:=after_id::bigint;
  exception when numeric_value_out_of_range then
    raise exception using errcode='22023', message='invalid order event cursor';
  end;
  with candidates as materialized (
    select e.id,e.order_id,e.actor_id,e.type,e.created_at from public.order_events e
    where e.order_id=list_admin_order_events.order_id
      and (v_after is null or e.id<v_after) and (type_filter is null or e.type=type_filter)
    order by e.id desc limit page_size+1
  ), page as materialized (select * from candidates order by id desc limit page_size)
  select coalesce(jsonb_agg(jsonb_build_object('id',p.id::text,'order_id',p.order_id,
    'actor_id',p.actor_id,'type',p.type,'created_at',p.created_at) order by p.id desc),'[]'::jsonb),
    case when (select count(*) from candidates)>page_size then (select id::text from page order by id limit 1) end
  into v_items,v_next from page p;
  return jsonb_build_object('items',v_items,'next_cursor',v_next);
end;
$$;

CREATE FUNCTION public.export_admin_orders(start_at timestamptz, end_at timestamptz,
    page_size integer DEFAULT 100, after_id uuid DEFAULT NULL) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
declare v_count bigint; v_items jsonb; v_next uuid;
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if start_at is null or end_at is null or not isfinite(start_at) or not isfinite(end_at)
    or end_at<=start_at or end_at-start_at>interval '744 hours'
    or page_size is null or page_size not between 1 and 100 then
    raise exception using errcode='22023', message='invalid export range or page size';
  end if;
  with candidates as materialized (
    select o.id,o.order_number,o.status,o.financial_status,o.fulfillment_status,o.currency,
      o.subtotal,o.discount_total,o.shipping_total,o.tax_total,o.total,o.created_at,o.updated_at
    from public.orders o where o.created_at>=start_at and o.created_at<end_at limit 10001
  ), remaining as materialized (
    select * from candidates c where after_id is null or c.id>after_id order by id limit page_size+1
  ), page as materialized (select * from remaining order by id limit page_size)
  select (select count(*) from candidates),
    coalesce(jsonb_agg(jsonb_build_object('id',p.id,'order_number',p.order_number::text,
      'status',p.status,'financial_status',p.financial_status,'fulfillment_status',p.fulfillment_status,
      'currency',p.currency,'subtotal',p.subtotal::text,'discount_total',p.discount_total::text,
      'shipping_total',p.shipping_total::text,'tax_total',p.tax_total::text,'total',p.total::text,
      'created_at',p.created_at,'updated_at',p.updated_at) order by p.id),'[]'::jsonb),
    case when (select count(*) from remaining)>page_size then (select id from page order by id desc limit 1) end
  into v_count,v_items,v_next from page p;
  if v_count>10000 then
    raise exception using errcode='PT422', message='export exceeds 10000 orders; narrow the time range';
  end if;
  return jsonb_build_object('start_at',start_at,'end_at',end_at,'items',v_items,'next_cursor',v_next);
end;
$$;

commit;
