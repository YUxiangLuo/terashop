-- Transaction ledgers, fulfillment, refunds, immutable snapshots and Outbox
-- Cross-domain function references are resolved after all definitions are installed.
begin;
set local check_function_bodies = false;

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
  perform 1 from public.orders o where o.id = new.order_id for update;
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
  v_source text;
  v_refund_amount numeric(12, 2);
  v_line_amount numeric(12, 2);
  v_ordered_quantity integer;
  v_item_amount numeric(12, 2);
  v_refunded_quantity integer;
  v_refunded_item_amount numeric(12, 2);
begin
  select r.source, r.amount into v_source, v_refund_amount
  from commerce.refunds r where r.id = v_refund_id;
  select coalesce(sum(rl.amount), 0) into v_line_amount
  from commerce.refund_lines rl where rl.refund_id = v_refund_id;
  if v_line_amount > v_refund_amount
     or (v_source = 'items' and v_line_amount <> v_refund_amount) then
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
               and r.status in ('requested', 'submitted', 'processing', 'requires_action')
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
  perform 1 from public.orders o where o.id = old.order_id for update;
  if exists (
    select 1 from commerce.fulfillment_lines fl
    join public.order_items oi on oi.id = fl.order_item_id
    where fl.fulfillment_id = old.id and (
      oi.refunded_quantity > 0 or exists (
        select 1 from commerce.refund_request_lines l
        join commerce.refund_requests r on r.id = l.refund_request_id
        where l.order_item_id = oi.id
          and r.status in ('requested', 'submitted', 'processing', 'requires_action')
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

CREATE FUNCTION private.protect_legacy_payment() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception 'payments are append-only';
  end if;
  if (new.order_id, new.provider, new.kind, new.amount, new.currency,
      new.payment_intent_id, new.idempotency_key, new.created_at)
     is distinct from
     (old.order_id, old.provider, old.kind, old.amount, old.currency,
      old.payment_intent_id, old.idempotency_key, old.created_at) then
    raise exception 'payment commercial fields are immutable';
  end if;
  if old.provider_ref is not null and new.provider_ref is distinct from old.provider_ref then
    raise exception 'payment provider reference is immutable';
  end if;
  if new.status <> old.status and not (
    old.status = 'pending' and new.status in ('succeeded', 'failed', 'cancelled')
  ) then
    raise exception 'invalid payment transition: % -> %', old.status, new.status;
  end if;
  return new;
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
  -- generated column line_total 在 BEFORE trigger 的 NEW 中尚未重算，会暂时为 null。
  if coalesce(current_setting('commerce.refund_write', true), 'off') <> 'on'
     or (to_jsonb(new) - array['refunded_quantity', 'refunded_amount', 'line_total'])
        is distinct from
        (to_jsonb(old) - array['refunded_quantity', 'refunded_amount', 'line_total'])
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
       or new.attempts <> old.attempts + 1 then
      raise exception 'processing outbox event requires a new lease attempt';
    end if;
  elsif new.locked_at is not null or new.locked_by is not null then
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
          new.created_at)
         is distinct from
         (old.customer_id, old.email, old.currency, old.subtotal,
          old.discount_total, old.shipping_total, old.tax_total, old.total,
          old.shipping_address, old.billing_address, old.shipping_method_id,
          old.shipping_method_name, old.discount_code, old.customer_note,
          old.created_at) then
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

CREATE FUNCTION private.refund_order(order_id uuid, items jsonb DEFAULT NULL::jsonb, amount numeric DEFAULT NULL::numeric, reason text DEFAULT NULL::text, restock boolean DEFAULT false, provider text DEFAULT 'manual'::text) RETURNS public.orders
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
  v_src_location uuid;
  v_on_hand integer;
begin
  if not public.is_admin() then
    raise exception 'admin only';
  end if;
  if items is not null and amount is not null then
    raise exception 'pass either items or amount, not both';
  end if;

  select * into v_order from public.orders where id = refund_order.order_id for update;
  if not found then
    raise exception 'order not found';
  end if;
  if v_order.financial_status not in ('paid', 'partially_refunded') then
    raise exception 'order is not refundable (current: %)', v_order.financial_status;
  end if;

  -- 已退合计（以成功的 refund 支付记录为准）
  select coalesce(sum(p.amount), 0) into v_refunded
  from public.payments p
  where p.order_id = v_order.id and p.kind = 'refund' and p.status = 'succeeded';
  v_refundable := v_order.total - v_refunded;
  if v_refundable <= 0 then
    raise exception 'order already fully refunded';
  end if;

  if items is not null then
    if jsonb_typeof(items) <> 'array' or jsonb_array_length(items) = 0 then
      raise exception 'items must be a non-empty array';
    end if;

    for v_item in select * from jsonb_array_elements(items) loop
      v_qty := coalesce((v_item ->> 'quantity')::int, 0);
      if v_qty <= 0 then
        raise exception 'refund quantity must be positive';
      end if;

      select oi.*, pv.track_inventory into v_line
      from public.order_items oi
      left join public.product_variants pv on pv.id = oi.variant_id
      where oi.id = (v_item ->> 'order_item_id')::uuid
        and oi.order_id = v_order.id
      for update of oi;
      if not found then
        raise exception 'order item % does not belong to this order', v_item ->> 'order_item_id';
      end if;
      if v_line.refunded_quantity + v_qty > v_line.quantity then
        raise exception 'refund quantity exceeds refundable (ordered %, refunded %, requested %)',
          v_line.quantity, v_line.refunded_quantity, v_qty;
      end if;

      -- 行退款额：退完该行时取剩余全部（消除多次部分退款的舍入误差），否则按数量比例
      if v_line.refunded_quantity + v_qty = v_line.quantity then
        v_line_refund := v_line.line_total - v_line.refunded_amount;
      else
        v_line_refund := round(v_line.line_total * v_qty / v_line.quantity, 2);
      end if;

      update public.order_items oi
      set refunded_quantity = oi.refunded_quantity + v_qty,
          refunded_amount = oi.refunded_amount + v_line_refund
      where oi.id = v_line.id;

      v_amount := v_amount + v_line_refund;

      -- 退货入库：只按原扣减流水回补对应仓；无扣减流水则不回库。
      if restock and exists (
        select 1 from public.inventory_movements original_movement
        where original_movement.order_id = v_order.id
          and original_movement.variant_id = v_line.variant_id
          and original_movement.reason = 'order'
          and original_movement.delta < 0
      ) then
        select im.location_id into v_src_location
        from public.inventory_movements im
        where im.order_id = v_order.id
          and im.variant_id = v_line.variant_id
          and im.reason = 'order'
          and im.delta < 0
        order by im.id
        limit 1;

        if v_src_location is not null then
          insert into public.inventory_levels (variant_id, location_id, on_hand)
          values (v_line.variant_id, v_src_location, 0)
          on conflict on constraint inventory_levels_pkey do nothing;

          update public.inventory_levels il
          set on_hand = il.on_hand + v_qty
          where il.variant_id = v_line.variant_id and il.location_id = v_src_location
          returning il.on_hand into v_on_hand;

          insert into public.inventory_movements
            (variant_id, location_id, delta, on_hand_after, reason, order_id, actor_id, note)
          values (v_line.variant_id, v_src_location, v_qty, v_on_hand,
                  'return', v_order.id, auth.uid(), reason);
        end if;
      end if;
    end loop;
  elsif amount is not null then
    if amount <= 0 then
      raise exception 'refund amount must be positive';
    end if;
    if amount > v_refundable then
      raise exception 'refund amount exceeds refundable (requested %, refundable %)', amount, v_refundable;
    end if;
    v_amount := amount;
  else
    v_amount := v_refundable;   -- 全额退剩余
  end if;

  insert into public.payments (order_id, provider, kind, status, amount, currency)
  values (v_order.id, provider, 'refund', 'succeeded', v_amount, v_order.currency);

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

CREATE FUNCTION private.sync_legacy_payment_transaction() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_parent_id uuid;
  v_kind text := case new.kind when 'charge' then 'capture' else new.kind end;
begin
  if new.amount <= 0 then
    return new;
  end if;
  if v_kind = 'refund' then
    select t.id into v_parent_id
    from commerce.payment_transactions t
    where t.order_id = new.order_id and t.kind = 'capture' and t.status = 'succeeded'
    order by t.created_at, t.id limit 1;
  end if;

  insert into commerce.payment_transactions as existing
    (order_id, payment_intent_id, parent_transaction_id, legacy_payment_id,
     provider, kind, status, amount, currency, provider_reference,
     idempotency_key, metadata, processed_at, created_at, updated_at)
  values
    (new.order_id, new.payment_intent_id, v_parent_id, new.id,
     new.provider, v_kind, new.status, new.amount, new.currency, new.provider_ref,
     new.idempotency_key, jsonb_build_object('legacy_payment', true),
     case when new.status = 'succeeded' then new.updated_at end,
     new.created_at, new.updated_at)
  on conflict (legacy_payment_id) do update
  set status = excluded.status,
      provider_reference = coalesce(excluded.provider_reference,
                                    existing.provider_reference),
      metadata = existing.metadata || excluded.metadata,
      processed_at = case when excluded.status = 'succeeded'
                          then coalesce(existing.processed_at, excluded.updated_at)
                          else existing.processed_at end;
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
  select * into v_order from public.orders o where o.id = new.order_id for update;
  if not found then raise exception 'order not found'; end if;
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
        new.legacy_payment_id, new.provider, new.kind, new.amount,
        new.currency, new.idempotency_key, new.created_at)
       is distinct from
       (old.order_id, old.payment_intent_id, old.parent_transaction_id,
        old.legacy_payment_id, old.provider, old.kind, old.amount,
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
  v_payment public.payments;
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
  if new.legacy_payment_id is not null then
    select * into v_payment from public.payments p where p.id = new.legacy_payment_id;
    if not found
       or v_payment.order_id <> new.order_id
       or v_payment.kind <> 'refund'
       or (v_payment.amount, v_payment.currency, v_payment.status)
          is distinct from (new.amount, new.currency, new.status)
       or (new.payment_transaction_id is not null
           and v_transaction.legacy_payment_id is distinct from v_payment.id) then
      raise exception 'refund header does not match its legacy payment';
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
  if max_events not between 1 and 100 then
    raise exception 'max_events must be between 1 and 100';
  end if;
  if lease_seconds not between 30 and 3600 then
    raise exception 'lease_seconds must be between 30 and 3600';
  end if;

  with candidates as (
    select e.id
    from commerce.outbox_events e
    where e.attempts < 25 and (
      (e.status in ('pending', 'failed') and e.available_at <= now())
      or (e.status = 'processing'
          and e.locked_at < now() - make_interval(secs => lease_seconds))
    )
    order by e.id
    for update skip locked
    limit max_events
  ), claimed as (
    update commerce.outbox_events e
    set status = 'processing', attempts = e.attempts + 1,
        locked_at = now(), locked_by = btrim(worker_id), last_error = null
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
           'created_at', c.created_at
         ) order by c.id), '[]'::jsonb)
  into v_result
  from claimed c;
  return v_result;
end;
$$;

CREATE FUNCTION public.complete_outbox_event(event_id uuid, worker_id text, succeeded boolean, error_message text DEFAULT NULL::text) RETURNS boolean
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
      locked_at = null,
      locked_by = null
  where e.event_id = complete_outbox_event.event_id
    and e.status = 'processing'
    and e.locked_by = btrim(complete_outbox_event.worker_id);
  return found;
end;
$$;

CREATE FUNCTION public.create_fulfillment(order_id uuid, items jsonb, carrier text DEFAULT ''::text, tracking_number text DEFAULT ''::text, tracking_url text DEFAULT NULL::text) RETURNS public.fulfillments
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  v_items jsonb;
  v_item jsonb;
begin
  if items is null or jsonb_typeof(items) <> 'array' or jsonb_array_length(items) = 0 then
    raise exception 'items must be a non-empty array';
  end if;

  for v_item in select value from jsonb_array_elements(create_fulfillment.items)
  loop
    if jsonb_typeof(v_item) <> 'object'
       or coalesce(v_item ->> 'order_item_id', '') = '' then
      raise exception 'each fulfillment item requires order_item_id';
    end if;
    begin
      perform (v_item ->> 'order_item_id')::uuid;
    exception when invalid_text_representation then
      raise exception 'order_item_id must be a UUID';
    end;

    if coalesce(v_item ->> 'quantity', '') !~ '^[1-9][0-9]*$' then
      raise exception 'fulfillment quantity must be a positive integer';
    end if;
    begin
      perform (v_item ->> 'quantity')::integer;
    exception when numeric_value_out_of_range then
      raise exception 'fulfillment quantity is too large';
    end;
  end loop;

  select jsonb_agg(
           jsonb_build_object('order_item_id', x.order_item_id, 'quantity', x.quantity)
           order by x.order_item_id
         )
  into v_items
  from (
    select e.value ->> 'order_item_id' as order_item_id,
           sum((e.value ->> 'quantity')::integer)::integer as quantity
    from jsonb_array_elements(create_fulfillment.items) e
    group by e.value ->> 'order_item_id'
  ) x;

  return private.create_fulfillment(
    create_fulfillment.order_id,
    v_items,
    create_fulfillment.carrier,
    create_fulfillment.tracking_number,
    create_fulfillment.tracking_url
  );
end;
$_$;

CREATE FUNCTION public.create_fulfillment_v2(order_id uuid, items jsonb, idempotency_key text, carrier text DEFAULT ''::text, tracking_number text DEFAULT ''::text, tracking_url text DEFAULT NULL::text) RETURNS jsonb
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
    where f.id = v_record.resource_id and f.order_id = create_fulfillment_v2.order_id;
    if not found then raise exception 'idempotency record points to a missing fulfillment'; end if;
    return private.fulfillment_json(v_fulfillment);
  end if;

  v_fulfillment := public.create_fulfillment(
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
    o.customer_id = auth.uid() or public.is_admin() or auth.role() = 'service_role'
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
      o.customer_id = auth.uid()
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
        'created_at', r.created_at,
        'lines', (select coalesce(jsonb_agg(jsonb_build_object(
          'order_item_id', rl.order_item_id, 'quantity', rl.quantity,
          'amount', rl.amount, 'restocked_quantity', rl.restocked_quantity
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

CREATE FUNCTION public.refund_order(order_id uuid, items jsonb DEFAULT NULL::jsonb, amount numeric DEFAULT NULL::numeric, reason text DEFAULT NULL::text, restock boolean DEFAULT false, provider text DEFAULT 'manual'::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  v_order public.orders;
  v_items jsonb := items;
  v_item jsonb;
  v_before_lines jsonb := '{}'::jsonb;
  v_before_payment_ids uuid[];
  v_payment public.payments;
  v_transaction_id uuid;
  v_refund_id uuid;
  v_source text;
  v_before_qty integer;
  v_before_amount numeric(12, 2);
  v_after_qty integer;
  v_after_amount numeric(12, 2);
  v_refunds_before numeric(12, 2);
  v_refunds_after numeric(12, 2);
  v_captured numeric(12, 2);
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  if items is not null and amount is not null then
    raise exception 'pass either items or amount, not both';
  end if;
  perform 1 from public.orders o where o.id = refund_order.order_id for update;
  if items is not null then
    if jsonb_typeof(items) <> 'array' or jsonb_array_length(items) = 0 then
      raise exception 'items must be a non-empty array';
    end if;
    for v_item in select value from jsonb_array_elements(items)
    loop
      if jsonb_typeof(v_item) <> 'object'
         or coalesce(v_item ->> 'order_item_id', '') = '' then
        raise exception 'each refund item requires order_item_id';
      end if;
      perform (v_item ->> 'order_item_id')::uuid;
      if coalesce(v_item ->> 'quantity', '') !~ '^[1-9][0-9]*$' then
        raise exception 'refund quantity must be a positive integer';
      end if;
      perform (v_item ->> 'quantity')::integer;
    end loop;
    select jsonb_agg(jsonb_build_object(
             'order_item_id', x.order_item_id, 'quantity', x.quantity) order by x.order_item_id)
    into v_items
    from (
      select e.value ->> 'order_item_id' as order_item_id,
             sum((e.value ->> 'quantity')::integer)::integer as quantity
      from jsonb_array_elements(items) e group by e.value ->> 'order_item_id'
    ) x;
    select coalesce(jsonb_object_agg(oi.id::text, jsonb_build_object(
             'quantity', oi.refunded_quantity, 'amount', oi.refunded_amount)), '{}'::jsonb)
    into v_before_lines from public.order_items oi
    where oi.order_id = refund_order.order_id and oi.id in (
      select (e.value ->> 'order_item_id')::uuid from jsonb_array_elements(v_items) e
    );
  end if;
  select coalesce(array_agg(p.id), '{}'::uuid[]), coalesce(sum(p.amount), 0)
  into v_before_payment_ids, v_refunds_before from public.payments p
  where p.order_id = refund_order.order_id and p.kind = 'refund' and p.status = 'succeeded';
  perform set_config('commerce.refund_write', 'on', true);
  v_order := private.refund_order(
    refund_order.order_id, v_items, refund_order.amount, refund_order.reason,
    refund_order.restock, refund_order.provider
  );
  perform set_config('commerce.refund_write', 'off', true);
  select coalesce(sum(p.amount) filter (where p.kind = 'charge'), 0),
         coalesce(sum(p.amount) filter (where p.kind = 'refund'), 0)
  into v_captured, v_refunds_after from public.payments p
  where p.order_id = refund_order.order_id and p.status = 'succeeded';
  if v_refunds_after <= v_refunds_before then raise exception 'refund amount must be positive'; end if;
  if v_refunds_after > v_captured then
    raise exception 'refund amount exceeds captured amount (refunded %, captured %)', v_refunds_after, v_captured;
  end if;
  select p.* into v_payment from public.payments p
  where p.order_id = refund_order.order_id and p.kind = 'refund'
    and not (p.id = any(v_before_payment_ids))
  order by p.created_at desc, p.id desc limit 1;
  if not found then raise exception 'refund payment was not recorded'; end if;
  select t.id into v_transaction_id from commerce.payment_transactions t
  where t.legacy_payment_id = v_payment.id;
  if not found then raise exception 'refund payment transaction was not recorded'; end if;
  v_source := case when v_items is not null then 'items'
                   when amount is not null then 'custom_amount' else 'remaining' end;
  insert into commerce.refunds
    (order_id, payment_transaction_id, legacy_payment_id, status, source,
     amount, currency, reason, restock_requested, actor_id)
  values (v_order.id, v_transaction_id, v_payment.id, v_payment.status, v_source,
          v_payment.amount, v_payment.currency, reason, restock, auth.uid())
  returning id into v_refund_id;
  if v_items is not null then
    for v_item in select value from jsonb_array_elements(v_items)
    loop
      v_before_qty := coalesce((v_before_lines -> (v_item ->> 'order_item_id') ->> 'quantity')::integer, 0);
      v_before_amount := coalesce((v_before_lines -> (v_item ->> 'order_item_id') ->> 'amount')::numeric, 0);
      select oi.refunded_quantity, oi.refunded_amount into v_after_qty, v_after_amount
      from public.order_items oi where oi.id = (v_item ->> 'order_item_id')::uuid;
      insert into commerce.refund_lines
        (refund_id, order_id, order_item_id, quantity, amount, restocked_quantity)
      values (
        v_refund_id, v_order.id, (v_item ->> 'order_item_id')::uuid,
        v_after_qty - v_before_qty, v_after_amount - v_before_amount,
        case when restock and exists (
          select 1 from public.inventory_movements im
          where im.order_id = v_order.id and im.variant_id = (
            select oi.variant_id from public.order_items oi where oi.id = (v_item ->> 'order_item_id')::uuid
          ) and im.reason = 'order' and im.delta < 0
        ) then v_after_qty - v_before_qty else 0 end
      );
    end loop;
  end if;
  perform private.refresh_order_fulfillment(v_order.id);
  select * into v_order from public.orders o where o.id = refund_order.order_id;
  return private.storefront_order_json(v_order);
end;
$_$;

CREATE FUNCTION public.refund_order_v2(order_id uuid, idempotency_key text, items jsonb DEFAULT NULL::jsonb, amount numeric DEFAULT NULL::numeric, reason text DEFAULT NULL::text, restock boolean DEFAULT false, provider text DEFAULT 'manual'::text) RETURNS jsonb
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
    'reason', reason, 'restock', restock, 'provider', v_provider
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
    where r.id = v_record.resource_id and r.order_id = refund_order_v2.order_id;
    if not found then raise exception 'idempotency record points to a missing refund'; end if;
    return private.storefront_order_json(v_order);
  end if;

  select coalesce(array_agg(r.id), '{}'::uuid[]) into v_before_refunds
  from commerce.refunds r where r.order_id = refund_order_v2.order_id;
  v_response := public.refund_order(
    order_id, v_items, amount, reason, restock, v_provider
  );
  select r.id into v_refund_id from commerce.refunds r
  where r.order_id = refund_order_v2.order_id
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

commit;
