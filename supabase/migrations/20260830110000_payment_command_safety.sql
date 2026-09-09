begin;

-- A provider POST is not atomic with PostgreSQL. Persist the PayPal dispatch
-- boundary before leaving the database; never clear it on an ambiguous timeout.
alter table commerce.payment_intents
  add column provider_capture_requested_at timestamptz,
  add constraint payment_intents_capture_provider_ck check (
    provider_capture_requested_at is null or provider = 'paypal'
  );

create function private.protect_capture_request_marker()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.provider_capture_requested_at is not null
     and new.provider_capture_requested_at is distinct from old.provider_capture_requested_at then
    raise exception 'provider capture request marker is immutable';
  end if;
  return new;
end;
$$;
create trigger payment_intents_capture_marker_immutable
  before update of provider_capture_requested_at on commerce.payment_intents
  for each row execute function private.protect_capture_request_marker();

create function public.prepare_paypal_capture(payment_intent_id uuid, customer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent commerce.payment_intents;
  v_quote commerce.checkout_quotes;
  v_order public.orders;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service role only'; end if;
  -- Same lock order as provider settlement and manual payment.
  select * into v_intent from commerce.payment_intents i
  where i.id = prepare_paypal_capture.payment_intent_id and i.provider = 'paypal'
  for update;
  if not found then raise exception 'PayPal payment intent not found'; end if;
  select * into v_quote from commerce.checkout_quotes q
  where q.order_id = v_intent.order_id for update;
  select * into v_order from public.orders o where o.id = v_intent.order_id for update;
  if not found or prepare_paypal_capture.customer_id is null
     or v_order.customer_id is distinct from prepare_paypal_capture.customer_id then
    raise exception 'payable order not found for customer';
  end if;
  if v_order.status <> 'open' or v_order.financial_status <> 'pending' then
    raise exception 'order is not payable';
  end if;
  if (v_order.total, v_order.currency) is distinct from (v_intent.amount, v_intent.currency) then
    raise exception 'order total changed after payment intent creation';
  end if;
  if v_intent.provider_reference is null
     or v_intent.status not in ('requires_payment_method', 'requires_action', 'processing') then
    raise exception 'PayPal payment intent is not capturable';
  end if;
  if v_intent.expires_at <= clock_timestamp()
     or (v_quote.id is not null and
         (v_quote.status <> 'converted' or v_quote.expires_at <= clock_timestamp())) then
    raise exception 'checkout reservation is not active';
  end if;
  update commerce.payment_intents i
  set provider_capture_requested_at = coalesce(i.provider_capture_requested_at, clock_timestamp()),
      status = 'processing'
  where i.id = v_intent.id returning * into v_intent;
  perform private.enqueue_outbox_event(
    'payment_intent', v_intent.id, 'paypal.capture_requested',
    jsonb_build_object('payment_intent_id', v_intent.id, 'order_id', v_order.id,
                      'provider_reference', v_intent.provider_reference),
    'paypal-capture-requested:' || v_intent.id
  );
  return private.provider_payment_intent_json(v_intent);
end;
$$;

create function private.protect_order_during_paypal_capture()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- The caller already owns the order lock. Do not acquire an intent lock here
  -- (settlement takes intent -> quote -> order). A fresh MVCC read is sufficient:
  -- prepare either committed before this order lock, or will see our cancellation.
  if exists (
    select 1 from commerce.payment_intents i
    where i.order_id = old.id and i.provider = 'paypal'
      and i.provider_capture_requested_at is not null
      and i.status in ('requires_payment_method', 'requires_action', 'processing')
  ) then
    if new.status = 'cancelled' and old.status <> 'cancelled'
       and not exists (
         -- Expiry must remain bounded even when the provider outcome is unknown.
         -- expire_checkout_quotes transitions the quote before cancelling its order.
         select 1 from commerce.checkout_quotes q
         where q.order_id = old.id and q.status = 'expired'
       ) then
      raise exception 'PayPal capture is in progress; reconcile before cancellation';
    end if;
    if (new.customer_id, new.currency, new.subtotal, new.discount_total,
        new.shipping_total, new.tax_total, new.total, new.shipping_address, new.billing_address)
       is distinct from
       (old.customer_id, old.currency, old.subtotal, old.discount_total,
        old.shipping_total, old.tax_total, old.total, old.shipping_address, old.billing_address) then
      raise exception 'order snapshot is locked during PayPal capture';
    end if;
  end if;
  return new;
end;
$$;
create trigger orders_paypal_capture_guard
  before update on public.orders
  for each row execute function private.protect_order_during_paypal_capture();

-- A local status change does not revoke a browser's client_secret. Refuse
-- manual payment while a real provider can still collect the same funds.
create or replace function public.mark_order_paid(
  order_id uuid,
  provider text default 'manual',
  provider_ref text default null
)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  perform 1 from commerce.payment_intents i
  where i.order_id = mark_order_paid.order_id order by i.id for update;
  perform 1 from commerce.checkout_quotes q
  where q.order_id = mark_order_paid.order_id for update;
  select * into v_order from public.orders o
  where o.id = mark_order_paid.order_id for update;
  if not found then raise exception 'order not found'; end if;
  if v_order.financial_status <> 'pending' then
    raise exception 'order is not pending payment (current: %)', v_order.financial_status;
  end if;
  if v_order.status <> 'open' then
    raise exception 'order is not open (current: %)', v_order.status;
  end if;
  if exists (
    select 1 from commerce.payment_intents i where i.order_id = v_order.id and (
      ((i.provider in ('stripe', 'paypal') or i.provider_reference is not null)
       and i.status in ('requires_payment_method', 'requires_action', 'processing')
       and (i.provider <> 'stripe' or i.provider_terminal_status is distinct from 'canceled'))
      or (i.provider = 'stripe' and i.provider_reference is not null
          and i.provider_terminal_status is distinct from 'canceled')
    )
  ) then
    raise exception 'online payment intent must be reconciled or cancelled at the provider before manual payment';
  end if;

  perform private.consume_order_reservation(v_order.id);
  -- Preserve unbound manual/test-provider compatibility, never real online intents.
  update commerce.payment_intents i set status = 'cancelled'
  where i.order_id = v_order.id
    and i.status in ('requires_payment_method', 'requires_action', 'processing');
  if v_order.total > 0 then
    return private.mark_order_paid(v_order.id, provider, provider_ref);
  end if;
  update public.orders
  set financial_status = 'paid', paid_at = now(),
      status = case when fulfillment_status = 'fulfilled' then 'completed' else status end,
      completed_at = case when fulfillment_status = 'fulfilled' then now() else completed_at end
  where id = v_order.id returning * into v_order;
  insert into public.order_events (order_id, actor_id, type, data)
  values (v_order.id, auth.uid(), 'payment_received',
          jsonb_build_object('provider', provider, 'amount', 0, 'free_order', true));
  return v_order;
end;
$$;

-- Also recover already-cancelled legacy intents and non-payable orders. The
-- provider terminal observation, not the local status, ends cancellation work.
drop index commerce.payment_intents_provider_cancel_idx;
create index payment_intents_provider_cancel_idx
on commerce.payment_intents (
  coalesce(provider_cancel_claimed_at, '-infinity'::timestamptz), expires_at, id
)
where provider = 'stripe' and provider_reference is not null
  and status <> 'succeeded' and provider_terminal_status is null
  and provider_cancel_attempts < 100;

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
    select i.id from commerce.payment_intents i
    join public.orders o on o.id = i.order_id
    where i.provider = 'stripe' and i.provider_reference is not null
      and i.status <> 'succeeded' and i.provider_terminal_status is null
      and i.provider_cancel_attempts < 100
      and (i.expires_at <= as_of or i.status in ('failed', 'cancelled')
           or o.status <> 'open' or o.financial_status <> 'pending')
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

-- API retries may observe success/failure after a previous pending response.
-- Binding identifies the resource; only Inbox processing establishes its terminal
-- business outcome. Never regress processing/requires_action back to submitted.
create or replace function public.bind_refund_request_provider(
  refund_request_id uuid,
  provider_reference text,
  provider_status text,
  amount numeric,
  currency text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request commerce.refund_requests;
  v_status text := lower(btrim(provider_status));
  v_reference text := btrim(provider_reference);
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service role only'; end if;
  if coalesce(v_reference, '') = '' then raise exception 'provider_reference is required'; end if;
  if v_status is null or v_status not in ('pending', 'requires_action', 'succeeded', 'failed', 'canceled', 'cancelled') then
    raise exception 'unsupported provider refund status %', v_status;
  end if;
  select * into v_request from commerce.refund_requests r
  where r.id = bind_refund_request_provider.refund_request_id for update;
  if not found then raise exception 'refund request not found'; end if;
  if (v_request.amount, v_request.currency)
     is distinct from (round(bind_refund_request_provider.amount, 2), upper(btrim(currency))) then
    raise exception 'provider refund amount or currency mismatch';
  end if;
  if v_request.provider_reference is not null and v_request.provider_reference <> v_reference then
    raise exception 'refund request is already bound to another provider reference';
  end if;
  if v_request.status in ('succeeded', 'failed', 'cancelled') then
    if v_request.provider_reference is distinct from v_reference then
      raise exception 'completed refund request cannot bind a new provider reference';
    end if;
    return private.refund_request_json(v_request);
  end if;
  update commerce.refund_requests r
  set provider_reference = v_reference,
      status = case
        when r.status not in ('requested', 'submitted') then r.status
        when v_status = 'pending' then 'processing'
        when v_status = 'requires_action' then 'requires_action'
        else 'submitted' end,
      submitted_at = coalesce(r.submitted_at, now())
  where r.id = v_request.id returning * into v_request;
  return private.refund_request_json(v_request);
end;
$$;

revoke all on function private.protect_capture_request_marker() from public, anon, authenticated, service_role;
revoke all on function private.protect_order_during_paypal_capture() from public, anon, authenticated, service_role;
revoke all on function public.prepare_paypal_capture(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.prepare_paypal_capture(uuid, uuid) to service_role;
-- CREATE OR REPLACE preserves the established ACL of the other public RPCs.

commit;
