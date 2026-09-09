begin;

create function private.order_snapshot_has_payment_intent(p_order_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from commerce.payment_intents i where i.order_id = p_order_id and (
      i.status in ('requires_payment_method', 'requires_action', 'processing')
      or (i.provider = 'stripe' and i.provider_reference is not null
          and i.provider_terminal_status is distinct from 'canceled')
    )
  );
$$;

create or replace function public.update_order_address(
  order_id uuid,
  address jsonb default null,
  address_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_updated public.orders;
begin
  -- Intent creation takes quote -> order. Do not acquire intent locks after
  -- taking the order lock; settlement takes intent -> quote -> order.
  perform 1 from commerce.checkout_quotes q
  where q.order_id = update_order_address.order_id for update;
  select * into v_order from public.orders o
  where o.id = update_order_address.order_id for update;
  if not found then raise exception 'order not found'; end if;
  if v_order.customer_id is distinct from auth.uid() and not public.is_admin() then
    raise exception 'not allowed';
  end if;
  if v_order.financial_status <> 'pending' then
    raise exception 'paid orders require an order edit adjustment';
  end if;
  if private.order_snapshot_has_payment_intent(v_order.id) then
    raise exception 'payment intent must be cancelled at the provider before editing order';
  end if;
  v_updated := private.update_order_address(
    update_order_address.order_id,
    private.normalize_checkout_address(update_order_address.address),
    update_order_address.address_id
  );
  return private.storefront_order_json(v_updated);
end;
$$;

-- Defense in depth for trusted table writes and future RPCs, not just the
-- address endpoint. Existing paid/quoted snapshot guards remain in place.
create function private.protect_order_payment_snapshot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (new.customer_id, new.email, new.currency, new.subtotal, new.discount_total,
      new.shipping_total, new.tax_total, new.total, new.shipping_address,
      new.billing_address, new.shipping_method_id, new.shipping_method_name,
      new.discount_code, new.customer_note, new.created_at)
     is distinct from
     (old.customer_id, old.email, old.currency, old.subtotal, old.discount_total,
      old.shipping_total, old.tax_total, old.total, old.shipping_address,
      old.billing_address, old.shipping_method_id, old.shipping_method_name,
      old.discount_code, old.customer_note, old.created_at)
     and private.order_snapshot_has_payment_intent(old.id) then
    raise exception 'order snapshot is locked by a payment intent';
  end if;
  return new;
end;
$$;
create trigger orders_payment_snapshot_immutable
  before update on public.orders
  for each row execute function private.protect_order_payment_snapshot();

create function private.protect_order_items_during_payment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order_id uuid := coalesce(new.order_id, old.order_id);
  v_financial_status text;
begin
  if tg_op = 'UPDATE' and new.order_id is distinct from old.order_id then
    raise exception 'order item ownership is immutable';
  end if;
  -- Commands already lock order -> item. A direct table UPDATE owns its item
  -- tuple first, so it must never wait in the reverse direction. Fail fast on
  -- contention instead of introducing an order/item ABBA deadlock.
  begin
    select o.financial_status into v_financial_status from public.orders o
    where o.id = v_order_id for update nowait;
  exception when lock_not_available then
    raise exception using errcode = 'PT409', message = 'order is busy; retry through an order command';
  end;
  -- Paid refunds remain governed by the original snapshot/refund-write guard.
  if v_financial_status = 'pending' and private.order_snapshot_has_payment_intent(v_order_id) then
    raise exception 'order items are locked by a payment intent';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
create trigger order_items_payment_snapshot_immutable
  before insert or update or delete on public.order_items
  for each row execute function private.protect_order_items_during_payment();

-- Recover historical amount/currency mismatches too. Never rewrite an existing
-- intent's commercial fields to hide the discrepancy; revoke the provider object.
create or replace function public.claim_expired_stripe_payment_intents(
  max_intents integer default 20,
  as_of timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_intent commerce.payment_intents;
  v_results jsonb := '[]'::jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service role only'; end if;
  if max_intents is null or max_intents not between 1 and 100 then
    raise exception 'max_intents must be between 1 and 100';
  end if;
  if as_of is null then raise exception 'as_of is required'; end if;
  for v_id in
    select i.id from commerce.payment_intents i join public.orders o on o.id = i.order_id
    where i.provider = 'stripe' and i.provider_reference is not null
      and i.status <> 'succeeded' and i.provider_terminal_status is null
      and i.provider_cancel_attempts < 100
      and (i.expires_at <= as_of or i.status in ('failed', 'cancelled')
           or o.status <> 'open' or o.financial_status <> 'pending'
           or (o.total, o.currency) is distinct from (i.amount, i.currency))
      and (i.provider_cancel_claimed_at is null
           or i.provider_cancel_claimed_at <= clock_timestamp() - interval '5 minutes')
    order by coalesce(i.expires_at, o.cancelled_at, i.created_at), i.id
    for update of i skip locked limit max_intents
  loop
    update commerce.payment_intents i
    set provider_cancel_claimed_at = clock_timestamp(),
        provider_cancel_attempts = i.provider_cancel_attempts + 1,
        provider_cancel_last_error = null
    where i.id = v_id returning * into v_intent;
    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'id', v_intent.id, 'order_id', v_intent.order_id,
      'provider_reference', v_intent.provider_reference, 'status', v_intent.status,
      'amount', v_intent.amount, 'currency', v_intent.currency,
      'expires_at', v_intent.expires_at, 'cancel_attempt', v_intent.provider_cancel_attempts
    ));
  end loop;
  return v_results;
end;
$$;

-- Ordinary customers cannot create already-approved/rejected reviews. The
-- separate admin policy still permits authorized moderation/imports.
drop policy "product_reviews: customer insert own" on public.product_reviews;
create policy "product_reviews: customer insert own" on public.product_reviews
  for insert with check (
    auth.uid() = customer_id and status = 'pending' and exists (
      select 1 from public.products p where p.id = product_id and p.status = 'active'
    )
  );

-- This owner-rights view must enforce category visibility explicitly; it does
-- not inherit categories' RLS. Preserve its availability calculation and shape.
create or replace view public.product_listing as
with active_reservations as materialized (
  select ql.variant_id, ql.location_id, sum(ql.quantity)::integer as reserved
  from commerce.checkout_quote_lines ql
  join commerce.checkout_quotes q on q.id = ql.quote_id
  where ql.track_inventory
    and q.status in ('open', 'converted') and q.expires_at > now()
  group by ql.variant_id, ql.location_id
), default_location as materialized (
  select l.id from public.locations l where l.is_default and l.is_active order by l.id limit 1
)
select
  p.id, p.slug, p.name, p.description, p.vendor, p.product_type, p.tags, p.created_at,
  (select min(v.price) from public.product_variants v
   where v.product_id = p.id and v.is_active) as price_from,
  ((select v.compare_at_price from public.product_variants v
    where v.product_id = p.id and v.is_active order by v.price, v.id limit 1))::numeric as compare_at_from,
  (select i.url from public.product_images i where i.product_id = p.id
   order by i.position, i.id limit 1) as primary_image,
  (select array_agg(c.slug order by c.slug) from public.product_categories pc
   join public.categories c on c.id = pc.category_id
   where pc.product_id = p.id and c.is_active) as categories,
  coalesce((
    select bool_or(not v.track_inventory or coalesce(il.on_hand, 0) - coalesce(ar.reserved, 0) > 0)
    from public.product_variants v
    left join default_location dl on true
    left join public.inventory_levels il on il.variant_id = v.id and il.location_id = dl.id
    left join active_reservations ar on ar.variant_id = v.id and ar.location_id = dl.id
    where v.product_id = p.id and v.is_active
  ), false) as in_stock
from public.products p where p.status = 'active';

revoke all on function private.order_snapshot_has_payment_intent(uuid) from public, anon, authenticated, service_role;
revoke all on function private.protect_order_payment_snapshot() from public, anon, authenticated, service_role;
revoke all on function private.protect_order_items_during_payment() from public, anon, authenticated, service_role;
-- CREATE OR REPLACE preserves public.update_order_address and view ACLs.

commit;
