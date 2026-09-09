begin;

-- Financial refunds may cover either unshipped cancellations or previously
-- shipped units. Persist the distinction instead of subtracting every refunded
-- unit from every shipment (which double-counts returns).
alter table commerce.refund_lines
  add column cancelled_quantity integer not null default 0
    check (cancelled_quantity between 0 and quantity);
alter table commerce.refund_request_lines
  add column cancelled_quantity integer not null default 0
    check (cancelled_quantity between 0 and quantity);

-- Historical refund payloads did not express cancellation vs return. Allocate
-- unfulfilled units first, conservatively, without changing any financial or
-- inventory fact. Published/cancelled fulfillment facts are otherwise untouched.
alter table commerce.refund_lines disable trigger refund_lines_immutable;
with historical as (
  select rl.refund_id, rl.order_item_id, rl.quantity,
         greatest(oi.quantity - coalesce((
           select sum(fl.quantity) from commerce.fulfillment_lines fl
           join public.fulfillments f on f.id = fl.fulfillment_id
           where fl.order_item_id = oi.id and f.status <> 'cancelled'
         ), 0), 0) as cancellation_capacity,
         coalesce(sum(rl.quantity) over (
           partition by rl.order_item_id order by rl.created_at, rl.refund_id
           rows between unbounded preceding and 1 preceding
         ), 0) as preceding_quantity
  from commerce.refund_lines rl
  join commerce.refunds r on r.id = rl.refund_id and r.status = 'succeeded'
  join public.order_items oi on oi.id = rl.order_item_id
)
update commerce.refund_lines rl
set cancelled_quantity = least(h.quantity, greatest(h.cancellation_capacity - h.preceding_quantity, 0))::integer
from historical h where h.refund_id = rl.refund_id and h.order_item_id = rl.order_item_id;
-- Flush deferred line-total checks before ALTER TABLE changes trigger state.
set constraints all immediate;
alter table commerce.refund_lines enable trigger refund_lines_immutable;

-- The two optional exclusions are only used while inserting a refund fact:
-- its compatibility refunded_quantity was already advanced, and its own pending
-- request must not be counted again when checking its reserved cancellation.
create function private.order_item_fulfillment_balance(
  p_order_item_id uuid,
  p_unrecorded_refund_quantity integer default 0,
  p_exclude_request_id uuid default null
)
returns table (
  ordered_quantity integer,
  fulfilled_quantity integer,
  cancelled_quantity integer,
  reserved_quantity integer,
  available_quantity integer
)
language sql
stable
security definer
set search_path = ''
as $$
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

alter table commerce.refund_request_lines disable trigger refund_request_lines_immutable;
-- Preserve successful request allocations where the relation is known.
update commerce.refund_request_lines l
set cancelled_quantity = rl.cancelled_quantity
from commerce.refunds r join commerce.refund_lines rl on rl.refund_id = r.id
where r.metadata ->> 'refund_request_id' = l.refund_request_id::text
  and rl.order_item_id = l.order_item_id;
with historical as (
  select l.refund_request_id, l.order_item_id, l.quantity, b.available_quantity,
         coalesce(sum(l.quantity) over (
           partition by l.order_item_id order by r.created_at, r.id
           rows between unbounded preceding and 1 preceding
         ), 0) as preceding_quantity
  from commerce.refund_request_lines l
  join commerce.refund_requests r on r.id = l.refund_request_id
  cross join lateral private.order_item_fulfillment_balance(l.order_item_id) b
  where r.status in ('requested', 'submitted', 'processing', 'requires_action')
)
update commerce.refund_request_lines l
set cancelled_quantity = least(h.quantity, greatest(h.available_quantity - h.preceding_quantity, 0))::integer
from historical h where h.refund_request_id = l.refund_request_id and h.order_item_id = l.order_item_id;
alter table commerce.refund_request_lines enable trigger refund_request_lines_immutable;
set constraints all deferred;

create function private.allocate_refund_request_cancellation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
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
create trigger refund_request_lines_allocate_cancellation
  before insert on commerce.refund_request_lines
  for each row execute function private.allocate_refund_request_cancellation();

create function private.allocate_refund_cancellation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
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
create trigger refund_lines_allocate_cancellation
  before insert on commerce.refund_lines
  for each row execute function private.allocate_refund_cancellation();

create or replace function private.validate_fulfillment_line()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
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

-- A shipped refund must not later be turned into a fresh fulfillment allowance
-- by changing its shipment to cancelled. Returns and replacements are separate
-- commands, not a way to erase the original shipment's quantity.
create function private.prevent_refunded_fulfillment_cancellation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
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
create trigger fulfillments_refund_cancellation_guard
  before update of status on public.fulfillments
  for each row execute function private.prevent_refunded_fulfillment_cancellation();

create function private.refresh_order_fulfillment(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
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

create or replace function private.create_fulfillment(
  order_id uuid,
  items jsonb,
  carrier text default '',
  tracking_number text default '',
  tracking_url text default null
)
returns public.fulfillments
language plpgsql
security definer
set search_path = ''
as $$
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

create or replace function private.recalculate_order_fulfillment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
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

-- Keep the established V3 accounting wrapper, but refresh before returning its
-- order DTO. Otherwise its first response (including V2) precedes the deferred
-- fulfillment update and disagrees with a subsequent read/idempotent retry.
create or replace function public.refund_order(
  order_id uuid,
  items jsonb default null,
  amount numeric default null,
  reason text default null,
  restock boolean default false,
  provider text default 'manual'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

-- Recompute after all refund rows and the request terminal status have settled.
-- Deferred execution also prevents double-counting a just-finalized request and
-- its successful refund during a multi-line transaction.
create function private.refresh_fulfillment_after_refund()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.refresh_order_fulfillment(new.order_id);
  return new;
end;
$$;
create constraint trigger refund_lines_refresh_fulfillment
  after insert on commerce.refund_lines deferrable initially deferred
  for each row execute function private.refresh_fulfillment_after_refund();

-- Explicit DTO for clients deciding which quantities may be shipped next.
create function public.get_order_fulfillment_balance(order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
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
revoke all on function public.get_order_fulfillment_balance(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_order_fulfillment_balance(uuid) to authenticated, service_role;

revoke all on function private.order_item_fulfillment_balance(uuid, integer, uuid) from public, anon, authenticated, service_role;
revoke all on function private.allocate_refund_request_cancellation() from public, anon, authenticated, service_role;
revoke all on function private.allocate_refund_cancellation() from public, anon, authenticated, service_role;
revoke all on function private.prevent_refunded_fulfillment_cancellation() from public, anon, authenticated, service_role;
revoke all on function private.refresh_order_fulfillment(uuid) from public, anon, authenticated, service_role;
revoke all on function private.refresh_fulfillment_after_refund() from public, anon, authenticated, service_role;

-- Bring historical fulfillment summaries in line with the conservative
-- allocation, without rewriting any money, inventory or original quantities.
do $$
declare
  v_order_id uuid;
begin
  for v_order_id in
    select distinct oi.order_id from public.order_items oi
    where oi.refunded_quantity > 0 order by oi.order_id
  loop
    perform private.refresh_order_fulfillment(v_order_id);
  end loop;
end;
$$;

commit;
