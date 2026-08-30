begin;

-- Preserve Stripe's exact external amount even when a signed successful event is
-- outside the store's CNY capability. The legacy `amount` remains a major-unit
-- value, widened only inside the hidden commerce schema; exact minor units and
-- the Stripe currency exponent make the provider fact unambiguous.
alter table commerce.provider_money_movements
  alter column amount type numeric(20, 8),
  add column provider_amount_minor numeric(20, 0),
  add column provider_currency_exponent smallint;

alter table commerce.provider_money_movements disable trigger provider_money_movements_validate;
update commerce.provider_money_movements
set provider_amount_minor = amount * 100,
    provider_currency_exponent = 2
where provider = 'stripe';
alter table commerce.provider_money_movements enable trigger provider_money_movements_validate;

-- A browser can retain a client_secret after a short quote expires. Track
-- service-worker cancellation claims so the provider object is canceled too,
-- rather than merely making the late success safe to reconcile.
alter table commerce.payment_intents
  add column provider_cancel_claimed_at timestamptz,
  add column provider_cancel_attempts integer not null default 0
    check (provider_cancel_attempts between 0 and 100),
  add column provider_cancel_last_error text
    check (provider_cancel_last_error is null
           or char_length(provider_cancel_last_error) <= 200),
  add column provider_terminal_status text
    check (provider_terminal_status is null
           or provider_terminal_status in ('succeeded', 'canceled')),
  add column provider_terminal_observed_at timestamptz,
  add constraint payment_intents_provider_terminal_pair_ck check (
    (provider_terminal_status is null) = (provider_terminal_observed_at is null)
  );

create index payment_intents_provider_cancel_idx
on commerce.payment_intents (
  coalesce(provider_cancel_claimed_at, '-infinity'::timestamptz), expires_at, id
)
where provider = 'stripe'
  and provider_reference is not null
  and status in ('requires_payment_method', 'requires_action', 'processing')
  and provider_terminal_status is null
  and provider_cancel_attempts < 100;

alter table commerce.provider_money_movements
  add constraint provider_money_movements_exact_amount_ck check (
    (provider_amount_minor is null and provider_currency_exponent is null)
    or (
      provider_amount_minor > 0
      and provider_currency_exponent in (0, 2)
      and amount = provider_amount_minor
        / pg_catalog.power(10::numeric, provider_currency_exponent)
    )
  ),
  add constraint provider_money_movements_stripe_exact_ck check (
    provider <> 'stripe'
    or (provider_amount_minor is not null and provider_currency_exponent is not null)
  );

create or replace function private.validate_provider_money_movement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent commerce.payment_intents;
  v_request commerce.refund_requests;
  v_transaction commerce.payment_transactions;
begin
  new.provider := lower(btrim(new.provider));
  new.currency := upper(btrim(new.currency));
  if new.payment_intent_id is not null then
    select * into v_intent from commerce.payment_intents i where i.id = new.payment_intent_id;
    if not found or new.kind <> 'capture'
       or (new.order_id, new.provider, new.currency)
          is distinct from (v_intent.order_id, v_intent.provider, v_intent.currency) then
      raise exception 'provider capture movement does not match payment intent';
    end if;
  end if;
  if new.refund_request_id is not null then
    select * into v_request from commerce.refund_requests r where r.id = new.refund_request_id;
    if not found or new.kind <> 'refund'
       or (new.order_id, new.provider, new.currency)
          is distinct from (v_request.order_id, v_request.provider, v_request.currency) then
      raise exception 'provider refund movement does not match refund request';
    end if;
  end if;
  if new.payment_transaction_id is not null then
    select * into v_transaction from commerce.payment_transactions t
    where t.id = new.payment_transaction_id;
    if not found or v_transaction.status <> 'succeeded'
       or (new.order_id, new.provider, new.kind, new.amount, new.currency)
          is distinct from
          (v_transaction.order_id, v_transaction.provider, v_transaction.kind,
           v_transaction.amount, v_transaction.currency) then
      raise exception 'matched provider movement does not match payment transaction';
    end if;
  end if;
  if tg_op = 'UPDATE' then
    if (new.provider_event_id, new.provider, new.kind, new.provider_reference,
        new.amount, new.currency, new.provider_amount_minor,
        new.provider_currency_exponent, new.created_at)
       is distinct from
       (old.provider_event_id, old.provider, old.kind, old.provider_reference,
        old.amount, old.currency, old.provider_amount_minor,
        old.provider_currency_exponent, old.created_at) then
      raise exception 'provider money facts are immutable';
    end if;
    if old.order_id is not null and new.order_id is distinct from old.order_id
       or old.payment_intent_id is not null
          and new.payment_intent_id is distinct from old.payment_intent_id
       or old.refund_request_id is not null
          and new.refund_request_id is distinct from old.refund_request_id
       or old.payment_transaction_id is not null
          and new.payment_transaction_id is distinct from old.payment_transaction_id then
      raise exception 'provider money reconciliation links are one-way';
    end if;
    if old.reconciliation_status = 'matched' and new is distinct from old then
      raise exception 'matched provider money movement is immutable';
    end if;
  end if;
  return new;
end;
$$;

create or replace function private.stripe_currency_exponent(p_currency text)
returns smallint
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v_currency text := upper(btrim(p_currency));
begin
  if v_currency is null or v_currency !~ '^[A-Z]{3}$' then
    raise exception 'invalid Stripe currency';
  end if;
  if v_currency in (
    'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA',
    'PYG', 'RWF', 'VND', 'VUV', 'XAF', 'XOF', 'XPF'
  ) then return 0; end if;
  -- Stripe API charge amounts are otherwise two-decimal. ISK and UGX use a
  -- backward-compatible exponent of 2 with amounts ending in 00; HUF/TWD
  -- charge rules are also exponent 2 (their special restrictions are payouts).
  return 2;
end;
$$;

create or replace function private.record_stripe_money_movement(
  p_event commerce.payment_provider_events,
  p_kind text,
  p_amount_minor text,
  p_currency text,
  p_order_id uuid default null,
  p_payment_intent_id uuid default null,
  p_refund_request_id uuid default null
)
returns commerce.provider_money_movements
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_movement commerce.provider_money_movements;
  v_currency text := upper(btrim(p_currency));
  v_exponent smallint := private.stripe_currency_exponent(p_currency);
  v_minor numeric(20, 0);
  v_amount numeric(20, 8);
begin
  if p_event.provider <> 'stripe' or p_event.object_reference is null
     or p_kind not in ('capture', 'refund')
     or coalesce(p_amount_minor, '') !~ '^[1-9][0-9]{0,11}$' then
    raise exception 'invalid Stripe money movement';
  end if;
  v_minor := p_amount_minor::numeric;
  v_amount := v_minor / pg_catalog.power(10::numeric, v_exponent);
  insert into commerce.provider_money_movements (
    provider_event_id, provider, kind, provider_reference, amount, currency,
    provider_amount_minor, provider_currency_exponent,
    order_id, payment_intent_id, refund_request_id
  ) values (
    p_event.id, p_event.provider, p_kind, p_event.object_reference, v_amount, v_currency,
    v_minor, v_exponent, p_order_id, p_payment_intent_id, p_refund_request_id
  ) on conflict on constraint provider_money_movements_provider_kind_provider_reference_key do update
  set order_id = coalesce(commerce.provider_money_movements.order_id, excluded.order_id),
      payment_intent_id = coalesce(commerce.provider_money_movements.payment_intent_id,
                                   excluded.payment_intent_id),
      refund_request_id = coalesce(commerce.provider_money_movements.refund_request_id,
                                   excluded.refund_request_id)
  returning * into v_movement;
  if (v_movement.provider, v_movement.kind, v_movement.provider_reference,
      v_movement.amount, v_movement.currency, v_movement.provider_amount_minor,
      v_movement.provider_currency_exponent)
     is distinct from
     ('stripe', p_kind, p_event.object_reference, v_amount, v_currency, v_minor, v_exponent) then
    raise exception 'provider event conflicts with an existing money movement';
  end if;
  return v_movement;
end;
$$;

-- Stripe webhook delivery is unordered. Keep successful money handling dominant,
-- but prevent an older non-money status event from regressing a newer state.
create or replace function private.process_stripe_payment_event(
  p_event commerce.payment_provider_events
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent commerce.payment_intents;
  v_metadata_id text := p_event.data -> 'metadata' ->> 'tera_payment_intent_id';
  v_amount numeric(20, 8);
  v_amount_minor text := p_event.data ->> 'amount_minor';
  v_currency text := upper(p_event.data ->> 'currency');
  v_transaction_id uuid;
  v_transaction commerce.payment_transactions;
  v_movement commerce.provider_money_movements;
  v_target_status text;
  v_error text;
begin
  -- A provider reference bound by the trusted API path is authoritative;
  -- mutable Stripe metadata is only a candidate when no binding exists yet.
  if p_event.object_reference is not null then
    select * into v_intent from commerce.payment_intents i
    where i.provider = p_event.provider
      and i.provider_reference = p_event.object_reference for update;
  end if;
  if v_intent.id is null
     and v_metadata_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    select * into v_intent from commerce.payment_intents i
    where i.id = v_metadata_id::uuid and i.provider = p_event.provider for update;
  end if;

  if p_event.event_type = 'payment_intent.succeeded' then
    if coalesce(v_amount_minor, '') !~ '^[1-9][0-9]{0,11}$' then
      raise exception 'invalid Stripe capture amount';
    end if;
    v_amount := v_amount_minor::numeric
      / pg_catalog.power(10::numeric, private.stripe_currency_exponent(v_currency));
    v_movement := private.record_stripe_money_movement(
      p_event, 'capture', v_amount_minor, v_currency,
      case when v_intent.id is null then null else v_intent.order_id end,
      case when v_intent.currency = v_currency
                  and v_intent.provider_reference = p_event.object_reference
           then v_intent.id else null end,
      null
    );
    if v_intent.id is null or v_intent.provider_reference is null then
      return jsonb_build_object('status', 'received', 'outcome', 'unmatched_payment_intent',
                                'resource_type', 'provider_money_movement',
                                'resource_id', v_movement.id);
    end if;
    if v_movement.reconciliation_status = 'matched' then
      return jsonb_build_object('status', 'processed', 'outcome', 'captured',
                                'resource_type', 'payment_transaction',
                                'resource_id', v_movement.payment_transaction_id);
    end if;
    if v_intent.provider_reference <> p_event.object_reference then
      perform private.require_reconciliation(
        v_movement.id, 'provider reference conflicts with payment intent',
        v_intent.order_id, null, null
      );
      return jsonb_build_object('status', 'processed', 'outcome', 'action_required',
                                'resource_type', 'provider_money_movement',
                                'resource_id', v_movement.id);
    end if;
    if (v_intent.amount, v_intent.currency)
       is distinct from (v_amount, v_currency) then
      v_error := format('provider capture %s %s does not match intent %s %s',
                        v_amount, v_currency, v_intent.amount, v_intent.currency);
      perform private.require_reconciliation(
        v_movement.id, v_error, v_intent.order_id,
        case when v_intent.currency = v_currency then v_intent.id else null end,
        null
      );
      return jsonb_build_object('status', 'processed', 'outcome', 'action_required',
                                'resource_type', 'provider_money_movement',
                                'resource_id', v_movement.id);
    end if;
    select * into v_transaction from commerce.payment_transactions t
    where t.payment_intent_id = v_intent.id and t.kind = 'capture'
      and t.status = 'succeeded' and t.provider_reference = p_event.object_reference
    order by t.created_at, t.id limit 1;
    if found then
      update commerce.provider_money_movements m
      set order_id = v_intent.order_id, payment_intent_id = v_intent.id,
          payment_transaction_id = v_transaction.id,
          reconciliation_status = 'matched', matched_at = now(), last_error = null
      where m.id = v_movement.id;
      return jsonb_build_object('status', 'processed', 'outcome', 'captured',
                                'resource_type', 'payment_transaction',
                                'resource_id', v_transaction.id);
    end if;

    begin
      select (public.capture_payment_intent(
        v_intent.id, p_event.object_reference, p_event.provider_event_id, p_event.data
      ) ->> 'id')::uuid into v_transaction_id;
      update commerce.provider_money_movements m
      set order_id = v_intent.order_id, payment_intent_id = v_intent.id,
          payment_transaction_id = v_transaction_id,
          reconciliation_status = 'matched', matched_at = now(), last_error = null
      where m.id = v_movement.id;
      return jsonb_build_object('status', 'processed', 'outcome', 'captured',
                                'resource_type', 'payment_transaction',
                                'resource_id', v_transaction_id);
    exception when others then
      v_error := sqlerrm;
      perform private.require_reconciliation(
        v_movement.id, v_error, v_intent.order_id, v_intent.id, null
      );
      return jsonb_build_object('status', 'processed', 'outcome', 'action_required',
                                'resource_type', 'provider_money_movement',
                                'resource_id', v_movement.id);
    end;
  end if;

  if v_intent.id is null then
    return jsonb_build_object('status', 'received', 'outcome', 'unmatched_payment_intent');
  end if;
  if p_event.object_reference is null then raise exception 'payment event has no object reference'; end if;
  if v_intent.provider_reference is null then
    return jsonb_build_object('status', 'received', 'outcome', 'unbound_payment_event',
                              'resource_type', 'payment_intent', 'resource_id', v_intent.id);
  elsif v_intent.provider_reference <> p_event.object_reference then
    return jsonb_build_object('status', 'ignored', 'outcome', 'payment_reference_mismatch',
                              'resource_type', 'payment_intent', 'resource_id', v_intent.id);
  end if;

  if v_intent.status in ('succeeded', 'failed', 'cancelled') then
    return jsonb_build_object('status', 'ignored', 'outcome', 'stale_payment_event',
                              'resource_type', 'payment_intent', 'resource_id', v_intent.id);
  end if;
  if exists (
    select 1 from commerce.payment_provider_events e
    where e.provider = p_event.provider
      and e.object_reference = p_event.object_reference
      and e.id <> p_event.id
      and e.status in ('processed', 'ignored')
      and e.event_type in (
        'payment_intent.processing', 'payment_intent.requires_action',
        'payment_intent.payment_failed', 'payment_intent.canceled'
      )
      and (
        e.occurred_at > p_event.occurred_at
        or (
          e.occurred_at = p_event.occurred_at
          and case e.event_type
                when 'payment_intent.canceled' then 4
                when 'payment_intent.payment_failed' then 3
                when 'payment_intent.requires_action' then 2
                else 1
              end
              >= case p_event.event_type
                   when 'payment_intent.canceled' then 4
                   when 'payment_intent.payment_failed' then 3
                   when 'payment_intent.requires_action' then 2
                   else 1
                 end
        )
      )
  ) then
    return jsonb_build_object('status', 'ignored', 'outcome', 'stale_payment_event',
                              'resource_type', 'payment_intent', 'resource_id', v_intent.id);
  end if;

  if p_event.event_type = 'payment_intent.processing' then
    v_target_status := 'processing';
  elsif p_event.event_type = 'payment_intent.requires_action' then
    v_target_status := 'requires_action';
  elsif p_event.event_type = 'payment_intent.payment_failed' then
    v_target_status := 'requires_payment_method';
  elsif p_event.event_type = 'payment_intent.canceled' then
    v_target_status := 'cancelled';
  else
    return jsonb_build_object('status', 'ignored', 'outcome', 'unsupported_payment_event');
  end if;

  if v_intent.status not in ('succeeded', 'failed', 'cancelled')
     and v_intent.status <> v_target_status then
    update commerce.payment_intents set status = v_target_status where id = v_intent.id;
  end if;
  if p_event.event_type = 'payment_intent.payment_failed' then
    insert into commerce.payment_transactions (
      order_id, payment_intent_id, provider, kind, status, amount, currency,
      provider_reference, idempotency_key, failure_code, failure_message,
      metadata, processed_at
    ) values (
      v_intent.order_id, v_intent.id, v_intent.provider, 'capture', 'failed',
      v_intent.amount, v_intent.currency, p_event.object_reference,
      p_event.provider_event_id, left(p_event.data ->> 'failure_code', 200),
      null, p_event.data, now()
    ) on conflict (provider, idempotency_key) where idempotency_key is not null do nothing;
  end if;
  return jsonb_build_object('status', 'processed', 'outcome', v_target_status,
                            'resource_type', 'payment_intent', 'resource_id', v_intent.id);
end;
$$;

-- Refund metadata is mutable at Stripe. Correlate the Refund object to the
-- captured PaymentIntent/Charge as well as to the local refund request.
create or replace function private.process_stripe_refund_event(
  p_event commerce.payment_provider_events
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request commerce.refund_requests;
  v_metadata_id text := p_event.data -> 'metadata' ->> 'tera_refund_request_id';
  v_status text := lower(p_event.data ->> 'status');
  v_amount numeric(20, 8);
  v_amount_minor text := p_event.data ->> 'amount_minor';
  v_currency text := upper(p_event.data ->> 'currency');
  v_movement commerce.provider_money_movements;
  v_refund_id uuid;
  v_transaction_id uuid;
  v_parent_reference text;
  v_parent_mismatch boolean := false;
  v_error text;
begin
  if coalesce(v_amount_minor, '') !~ '^[1-9][0-9]{0,11}$' then
    raise exception 'invalid Stripe refund amount';
  end if;
  v_amount := v_amount_minor::numeric
    / pg_catalog.power(10::numeric, private.stripe_currency_exponent(v_currency));
  if p_event.object_reference is not null then
    select * into v_request from commerce.refund_requests r
    where r.provider = p_event.provider
      and r.provider_reference = p_event.object_reference for update;
  end if;
  if v_request.id is null
     and v_metadata_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    select * into v_request from commerce.refund_requests r
    where r.id = v_metadata_id::uuid and r.provider = p_event.provider for update;
  end if;

  if v_request.id is not null then
    select t.provider_reference into v_parent_reference
    from commerce.payment_transactions t
    where t.id = v_request.parent_transaction_id;
    v_parent_mismatch := case
      when v_parent_reference like 'pi\_%' escape '\'
        then coalesce(p_event.data ->> 'payment_intent_reference', '') <> v_parent_reference
      when v_parent_reference like 'ch\_%' escape '\'
        then coalesce(p_event.data ->> 'charge_reference', '') <> v_parent_reference
      else true
    end;
  end if;

  if v_status = 'succeeded' then
    v_movement := private.record_stripe_money_movement(
      p_event, 'refund', v_amount_minor, v_currency,
      case when v_request.id is null then null else v_request.order_id end,
      null,
      case when v_request.currency = v_currency
                  and v_request.provider_reference = p_event.object_reference
           then v_request.id else null end
    );
    if v_request.id is null then
      return jsonb_build_object('status', 'received', 'outcome', 'unmatched_refund',
                                'resource_type', 'provider_money_movement',
                                'resource_id', v_movement.id);
    end if;
    if v_movement.reconciliation_status = 'matched' then
      return jsonb_build_object('status', 'processed', 'outcome', 'refunded',
                                'resource_type', 'refund_request',
                                'resource_id', v_request.id);
    end if;
    if v_parent_mismatch then
      perform private.require_reconciliation(
        v_movement.id, 'provider refund parent reference mismatch',
        v_request.order_id, null, null
      );
      return jsonb_build_object('status', 'processed', 'outcome', 'action_required',
                                'resource_type', 'provider_money_movement',
                                'resource_id', v_movement.id);
    end if;
    if v_request.provider_reference is null then
      return jsonb_build_object('status', 'received', 'outcome', 'unmatched_refund',
                                'resource_type', 'provider_money_movement',
                                'resource_id', v_movement.id);
    end if;
    if v_request.provider_reference <> p_event.object_reference then
      perform private.require_reconciliation(
        v_movement.id, 'provider refund reference mismatch',
        v_request.order_id, null, null
      );
      return jsonb_build_object('status', 'processed', 'outcome', 'action_required',
                                'resource_type', 'provider_money_movement',
                                'resource_id', v_movement.id);
    end if;
    if (v_request.amount, v_request.currency)
       is distinct from (v_amount, v_currency) then
      perform private.require_reconciliation(
        v_movement.id, 'provider refund amount or currency mismatch',
        v_request.order_id, null,
        case when v_request.currency = v_currency then v_request.id else null end
      );
      return jsonb_build_object('status', 'processed', 'outcome', 'action_required',
                                'resource_type', 'provider_money_movement',
                                'resource_id', v_movement.id);
    end if;
    begin
      v_refund_id := private.finalize_refund_request(v_request.id, p_event, p_event.data);
      select r.payment_transaction_id into v_transaction_id
      from commerce.refunds r where r.id = v_refund_id;
      update commerce.provider_money_movements m
      set order_id = v_request.order_id, refund_request_id = v_request.id,
          payment_transaction_id = v_transaction_id,
          reconciliation_status = 'matched', matched_at = now(), last_error = null
      where m.id = v_movement.id;
      return jsonb_build_object('status', 'processed', 'outcome', 'refunded',
                                'resource_type', 'refund_request',
                                'resource_id', v_request.id);
    exception when others then
      v_error := sqlerrm;
      perform private.require_reconciliation(
        v_movement.id, v_error, v_request.order_id, null, v_request.id
      );
      return jsonb_build_object('status', 'processed', 'outcome', 'action_required',
                                'resource_type', 'provider_money_movement',
                                'resource_id', v_movement.id);
    end;
  end if;

  if v_request.id is null then
    return jsonb_build_object('status', 'received', 'outcome', 'unmatched_refund');
  end if;
  if v_parent_mismatch then
    return jsonb_build_object('status', 'ignored', 'outcome', 'refund_parent_mismatch',
                              'resource_type', 'refund_request', 'resource_id', v_request.id);
  end if;
  if v_request.provider_reference is null then
    return jsonb_build_object('status', 'received', 'outcome', 'unbound_refund_event',
                              'resource_type', 'refund_request', 'resource_id', v_request.id);
  elsif v_request.provider_reference <> p_event.object_reference then
    return jsonb_build_object('status', 'ignored', 'outcome', 'refund_reference_mismatch',
                              'resource_type', 'refund_request', 'resource_id', v_request.id);
  end if;
  if (v_request.amount, v_request.currency)
     is distinct from (v_amount, v_currency) then
    raise exception 'provider refund amount or currency mismatch';
  end if;
  if v_request.status in ('succeeded', 'failed', 'cancelled') then
    return jsonb_build_object('status', 'ignored', 'outcome', 'stale_refund_event',
                              'resource_type', 'refund_request', 'resource_id', v_request.id);
  end if;
  if exists (
    select 1 from commerce.payment_provider_events e
    where e.provider = p_event.provider
      and e.object_reference = p_event.object_reference
      and e.id <> p_event.id
      and e.status in ('processed', 'ignored')
      and lower(e.data ->> 'status') in (
        'pending', 'requires_action', 'failed', 'canceled', 'cancelled'
      )
      and (
        e.occurred_at > p_event.occurred_at
        or (
          e.occurred_at = p_event.occurred_at
          and case lower(e.data ->> 'status')
                when 'failed' then 3
                when 'canceled' then 3
                when 'cancelled' then 3
                when 'requires_action' then 2
                else 1
              end
              >= case v_status
                   when 'failed' then 3
                   when 'canceled' then 3
                   when 'cancelled' then 3
                   when 'requires_action' then 2
                   else 1
                 end
        )
      )
  ) then
    return jsonb_build_object('status', 'ignored', 'outcome', 'stale_refund_event',
                              'resource_type', 'refund_request', 'resource_id', v_request.id);
  end if;

  if v_status = 'pending' then
    update commerce.refund_requests set status = 'processing'
    where id = v_request.id and status in ('requested', 'submitted', 'requires_action');
  elsif v_status = 'requires_action' then
    update commerce.refund_requests set status = 'requires_action'
    where id = v_request.id and status in ('requested', 'submitted', 'processing');
  elsif v_status in ('failed', 'canceled', 'cancelled') then
    update commerce.refund_requests
    set status = case when v_status = 'failed' then 'failed' else 'cancelled' end,
        failure_code = left(p_event.data ->> 'failure_code', 200),
        failure_message = null,
        processed_at = now()
    where id = v_request.id and status not in ('succeeded', 'failed', 'cancelled');
  else
    return jsonb_build_object('status', 'ignored', 'outcome', 'unsupported_refund_status');
  end if;
  return jsonb_build_object('status', 'processed', 'outcome', v_status,
                            'resource_type', 'refund_request', 'resource_id', v_request.id);
end;
$$;

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
  if auth.role() <> 'service_role' then raise exception 'service role only'; end if;
  if max_intents is null or max_intents not between 1 and 100 then
    raise exception 'max_intents must be between 1 and 100';
  end if;
  if as_of is null then raise exception 'as_of is required'; end if;

  for v_id in
    select i.id
    from commerce.payment_intents i
    join public.orders o on o.id = i.order_id
    where i.provider = 'stripe'
      and i.provider_reference is not null
      and i.status in ('requires_payment_method', 'requires_action', 'processing')
      and i.provider_terminal_status is null
      and i.provider_cancel_attempts < 100
      and (i.expires_at <= as_of or o.status = 'cancelled')
      and (
        i.provider_cancel_claimed_at is null
        or i.provider_cancel_claimed_at <= clock_timestamp() - interval '5 minutes'
      )
    order by coalesce(i.expires_at, o.cancelled_at, i.created_at), i.id
    for update of i skip locked
    limit max_intents
  loop
    update commerce.payment_intents i
    set provider_cancel_claimed_at = clock_timestamp(),
        provider_cancel_attempts = i.provider_cancel_attempts + 1,
        provider_cancel_last_error = null
    where i.id = v_id
    returning * into v_intent;
    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'id', v_intent.id,
      'order_id', v_intent.order_id,
      'provider_reference', v_intent.provider_reference,
      'status', v_intent.status,
      'amount', v_intent.amount,
      'currency', v_intent.currency,
      'expires_at', v_intent.expires_at,
      'cancel_attempt', v_intent.provider_cancel_attempts
    ));
  end loop;
  return v_results;
end;
$$;

create or replace function public.complete_stripe_payment_intent_cancel(
  payment_intent_id uuid,
  succeeded boolean,
  error_code text default null,
  provider_status text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent commerce.payment_intents;
  v_error text := lower(btrim(error_code));
  v_provider_status text := lower(btrim(provider_status));
begin
  if auth.role() <> 'service_role' then raise exception 'service role only'; end if;
  if succeeded is null then raise exception 'succeeded is required'; end if;
  if succeeded and coalesce(v_provider_status, '') not in ('succeeded', 'canceled') then
    raise exception 'terminal provider_status is required';
  end if;
  if not succeeded and (
    coalesce(v_error, '') = '' or v_error !~ '^[a-z0-9_:-]{1,200}$'
    or v_provider_status is not null
  ) then
    raise exception 'safe error_code is required for a failed attempt';
  end if;
  select * into v_intent from commerce.payment_intents i
  where i.id = complete_stripe_payment_intent_cancel.payment_intent_id
    and i.provider = 'stripe' for update;
  if not found then raise exception 'Stripe payment intent not found'; end if;
  if v_intent.provider_terminal_status is not null and (
    not succeeded or v_intent.provider_terminal_status <> v_provider_status
  ) then
    raise exception 'Stripe provider terminal status is immutable';
  end if;
  update commerce.payment_intents i
  set provider_cancel_claimed_at = case when succeeded then null else clock_timestamp() end,
      provider_cancel_last_error = case when succeeded then null else v_error end,
      provider_terminal_status = case when succeeded
                                      then coalesce(i.provider_terminal_status, v_provider_status)
                                      else i.provider_terminal_status end,
      provider_terminal_observed_at = case when succeeded
                                           then coalesce(i.provider_terminal_observed_at,
                                                         clock_timestamp())
                                           else i.provider_terminal_observed_at end
  where i.id = v_intent.id
  returning * into v_intent;
  if not succeeded then
    perform private.enqueue_outbox_event(
      'payment_intent', v_intent.id, 'stripe.payment_intent_cancel_failed',
      jsonb_build_object(
        'payment_intent_id', v_intent.id,
        'order_id', v_intent.order_id,
        'provider_reference', v_intent.provider_reference,
        'cancel_attempt', v_intent.provider_cancel_attempts,
        'error_code', v_intent.provider_cancel_last_error
      ),
      'stripe-payment-intent:' || v_intent.id
        || ':cancel-failed:' || v_intent.provider_cancel_attempts
    );
  end if;
  return jsonb_build_object(
    'id', v_intent.id,
    'status', v_intent.status,
    'provider_reference', v_intent.provider_reference,
    'cancel_attempts', v_intent.provider_cancel_attempts,
    'last_error', v_intent.provider_cancel_last_error,
    'provider_terminal_status', v_intent.provider_terminal_status
  );
end;
$$;

revoke all on function private.validate_provider_money_movement()
from public, anon, authenticated, service_role;
revoke all on function private.stripe_currency_exponent(text)
from public, anon, authenticated, service_role;
revoke all on function private.record_stripe_money_movement(
  commerce.payment_provider_events, text, text, text, uuid, uuid, uuid
) from public, anon, authenticated, service_role;
revoke all on function private.process_stripe_payment_event(commerce.payment_provider_events)
from public, anon, authenticated, service_role;
revoke all on function private.process_stripe_refund_event(commerce.payment_provider_events)
from public, anon, authenticated, service_role;

revoke all on function public.claim_expired_stripe_payment_intents(integer, timestamptz)
from public, anon, authenticated, service_role;
revoke all on function public.complete_stripe_payment_intent_cancel(uuid, boolean, text, text)
from public, anon, authenticated, service_role;
grant execute on function public.claim_expired_stripe_payment_intents(integer, timestamptz)
to service_role;
grant execute on function public.complete_stripe_payment_intent_cancel(uuid, boolean, text, text)
to service_role;

commit;
