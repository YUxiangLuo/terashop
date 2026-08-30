-- ============================================================
-- PayPal Orders v2 / Payments v2 支付边界
-- - PayPal Order ID 绑定内部 PaymentIntent；Capture ID 作为实际资金交易 reference
-- - 已验证 Webhook/API 响应复用 Provider Inbox、外部资金事实和异步退款状态机
-- - PAYMENT.CAPTURE.REVERSED 只记录外部资金异常并告警，不伪造本地退款
-- ============================================================

-- ============================================================
-- A. PayPal Edge Function 所需的 service-only DTO
-- ============================================================
create or replace function private.provider_payment_intent_json(
  p_intent commerce.payment_intents
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.payment_intent_json(p_intent) || jsonb_build_object(
    'order_number', o.order_number,
    'shipping_address', o.shipping_address
  )
  from public.orders o where o.id = p_intent.order_id;
$$;

create or replace function public.create_payment_intent_for_customer(
  order_id uuid,
  customer_id uuid,
  provider text,
  idempotency_key text,
  metadata jsonb default '{}'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent commerce.payment_intents;
begin
  if auth.role() <> 'service_role' then raise exception 'service role only'; end if;
  if not exists (
    select 1 from public.orders o
    where o.id = create_payment_intent_for_customer.order_id
      and o.customer_id = create_payment_intent_for_customer.customer_id
  ) then
    raise exception 'payable order not found for customer';
  end if;
  perform public.create_payment_intent(
    create_payment_intent_for_customer.order_id,
    create_payment_intent_for_customer.provider,
    create_payment_intent_for_customer.idempotency_key,
    coalesce(create_payment_intent_for_customer.metadata, '{}'::jsonb)
      || jsonb_build_object('customer_id', create_payment_intent_for_customer.customer_id)
  );
  select * into v_intent from commerce.payment_intents i
  where i.provider = lower(btrim(create_payment_intent_for_customer.provider))
    and i.idempotency_key = btrim(create_payment_intent_for_customer.idempotency_key);
  return private.provider_payment_intent_json(v_intent);
end;
$$;

create or replace function public.get_payment_intent_for_customer(
  payment_intent_id uuid,
  customer_id uuid,
  provider text
)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_intent commerce.payment_intents;
begin
  if auth.role() <> 'service_role' then raise exception 'service role only'; end if;
  select i.* into v_intent
  from commerce.payment_intents i
  join public.orders o on o.id = i.order_id
  where i.id = get_payment_intent_for_customer.payment_intent_id
    and i.provider = lower(btrim(get_payment_intent_for_customer.provider))
    and o.customer_id = get_payment_intent_for_customer.customer_id;
  if not found then raise exception 'payment intent not found for customer'; end if;
  return private.provider_payment_intent_json(v_intent);
end;
$$;

alter table commerce.refund_requests
  add column last_provider_poll_at timestamptz,
  add column provider_poll_attempts integer not null default 0
    check (provider_poll_attempts >= 0);

create index refund_requests_provider_poll_idx
  on commerce.refund_requests
    (provider, coalesce(last_provider_poll_at, created_at), created_at, id)
  where provider_reference is not null
    and status in ('submitted', 'processing', 'requires_action');

create or replace function public.list_pending_provider_refunds(
  provider text,
  max_requests integer default 50
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = ''
as $$
declare
  v_provider text := lower(btrim(provider));
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then raise exception 'service role only'; end if;
  if coalesce(v_provider, '') = '' then raise exception 'provider is required'; end if;
  if max_requests is null or max_requests not between 1 and 100 then
    raise exception 'max_requests must be between 1 and 100';
  end if;
  with candidates as materialized (
    select candidate.id
    from commerce.refund_requests candidate
    where candidate.provider = v_provider
      and candidate.provider_reference is not null
      and candidate.status in ('submitted', 'processing', 'requires_action')
      and (candidate.last_provider_poll_at is null
           or candidate.last_provider_poll_at < clock_timestamp() - interval '5 minutes')
    order by coalesce(candidate.last_provider_poll_at, candidate.created_at),
             candidate.created_at, candidate.id
    for update skip locked
    limit max_requests
  ), claimed as (
    update commerce.refund_requests r
    set last_provider_poll_at = clock_timestamp(),
        provider_poll_attempts = r.provider_poll_attempts + 1
    from candidates c
    where r.id = c.id
    returning r.id
  )
  select coalesce(
    jsonb_agg(private.refund_request_json(r) order by r.created_at, r.id),
    '[]'::jsonb
  ) into v_result
  from claimed c
  join commerce.refund_requests r on r.id = c.id;
  return v_result;
end;
$$;

-- 未解决的渠道 reversal 表示资金已被 PayPal 撤回，不能继续从同一 capture 发起退款。
create or replace function private.prevent_refund_after_provider_reversal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from commerce.payment_transactions t
    join commerce.provider_money_movements m
      on m.provider = t.provider
     and m.kind = 'refund'
     and m.provider_reference = t.provider_reference
     and m.reconciliation_status = 'action_required'
     and m.refund_request_id is null
    where t.id = new.parent_transaction_id
  ) then
    raise exception 'capture has an unresolved provider reversal';
  end if;
  return new;
end;
$$;

create trigger refund_requests_provider_reversal_guard
  before insert on commerce.refund_requests
  for each row execute function private.prevent_refund_after_provider_reversal();

-- ============================================================
-- B. PayPal 事件金额、Capture、退款与 reversal 处理
-- ============================================================
create or replace function private.provider_decimal_amount(
  p_amount text,
  p_currency text
)
returns numeric
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  v_amount numeric(12, 2);
begin
  if upper(btrim(p_currency)) !~ '^[A-Z]{3}$' then
    raise exception 'provider currency code is invalid';
  end if;
  if p_amount !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$' then
    raise exception 'provider amount must be a positive decimal with at most two places';
  end if;
  v_amount := p_amount::numeric;
  if v_amount <= 0 then raise exception 'provider amount must be positive'; end if;
  return v_amount;
end;
$$;

create or replace function private.process_paypal_payment_event(
  p_event commerce.payment_provider_events
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent commerce.payment_intents;
  v_capture commerce.payment_transactions;
  v_reversal commerce.provider_money_movements;
  v_metadata_id text := p_event.data -> 'metadata' ->> 'tera_payment_intent_id';
  v_order_reference text := nullif(p_event.data ->> 'order_reference', '');
  v_status text := lower(p_event.data ->> 'status');
  v_amount numeric(12, 2);
  v_currency text := upper(p_event.data ->> 'currency');
  v_transaction_id uuid;
  v_movement commerce.provider_money_movements;
  v_error text;
begin
  if p_event.event_type = 'PAYMENT.CAPTURE.REFUNDED' then
    perform private.enqueue_outbox_event(
      'provider_event', p_event.id, 'paypal.refund_reconciliation_requested',
      jsonb_build_object(
        'provider_event_id', p_event.provider_event_id,
        'capture_reference', p_event.object_reference,
        'order_reference', v_order_reference
      ),
      'paypal-refund-reconcile:' || p_event.provider_event_id
    );
    return jsonb_build_object('status', 'processed',
                              'outcome', 'refund_reconciliation_requested');
  end if;

  v_amount := private.provider_decimal_amount(p_event.data ->> 'amount', v_currency);
  if v_metadata_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    select * into v_intent from commerce.payment_intents i
    where i.id = v_metadata_id::uuid and i.provider = 'paypal' for update;
  end if;
  if v_intent.id is null and v_order_reference is not null then
    select * into v_intent from commerce.payment_intents i
    where i.provider = 'paypal' and i.provider_reference = v_order_reference for update;
  end if;
  if v_intent.id is null and p_event.object_reference is not null then
    select i.* into v_intent
    from commerce.payment_transactions t
    join commerce.payment_intents i on i.id = t.payment_intent_id
    where t.provider = 'paypal' and t.kind = 'capture'
      and t.provider_reference = p_event.object_reference
    order by t.created_at, t.id limit 1
    for update of i;
  end if;

  if v_status = 'reversed' or p_event.event_type = 'PAYMENT.CAPTURE.REVERSED' then
    select * into v_capture from commerce.payment_transactions t
    where t.provider = 'paypal' and t.kind = 'capture' and t.status = 'succeeded'
      and t.provider_reference = p_event.object_reference
    order by t.created_at, t.id limit 1;
    v_movement := private.record_provider_money_movement(
      p_event, 'refund', v_amount, v_currency,
      case when v_capture.id is null then null else v_capture.order_id end,
      null, null
    );
    if v_capture.id is null then
      if v_movement.reconciliation_status = 'action_required'
         and v_movement.order_id is not null then
        return jsonb_build_object('status', 'processed', 'outcome', 'action_required',
                                  'resource_type', 'provider_money_movement',
                                  'resource_id', v_movement.id);
      end if;
      return jsonb_build_object('status', 'received', 'outcome', 'unmatched_reversal',
                                'resource_type', 'provider_money_movement',
                                'resource_id', v_movement.id);
    end if;
    perform private.require_reconciliation(
      v_movement.id, 'PayPal reversed a succeeded capture', v_capture.order_id, null, null
    );
    return jsonb_build_object('status', 'processed', 'outcome', 'action_required',
                              'resource_type', 'provider_money_movement',
                              'resource_id', v_movement.id);
  end if;

  if v_status = 'completed' then
    v_movement := private.record_provider_money_movement(
      p_event, 'capture', v_amount, v_currency,
      case when v_intent.id is null then null else v_intent.order_id end,
      case when v_intent.currency = v_currency then v_intent.id else null end,
      null
    );
    if v_intent.id is null then
      return jsonb_build_object('status', 'received', 'outcome', 'unmatched_payment_intent',
                                'resource_type', 'provider_money_movement',
                                'resource_id', v_movement.id);
    end if;
    if v_movement.reconciliation_status = 'matched' then
      return jsonb_build_object('status', 'processed', 'outcome', 'captured',
                                'resource_type', 'payment_transaction',
                                'resource_id', v_movement.payment_transaction_id);
    end if;
    select * into v_reversal
    from commerce.provider_money_movements reversal
    where reversal.provider = 'paypal'
      and reversal.kind = 'refund'
      and reversal.provider_reference = p_event.object_reference
      and reversal.refund_request_id is null
    order by reversal.created_at, reversal.id
    limit 1;
    if found then
      perform private.require_reconciliation(
        v_reversal.id, 'PayPal reversal arrived before local capture reconciliation',
        v_intent.order_id, null, null
      );
      perform private.require_reconciliation(
        v_movement.id, 'PayPal capture already has a provider reversal',
        v_intent.order_id,
        case when v_intent.currency = v_currency then v_intent.id else null end,
        null
      );
      return jsonb_build_object('status', 'processed', 'outcome', 'action_required',
                                'resource_type', 'provider_money_movement',
                                'resource_id', v_movement.id);
    end if;
    if (v_intent.amount, v_intent.currency) is distinct from (v_amount, v_currency) then
      perform private.require_reconciliation(
        v_movement.id, 'PayPal capture amount or currency mismatch',
        v_intent.order_id,
        case when v_intent.currency = v_currency then v_intent.id else null end,
        null
      );
      return jsonb_build_object('status', 'processed', 'outcome', 'action_required',
                                'resource_type', 'provider_money_movement',
                                'resource_id', v_movement.id);
    end if;
    if v_order_reference is not null then
      if v_intent.provider_reference is null then
        update commerce.payment_intents set provider_reference = v_order_reference
        where id = v_intent.id;
      elsif v_intent.provider_reference <> v_order_reference then
        perform private.require_reconciliation(
          v_movement.id, 'PayPal Order reference conflicts with payment intent',
          v_intent.order_id, v_intent.id, null
        );
        return jsonb_build_object('status', 'processed', 'outcome', 'action_required',
                                  'resource_type', 'provider_money_movement',
                                  'resource_id', v_movement.id);
      end if;
    end if;

    select * into v_capture from commerce.payment_transactions t
    where t.payment_intent_id = v_intent.id and t.kind = 'capture'
      and t.status = 'succeeded' and t.provider_reference = p_event.object_reference
    order by t.created_at, t.id limit 1;
    if found then
      update commerce.provider_money_movements m
      set order_id = v_intent.order_id, payment_intent_id = v_intent.id,
          payment_transaction_id = v_capture.id,
          reconciliation_status = 'matched', matched_at = now(), last_error = null
      where m.id = v_movement.id;
      return jsonb_build_object('status', 'processed', 'outcome', 'captured',
                                'resource_type', 'payment_transaction',
                                'resource_id', v_capture.id);
    end if;

    begin
      select (public.capture_payment_intent(
        v_intent.id, p_event.object_reference,
        p_event.provider_event_id, p_event.data
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
  if (v_intent.amount, v_intent.currency) is distinct from (v_amount, v_currency) then
    raise exception 'PayPal capture amount or currency mismatch';
  end if;
  if v_order_reference is not null then
    if v_intent.provider_reference is null then
      update commerce.payment_intents set provider_reference = v_order_reference
      where id = v_intent.id;
    elsif v_intent.provider_reference <> v_order_reference then
      raise exception 'PayPal Order reference conflicts with payment intent';
    end if;
  end if;
  if v_intent.status in ('succeeded', 'failed', 'cancelled') then
    return jsonb_build_object('status', 'ignored', 'outcome', 'stale_payment_event',
                              'resource_type', 'payment_intent', 'resource_id', v_intent.id);
  end if;

  if v_status = 'pending' then
    update commerce.payment_intents set status = 'processing'
    where id = v_intent.id and status <> 'processing';
    return jsonb_build_object('status', 'processed', 'outcome', 'processing',
                              'resource_type', 'payment_intent', 'resource_id', v_intent.id);
  elsif v_status in ('declined', 'denied', 'failed') then
    update commerce.payment_intents set status = 'failed' where id = v_intent.id;
    insert into commerce.payment_transactions (
      order_id, payment_intent_id, provider, kind, status, amount, currency,
      provider_reference, idempotency_key, failure_code, failure_message,
      metadata, processed_at
    ) values (
      v_intent.order_id, v_intent.id, 'paypal', 'capture', 'failed',
      v_intent.amount, v_intent.currency, p_event.object_reference,
      p_event.provider_event_id, left(p_event.data ->> 'failure_code', 200),
      left(p_event.data ->> 'failure_message', 2000), p_event.data, now()
    ) on conflict (provider, idempotency_key) where idempotency_key is not null do nothing;
    return jsonb_build_object('status', 'processed', 'outcome', 'failed',
                              'resource_type', 'payment_intent', 'resource_id', v_intent.id);
  end if;
  return jsonb_build_object('status', 'ignored', 'outcome', 'unsupported_payment_status');
end;
$$;

create or replace function private.process_paypal_refund_event(
  p_event commerce.payment_provider_events
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request commerce.refund_requests;
  v_parent commerce.payment_transactions;
  v_metadata_id text := p_event.data -> 'metadata' ->> 'tera_refund_request_id';
  v_capture_reference text := nullif(p_event.data ->> 'capture_reference', '');
  v_status text := lower(p_event.data ->> 'status');
  v_amount numeric(12, 2);
  v_currency text := upper(p_event.data ->> 'currency');
  v_movement commerce.provider_money_movements;
  v_refund_id uuid;
  v_transaction_id uuid;
  v_error text;
begin
  v_amount := private.provider_decimal_amount(p_event.data ->> 'amount', v_currency);
  if v_metadata_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    select * into v_request from commerce.refund_requests r
    where r.id = v_metadata_id::uuid and r.provider = 'paypal' for update;
  end if;
  if v_request.id is null and p_event.object_reference is not null then
    select * into v_request from commerce.refund_requests r
    where r.provider = 'paypal' and r.provider_reference = p_event.object_reference
    for update;
  end if;

  if v_request.id is not null and v_capture_reference is not null then
    select * into v_parent from commerce.payment_transactions t
    where t.id = v_request.parent_transaction_id;
    if v_parent.provider_reference is distinct from v_capture_reference then
      raise exception 'PayPal refund capture reference mismatch';
    end if;
  end if;

  if v_status = 'completed' then
    v_movement := private.record_provider_money_movement(
      p_event, 'refund', v_amount, v_currency,
      case when v_request.id is null then null else v_request.order_id end,
      null,
      case when v_request.currency = v_currency then v_request.id else null end
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
    if (v_request.amount, v_request.currency) is distinct from (v_amount, v_currency) then
      perform private.require_reconciliation(
        v_movement.id, 'PayPal refund amount or currency mismatch',
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
  if (v_request.amount, v_request.currency) is distinct from (v_amount, v_currency) then
    raise exception 'PayPal refund amount or currency mismatch';
  end if;
  if v_request.status in ('succeeded', 'failed', 'cancelled') then
    return jsonb_build_object('status', 'ignored', 'outcome', 'stale_refund_event',
                              'resource_type', 'refund_request', 'resource_id', v_request.id);
  end if;
  if v_request.provider_reference is null then
    update commerce.refund_requests
    set provider_reference = p_event.object_reference,
        submitted_at = coalesce(submitted_at, now())
    where id = v_request.id;
  elsif v_request.provider_reference <> p_event.object_reference then
    raise exception 'PayPal refund reference mismatch';
  end if;

  if v_status = 'pending' then
    update commerce.refund_requests set status = 'processing'
    where id = v_request.id and status in ('requested', 'submitted', 'requires_action');
  elsif v_status = 'requires_action' then
    update commerce.refund_requests set status = 'requires_action'
    where id = v_request.id and status in ('requested', 'submitted', 'processing');
  elsif v_status in ('failed', 'cancelled', 'canceled') then
    update commerce.refund_requests
    set status = case when v_status = 'failed' then 'failed' else 'cancelled' end,
        failure_code = left(p_event.data ->> 'failure_code', 200),
        failure_message = left(p_event.data ->> 'failure_message', 2000),
        processed_at = now()
    where id = v_request.id and status not in ('succeeded', 'failed', 'cancelled');
  else
    return jsonb_build_object('status', 'ignored', 'outcome', 'unsupported_refund_status');
  end if;
  return jsonb_build_object('status', 'processed', 'outcome', v_status,
                            'resource_type', 'refund_request', 'resource_id', v_request.id);
end;
$$;

-- ============================================================
-- C. Provider Inbox dispatcher 加入 PayPal
-- ============================================================
create or replace function private.process_payment_provider_event(p_event_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event commerce.payment_provider_events;
  v_result jsonb;
  v_status text;
  v_resource_type text;
  v_resource_id uuid;
begin
  select * into v_event from commerce.payment_provider_events e
  where e.id = p_event_id for update;
  if not found then raise exception 'provider event not found'; end if;
  if v_event.status in ('processed', 'ignored') then
    return jsonb_build_object(
      'event_id', v_event.id, 'provider_event_id', v_event.provider_event_id,
      'status', v_event.status, 'outcome', v_event.outcome,
      'resource_type', v_event.resource_type, 'resource_id', v_event.resource_id
    );
  end if;
  update commerce.payment_provider_events set attempts = attempts + 1
  where id = v_event.id;

  begin
    if v_event.provider = 'stripe'
       and v_event.event_type like 'payment_intent.%' then
      v_result := private.process_stripe_payment_event(v_event);
    elsif v_event.provider = 'stripe'
          and v_event.event_type in ('refund.created', 'refund.updated', 'refund.failed', 'refund.api_result') then
      v_result := private.process_stripe_refund_event(v_event);
    elsif v_event.provider = 'paypal'
          and (v_event.event_type like 'PAYMENT.CAPTURE.%'
               or v_event.event_type = 'paypal.capture.api_result') then
      v_result := private.process_paypal_payment_event(v_event);
    elsif v_event.provider = 'paypal'
          and (v_event.event_type like 'PAYMENT.REFUND.%'
               or v_event.event_type = 'paypal.refund.api_result') then
      v_result := private.process_paypal_refund_event(v_event);
    else
      v_result := jsonb_build_object('status', 'ignored', 'outcome', 'unsupported_event');
    end if;
    v_status := v_result ->> 'status';
    v_resource_type := nullif(v_result ->> 'resource_type', '');
    v_resource_id := nullif(v_result ->> 'resource_id', '')::uuid;
    update commerce.payment_provider_events e
    set status = v_status,
        outcome = v_result ->> 'outcome',
        resource_type = v_resource_type,
        resource_id = v_resource_id,
        last_error = case when v_status = 'received' then v_result ->> 'outcome' else null end,
        processed_at = case when v_status in ('processed', 'ignored') then now() else null end
    where e.id = v_event.id returning * into v_event;
  exception when others then
    update commerce.payment_provider_events e
    set status = 'failed', last_error = left(sqlerrm, 4000), processed_at = null
    where e.id = v_event.id returning * into v_event;
  end;
  return jsonb_build_object(
    'event_id', v_event.id, 'provider_event_id', v_event.provider_event_id,
    'status', v_event.status, 'outcome', v_event.outcome,
    'resource_type', v_event.resource_type, 'resource_id', v_event.resource_id,
    'attempts', v_event.attempts, 'error', v_event.last_error
  );
end;
$$;

-- PayPal 的 Order ID 与实际 Capture ID 不相同；PaymentIntent 保留首次绑定的 Order ID。
create or replace function public.capture_payment_intent(
  payment_intent_id uuid,
  provider_reference text,
  idempotency_key text,
  raw jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent commerce.payment_intents;
  v_quote commerce.checkout_quotes;
  v_order public.orders;
  v_payment public.payments;
  v_transaction commerce.payment_transactions;
  v_key text := btrim(idempotency_key);
  v_reference text := btrim(provider_reference);
begin
  if auth.role() <> 'service_role' then raise exception 'service role only'; end if;
  if coalesce(v_key, '') = '' or coalesce(v_reference, '') = '' then
    raise exception 'provider_reference and idempotency_key are required';
  end if;
  select * into v_intent from commerce.payment_intents i
  where i.id = capture_payment_intent.payment_intent_id for update;
  if not found then raise exception 'payment intent not found'; end if;
  select * into v_quote from commerce.checkout_quotes q
  where q.order_id = v_intent.order_id for update;
  select * into v_transaction from commerce.payment_transactions t
  where t.provider = v_intent.provider and t.idempotency_key = v_key;
  if found then
    if v_transaction.payment_intent_id is distinct from v_intent.id
       or v_transaction.provider_reference is distinct from v_reference then
      raise exception 'idempotency key was used with different capture parameters';
    end if;
    return jsonb_build_object(
      'id', v_transaction.id, 'order_id', v_transaction.order_id,
      'payment_intent_id', v_transaction.payment_intent_id,
      'provider', v_transaction.provider, 'kind', v_transaction.kind,
      'status', v_transaction.status, 'amount', v_transaction.amount,
      'currency', v_transaction.currency,
      'provider_reference', v_transaction.provider_reference,
      'processed_at', v_transaction.processed_at
    );
  end if;
  if v_intent.status = 'succeeded' then raise exception 'payment intent is already captured'; end if;
  if v_intent.status not in ('requires_payment_method', 'requires_action', 'processing') then
    raise exception 'payment intent cannot be captured from status %', v_intent.status;
  end if;
  if v_intent.expires_at is not null and v_intent.expires_at <= clock_timestamp() then
    raise exception 'payment intent has expired';
  end if;
  select * into v_order from public.orders o where o.id = v_intent.order_id for update;
  if v_order.status <> 'open' or v_order.financial_status <> 'pending' then
    raise exception 'order is not payable';
  end if;
  if v_order.total <> v_intent.amount or v_order.currency <> v_intent.currency then
    raise exception 'order total changed after payment intent creation';
  end if;
  if v_quote.id is not null
     and (v_quote.status <> 'converted' or v_quote.expires_at <= clock_timestamp()) then
    raise exception 'checkout reservation is not active';
  end if;
  perform private.consume_order_reservation(v_order.id);
  insert into public.payments (
    order_id, provider, kind, status, amount, currency, provider_ref, raw,
    payment_intent_id, idempotency_key
  ) values (
    v_order.id, v_intent.provider, 'charge', 'succeeded', v_intent.amount,
    v_intent.currency, v_reference, raw, v_intent.id, v_key
  ) returning * into v_payment;
  select * into v_transaction from commerce.payment_transactions t
  where t.legacy_payment_id = v_payment.id;
  update commerce.payment_intents i
  set status = 'succeeded',
      provider_reference = case when i.provider = 'paypal'
        then i.provider_reference else v_reference end
  where i.id = v_intent.id;
  update public.orders
  set financial_status = 'paid', paid_at = now(),
      status = case when fulfillment_status = 'fulfilled' then 'completed' else status end,
      completed_at = case when fulfillment_status = 'fulfilled' then now() else completed_at end
  where id = v_order.id;
  insert into public.order_events (order_id, actor_id, type, data)
  values (v_order.id, null, 'payment_received',
          jsonb_build_object('provider', v_intent.provider,
                             'amount', v_intent.amount,
                             'payment_intent_id', v_intent.id,
                             'transaction_id', v_transaction.id,
                             'provider_event_id', v_key));
  return jsonb_build_object(
    'id', v_transaction.id, 'order_id', v_transaction.order_id,
    'payment_intent_id', v_transaction.payment_intent_id,
    'provider', v_transaction.provider, 'kind', v_transaction.kind,
    'status', v_transaction.status, 'amount', v_transaction.amount,
    'currency', v_transaction.currency,
    'provider_reference', v_transaction.provider_reference,
    'processed_at', v_transaction.processed_at
  );
end;
$$;

-- ============================================================
-- D. ACL：新查询仍仅允许可信 Edge Function / Worker
-- ============================================================
revoke all on function private.provider_payment_intent_json(commerce.payment_intents)
  from public, anon, authenticated, service_role;
revoke all on function private.prevent_refund_after_provider_reversal()
  from public, anon, authenticated, service_role;
revoke all on function private.provider_decimal_amount(text, text)
  from public, anon, authenticated, service_role;
revoke all on function private.process_paypal_payment_event(commerce.payment_provider_events)
  from public, anon, authenticated, service_role;
revoke all on function private.process_paypal_refund_event(commerce.payment_provider_events)
  from public, anon, authenticated, service_role;

revoke all on function public.get_payment_intent_for_customer(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.list_pending_provider_refunds(text, integer)
  from public, anon, authenticated;
grant execute on function public.get_payment_intent_for_customer(uuid, uuid, text)
  to service_role;
grant execute on function public.list_pending_provider_refunds(text, integer)
  to service_role;

-- create or replace 不改变既有 ACL；再次声明关键入口以防部署漂移。
revoke all on function public.create_payment_intent_for_customer(uuid, uuid, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.create_payment_intent_for_customer(uuid, uuid, text, text, jsonb)
  to service_role;
revoke all on function public.capture_payment_intent(uuid, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.capture_payment_intent(uuid, text, text, jsonb)
  to service_role;
