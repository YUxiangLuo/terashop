-- Payment intents, provider Inbox, external money facts and reconciliation
-- Cross-domain function references are resolved after all definitions are installed.
begin;
set local check_function_bodies = false;

CREATE FUNCTION private.finalize_refund_request(p_request_id uuid, p_event commerce.payment_provider_events) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_request commerce.refund_requests;
  v_order public.orders;
  v_line record;
  v_transaction commerce.payment_transactions;
  v_refund_id uuid;
  v_refunded numeric(12, 2);
begin
  select * into v_request from commerce.refund_requests r
  where r.id = p_request_id for update;
  if not found then raise exception 'refund request not found'; end if;
  if v_request.status = 'succeeded' then return v_request.result_refund_id; end if;
  if v_request.status in ('failed', 'cancelled') then
    raise exception 'refund request is terminal (%)', v_request.status;
  end if;
  if v_request.provider_reference is not null
     and v_request.provider_reference <> p_event.object_reference then
    raise exception 'provider refund reference mismatch';
  end if;
  select * into v_order from public.orders o where o.id = v_request.order_id for update;
  if v_request.restock_requested then
    perform private.lock_order_inventory(array[v_order.id]);
  end if;

  perform set_config('commerce.async_refund_finalize', 'on', true);
  perform set_config('commerce.refund_write', 'on', true);
  insert into commerce.payment_transactions (
    order_id, provider, kind, status, amount, currency,
    provider_reference, parent_transaction_id, idempotency_key
  ) values (
    v_order.id, v_request.provider, 'refund', 'succeeded',
    v_request.amount, v_request.currency, p_event.object_reference,
    v_request.parent_transaction_id, p_event.provider_event_id
  ) returning * into v_transaction;

  insert into commerce.refunds (
    order_id, payment_transaction_id, status, source,
    amount, currency, reason, restock_requested, actor_id, metadata
  ) values (
    v_order.id, v_transaction.id, 'succeeded', v_request.source,
    v_request.amount, v_request.currency, v_request.reason,
    v_request.restock_requested, v_request.actor_id,
    jsonb_build_object('refund_request_id', v_request.id,
                       'provider_event_id', p_event.provider_event_id)
  ) returning id into v_refund_id;

  for v_line in
    select l.*, oi.variant_id
    from commerce.refund_request_lines l
    join public.order_items oi on oi.id = l.order_item_id
    where l.refund_request_id = v_request.id
    order by l.order_item_id
    for update of oi
  loop
    update public.order_items oi
    set refunded_quantity = oi.refunded_quantity + v_line.quantity,
        refunded_amount = oi.refunded_amount + v_line.amount
    where oi.id = v_line.order_item_id;

    insert into commerce.refund_lines (refund_id, order_id, order_item_id, quantity, amount)
    values (v_refund_id, v_order.id, v_line.order_item_id, v_line.quantity, v_line.amount);
  end loop;

  -- Item tax components were copied by the refund-line trigger; retain shipping
  -- and unallocated reservations exactly, never reprice at provider completion.
  for v_line in select c.* from commerce.refund_request_components c
    left join commerce.order_tax_lines t on t.id = c.tax_line_id
    where c.refund_request_id = v_request.id and (c.kind <> 'tax' or t.order_item_id is null)
    order by (c.kind = 'tax'), c.id
  loop
    insert into commerce.refund_components(refund_id, order_id, kind, tax_line_id, shipping_line_id, amount)
    values (v_refund_id, v_order.id, v_line.kind, v_line.tax_line_id, v_line.shipping_line_id, v_line.amount);
  end loop;
  select coalesce(sum(p.amount), 0) into v_refunded
  from commerce.payment_transactions p
  where p.order_id = v_order.id and p.kind = 'refund' and p.status = 'succeeded';
  update public.orders o
  set financial_status = case when v_refunded >= o.total then 'refunded'
                              else 'partially_refunded' end
  where o.id = v_order.id;

  insert into public.order_events (order_id, actor_id, type, data)
  values (
    v_order.id, v_request.actor_id, 'refund_created',
    jsonb_build_object(
      'amount', v_request.amount, 'reason', v_request.reason,
      'restock', v_request.restock_requested,
      'refund_request_id', v_request.id,
      'provider_event_id', p_event.provider_event_id
    )
  );
  update commerce.refund_requests r
  set status = 'succeeded', provider_reference = p_event.object_reference,
      result_refund_id = v_refund_id, processed_at = now(),
      failure_code = null, failure_message = null,
      submitted_at = coalesce(r.submitted_at, now())
  where r.id = v_request.id;
  perform set_config('commerce.refund_write', 'off', true);
  perform set_config('commerce.async_refund_finalize', 'off', true);
  return v_refund_id;
end;
$$;

CREATE FUNCTION private.mark_order_paid(order_id uuid, provider text DEFAULT 'manual'::text, provider_ref text DEFAULT NULL::text) RETURNS public.orders
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_order public.orders;
begin
  if not public.is_admin() then
    raise exception 'admin only';
  end if;

  select * into v_order from public.orders where id = mark_order_paid.order_id for update;
  if not found then
    raise exception 'order not found';
  end if;
  if v_order.financial_status = 'pending' and v_order.payment_expires_at <= clock_timestamp() then
    raise exception 'order payment window has expired';
  end if;
  if v_order.financial_status <> 'pending' then
    raise exception 'order is not pending payment (current: %)', v_order.financial_status;
  end if;
  if v_order.status <> 'open' then
    raise exception 'order is not open (current: %)', v_order.status;
  end if;

  insert into commerce.payment_transactions (order_id, provider, kind, status, amount, currency, provider_reference)
  values (v_order.id, provider, 'capture', 'succeeded', v_order.total, v_order.currency, provider_ref);

  update public.orders
  set financial_status = 'paid',
      paid_at = now(),
      status = case when fulfillment_status = 'fulfilled' then 'completed' else status end,
      completed_at = case when fulfillment_status = 'fulfilled' then now() else completed_at end
  where id = v_order.id
  returning * into v_order;

  insert into public.order_events (order_id, actor_id, type, data)
  values (v_order.id, auth.uid(), 'payment_received',
          jsonb_build_object('provider', provider, 'amount', v_order.total));

  return v_order;
end;
$$;

CREATE FUNCTION private.order_snapshot_has_payment_intent(p_order_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select exists (
    select 1 from commerce.payment_intents i where i.order_id = p_order_id
      and i.status in ('requires_action', 'processing')
  );
$$;

CREATE FUNCTION private.payment_intent_json(p_intent commerce.payment_intents) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select jsonb_build_object(
    'id', p_intent.id, 'order_id', p_intent.order_id,
    'provider', p_intent.provider, 'payment_method', p_intent.payment_method,
    'status', p_intent.status,
    'amount', p_intent.amount, 'currency', p_intent.currency,
    'provider_reference', p_intent.provider_reference,
    'expires_at', p_intent.expires_at,
    'created_at', p_intent.created_at, 'updated_at', p_intent.updated_at
  );
$$;

CREATE FUNCTION private.prevent_refund_after_provider_reversal() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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

CREATE FUNCTION private.prevent_refund_during_async_request() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if new.kind = 'refund'
     and coalesce(current_setting('commerce.async_refund_finalize', true), 'off') <> 'on'
     and exists (
       select 1 from commerce.refund_requests r
       where r.order_id = new.order_id
         and r.status in ('requested', 'submitted', 'processing')
     ) then
    raise exception 'order has an active asynchronous refund request';
  end if;
  return new;
end;
$$;

CREATE FUNCTION private.process_payment_provider_event(p_event_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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
  if v_event.outcome = 'transient_database_error' and v_event.next_attempt_at > clock_timestamp() then
    return jsonb_build_object('status', 'received', 'outcome', v_event.outcome, 'provider_event_id', v_event.provider_event_id);
  end if;
  update commerce.payment_provider_events set attempts = attempts + 1
  where id = v_event.id;

  begin
    if v_event.provider = 'paypal'
          and (v_event.event_type like 'PAYMENT.CAPTURE.%'
               or v_event.event_type = 'paypal.capture.api_result')
          and v_event.event_type <> 'PAYMENT.CAPTURE.REFUNDED' then
      v_result := private.process_paypal_payment_event(v_event);
    elsif v_event.provider = 'paypal'
          and (v_event.event_type like 'PAYMENT.REFUND.%'
               or v_event.event_type = 'PAYMENT.CAPTURE.REFUNDED'
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
        next_attempt_at = case when v_result ->> 'outcome' = 'transient_database_error'
          then clock_timestamp() + make_interval(secs => least(300, power(2, least(e.attempts, 8))::integer))
          else e.next_attempt_at end,
        resource_type = v_resource_type,
        resource_id = v_resource_id,
        last_error = case when v_status = 'received' then v_result ->> 'outcome' else null end,
        processed_at = case when v_status in ('processed', 'ignored') then now() else null end
    where e.id = v_event.id returning * into v_event;
  exception when deadlock_detected or serialization_failure or lock_not_available then
    update commerce.payment_provider_events e
    set status = 'received', outcome = 'transient_database_error', last_error = left(sqlerrm,4000), processed_at = null,
        next_attempt_at = clock_timestamp() + make_interval(secs => least(300,power(2,least(e.attempts,8))::integer))
    where e.id = v_event.id returning * into v_event;
  when others then
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

CREATE FUNCTION private.process_paypal_payment_event(p_event commerce.payment_provider_events) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  v_intent commerce.payment_intents;
  v_capture commerce.payment_transactions;
  v_reversal commerce.provider_money_movements;
  v_order_reference text := nullif(p_event.data ->> 'order_reference', '');
  v_status text := lower(p_event.data ->> 'status');
  v_amount numeric(12, 2);
  v_currency text := upper(p_event.data ->> 'currency');
  v_transaction_id uuid;
  v_movement commerce.provider_money_movements;
  v_error text;
begin
  v_amount := private.provider_decimal_amount(p_event.data ->> 'amount', v_currency);
  -- Provider bindings, not mutable custom_id metadata, establish ownership.
  -- Early webhooks remain retryable until the API response binds the Order ID.
  if v_order_reference is not null then
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
        p_event.provider_event_id
      ) ->> 'id')::uuid into v_transaction_id;
      update commerce.provider_money_movements m
      set order_id = v_intent.order_id, payment_intent_id = v_intent.id,
          payment_transaction_id = v_transaction_id,
          reconciliation_status = 'matched', matched_at = now(), last_error = null
      where m.id = v_movement.id;
      return jsonb_build_object('status', 'processed', 'outcome', 'captured',
                                'resource_type', 'payment_transaction',
                                'resource_id', v_transaction_id);
    exception when deadlock_detected or serialization_failure or lock_not_available then
      update commerce.provider_money_movements set last_error = sqlerrm where id = v_movement.id;
      return jsonb_build_object('status', 'received', 'outcome', 'transient_database_error',
                                'resource_type', 'provider_money_movement', 'resource_id', v_movement.id);
    when others then
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
$_$;

CREATE FUNCTION private.process_paypal_refund_event(p_event commerce.payment_provider_events) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  v_request commerce.refund_requests;
  v_parent commerce.payment_transactions;
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
  -- Refund IDs are bound only by trusted API responses, never by metadata.
  if p_event.object_reference is not null then
    select * into v_request from commerce.refund_requests r
    where r.provider = 'paypal' and r.provider_reference = p_event.object_reference
    for update;
  end if;

  if v_request.id is not null and v_capture_reference is not null then
    select * into v_parent from commerce.payment_transactions t
    where t.id = v_request.parent_transaction_id;
    if v_parent.provider_reference is distinct from v_capture_reference then
      v_error := 'PayPal refund capture reference mismatch';
    end if;
  elsif v_request.id is null and v_capture_reference is not null then
    -- Only a matched provider fact establishes Capture ownership. Manual ledger
    -- references are neither verified nor unique, even when provider='paypal'.
    select t.* into v_parent from commerce.provider_money_movements m
    join commerce.payment_transactions t on t.id = m.payment_transaction_id
    where m.provider = 'paypal' and m.kind = 'capture'
      and m.provider_reference = v_capture_reference and m.reconciliation_status = 'matched';
  end if;

  if v_status = 'completed' then
    v_movement := private.record_provider_money_movement(
      p_event, 'refund', v_amount, v_currency,
      coalesce(v_request.order_id, v_parent.order_id),
      null,
      case when v_request.currency = v_currency then v_request.id else null end
    );
    if v_request.id is null then
      perform private.require_reconciliation(
        v_movement.id, 'PayPal refund has no bound local request', v_parent.order_id
      );
      -- Remain retryable: a response lost after Refund POST may be bound later.
      return jsonb_build_object('status', 'received', 'outcome', 'unmatched_refund',
                                'resource_type', 'provider_money_movement',
                                'resource_id', v_movement.id);
    end if;
    if v_movement.reconciliation_status = 'matched' then
      return jsonb_build_object('status', 'processed', 'outcome', 'refunded',
                                'resource_type', 'refund_request',
                                'resource_id', v_request.id);
    end if;
    if v_error is not null
       or (v_request.amount, v_request.currency) is distinct from (v_amount, v_currency) then
      perform private.require_reconciliation(
        v_movement.id, coalesce(v_error, 'PayPal refund amount or currency mismatch'),
        v_request.order_id, null,
        case when v_request.currency = v_currency then v_request.id else null end
      );
      return jsonb_build_object('status', 'processed', 'outcome', 'action_required',
                                'resource_type', 'provider_money_movement',
                                'resource_id', v_movement.id);
    end if;
    begin
      v_refund_id := private.finalize_refund_request(v_request.id, p_event);
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
    exception when deadlock_detected or serialization_failure or lock_not_available then
      update commerce.provider_money_movements set last_error = sqlerrm where id = v_movement.id;
      return jsonb_build_object('status', 'received', 'outcome', 'transient_database_error',
                                'resource_type', 'provider_money_movement', 'resource_id', v_movement.id);
    when others then
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
  if v_error is not null then raise exception '%', v_error; end if;
  if (v_request.amount, v_request.currency) is distinct from (v_amount, v_currency) then
    raise exception 'PayPal refund amount or currency mismatch';
  end if;
  if v_request.status in ('succeeded', 'failed', 'cancelled') then
    return jsonb_build_object('status', 'ignored', 'outcome', 'stale_refund_event',
                              'resource_type', 'refund_request', 'resource_id', v_request.id);
  end if;
  if v_status = 'pending' then
    update commerce.refund_requests set status = 'processing'
    where id = v_request.id and status in ('requested', 'submitted');
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
$_$;

CREATE FUNCTION private.protect_capture_request_marker() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if old.provider_capture_requested_at is not null
     and new.provider_capture_requested_at is distinct from old.provider_capture_requested_at then
    raise exception 'provider capture request marker is immutable';
  end if;
  return new;
end;
$$;

CREATE FUNCTION private.protect_order_during_paypal_capture() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  -- The caller already owns the order lock. Do not acquire an intent lock here
  -- (settlement takes intent -> quote -> order). A fresh MVCC read is sufficient:
  -- prepare either committed before this order lock, or will see our cancellation.
  if exists (
    select 1 from commerce.payment_intents i
    where i.order_id = old.id and i.provider = 'paypal'
      and i.provider_capture_requested_at is not null
      and i.status in ('requires_action', 'processing')
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

CREATE FUNCTION private.protect_order_items_during_payment() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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

CREATE FUNCTION private.protect_order_payment_snapshot() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if (new.customer_id, new.email, new.currency, new.subtotal, new.discount_total,
      new.shipping_total, new.tax_total, new.total, new.shipping_address,
      new.billing_address, new.shipping_method_id, new.shipping_method_name,
      new.discount_code, new.customer_note, new.created_at, new.tax_context)
     is distinct from
     (old.customer_id, old.email, old.currency, old.subtotal, old.discount_total,
      old.shipping_total, old.tax_total, old.total, old.shipping_address,
      old.billing_address, old.shipping_method_id, old.shipping_method_name,
      old.discount_code, old.customer_note, old.created_at, old.tax_context)
     and private.order_snapshot_has_payment_intent(old.id) then
    raise exception 'order snapshot is locked by a payment intent';
  end if;
  return new;
end;
$$;

CREATE FUNCTION private.provider_decimal_amount(p_amount text, p_currency text) RETURNS numeric
    LANGUAGE plpgsql IMMUTABLE STRICT
    SET search_path TO ''
    AS $_$
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
$_$;

CREATE FUNCTION private.provider_payment_intent_json(p_intent commerce.payment_intents) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select private.payment_intent_json(p_intent) || jsonb_build_object(
    'order_number', o.order_number,
    'shipping_address', o.shipping_address
  )
  from public.orders o where o.id = p_intent.order_id;
$$;

CREATE FUNCTION private.record_provider_money_movement(p_event commerce.payment_provider_events, p_kind text, p_amount numeric, p_currency text, p_order_id uuid DEFAULT NULL::uuid, p_payment_intent_id uuid DEFAULT NULL::uuid, p_refund_request_id uuid DEFAULT NULL::uuid) RETURNS commerce.provider_money_movements
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_movement commerce.provider_money_movements;
begin
  insert into commerce.provider_money_movements (
    provider_event_id, provider, kind, provider_reference, amount, currency,
    order_id, payment_intent_id, refund_request_id
  ) values (
    p_event.id, p_event.provider, p_kind, p_event.object_reference,
    p_amount, upper(p_currency), p_order_id, p_payment_intent_id, p_refund_request_id
  ) on conflict on constraint provider_money_movements_provider_kind_provider_reference_key do update
    set order_id = coalesce(commerce.provider_money_movements.order_id, excluded.order_id),
        payment_intent_id = coalesce(commerce.provider_money_movements.payment_intent_id,
                                     excluded.payment_intent_id),
        refund_request_id = coalesce(commerce.provider_money_movements.refund_request_id,
                                     excluded.refund_request_id)
  returning * into v_movement;
  if (v_movement.provider, v_movement.kind, v_movement.provider_reference,
      v_movement.amount, v_movement.currency)
     is distinct from
     (p_event.provider, p_kind, p_event.object_reference, p_amount, upper(p_currency)) then
    raise exception 'provider event conflicts with an existing money movement';
  end if;
  return v_movement;
end;
$$;

CREATE FUNCTION private.refund_request_json(p_request commerce.refund_requests) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select jsonb_build_object(
    'id', p_request.id, 'order_id', p_request.order_id,
    'provider', p_request.provider, 'status', p_request.status,
    'source', p_request.source, 'amount', p_request.amount,
    'currency', p_request.currency,
    'components', private.refund_components_json(p_request.id, true),
    'provider_reference', p_request.provider_reference,
    'provider_refund_requested_at', p_request.provider_refund_requested_at,
    'parent_transaction_id', p_request.parent_transaction_id,
    'parent_provider_reference', (
      select t.provider_reference from commerce.payment_transactions t
      where t.id = p_request.parent_transaction_id
    ),
    'reason', p_request.reason,
    'restock_requested', p_request.restock_requested,
    'result_refund_id', p_request.result_refund_id,
    'failure_code', p_request.failure_code,
    'failure_message', p_request.failure_message,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
        'order_item_id', l.order_item_id, 'quantity', l.quantity, 'amount', l.amount
      ) order by l.order_item_id)
      from commerce.refund_request_lines l where l.refund_request_id = p_request.id
    ), '[]'::jsonb),
    'created_at', p_request.created_at, 'updated_at', p_request.updated_at,
    'processed_at', p_request.processed_at
  );
$$;

CREATE FUNCTION private.require_reconciliation(p_movement_id uuid, p_error text, p_order_id uuid DEFAULT NULL::uuid, p_payment_intent_id uuid DEFAULT NULL::uuid, p_refund_request_id uuid DEFAULT NULL::uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_movement commerce.provider_money_movements;
begin
  update commerce.provider_money_movements m
  set order_id = coalesce(m.order_id, p_order_id),
      payment_intent_id = coalesce(m.payment_intent_id, p_payment_intent_id),
      refund_request_id = coalesce(m.refund_request_id, p_refund_request_id),
      reconciliation_status = 'action_required',
      last_error = left(coalesce(p_error, 'provider money requires reconciliation'), 4000)
  where m.id = p_movement_id returning * into v_movement;
  perform private.enqueue_outbox_event(
    'provider_money_movement', v_movement.id, 'payment.reconciliation_required',
    jsonb_build_object(
      'movement_id', v_movement.id, 'provider', v_movement.provider,
      'kind', v_movement.kind, 'provider_reference', v_movement.provider_reference,
      'amount', v_movement.amount, 'currency', v_movement.currency,
      'order_id', v_movement.order_id, 'payment_intent_id', v_movement.payment_intent_id,
      'refund_request_id', v_movement.refund_request_id,
      'error', v_movement.last_error
    ),
    'provider-money:' || v_movement.id || ':reconciliation-required'
  );
end;
$$;

CREATE FUNCTION private.validate_payment_intent() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_order public.orders;
begin
  new.provider := lower(btrim(new.provider));
  new.payment_method := lower(btrim(new.payment_method));
  new.currency := upper(btrim(new.currency));
  new.idempotency_key := btrim(new.idempotency_key);
  if tg_op = 'INSERT' then
    select * into v_order from public.orders o where o.id = new.order_id for update;
    if not found or v_order.status <> 'open' or v_order.financial_status <> 'pending'
       or v_order.payment_expires_at <= clock_timestamp()
       or (v_order.total, v_order.currency) is distinct from (new.amount, new.currency) then
      raise exception 'payment intent does not match a payable order';
    end if;
    new.expires_at := coalesce(new.expires_at, v_order.payment_expires_at);
    if new.expires_at <> v_order.payment_expires_at then raise exception 'payment intent expiry must match order'; end if;
    if exists (
      select 1 from commerce.payment_intents i
      where i.order_id = new.order_id
        and i.status in ('requires_action', 'processing')
    ) then
      raise exception 'order already has an active payment intent';
    end if;
    -- Make intent creation visible as a write conflict to old commercial snapshots.
    update public.orders set updated_at = now() where id = new.order_id;
  else
    if (new.order_id, new.provider, new.payment_method, new.amount, new.currency, new.idempotency_key, new.expires_at)
       is distinct from
       (old.order_id, old.provider, old.payment_method, old.amount, old.currency, old.idempotency_key, old.expires_at) then
      raise exception 'payment intent commercial fields are immutable';
    end if;
    if old.provider_reference is not null
       and new.provider_reference is distinct from old.provider_reference then
      raise exception 'payment intent provider reference is immutable';
    end if;
    if new.status <> old.status and not (
      (old.status = 'requires_action' and new.status in ('processing', 'succeeded', 'failed', 'cancelled'))
      or (old.status = 'processing' and new.status in ('requires_action', 'succeeded', 'failed', 'cancelled'))
    ) then
      raise exception 'invalid payment intent transition: % -> %', old.status, new.status;
    end if;
    new.updated_at := now();
  end if;
  return new;
end;
$$;

CREATE FUNCTION private.validate_payment_provider_event() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  new.provider := lower(btrim(new.provider));
  new.provider_event_id := btrim(new.provider_event_id);
  new.event_type := btrim(new.event_type);
  if new.object_reference is not null then
    new.object_reference := btrim(new.object_reference);
  end if;
  if tg_op = 'UPDATE' then
    if (new.provider, new.provider_event_id, new.source, new.event_type,
        new.object_reference, new.livemode, new.occurred_at, new.payload_hash,
        new.data, new.created_at)
       is distinct from
       (old.provider, old.provider_event_id, old.source, old.event_type,
        old.object_reference, old.livemode, old.occurred_at, old.payload_hash,
        old.data, old.created_at) then
      raise exception 'provider event facts are immutable';
    end if;
    if old.status in ('processed', 'ignored') and new is distinct from old then
      raise exception 'completed provider event is immutable';
    end if;
    new.updated_at := now();
  end if;
  return new;
end;
$$;

CREATE FUNCTION private.validate_provider_money_movement() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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
        new.amount, new.currency, new.created_at)
       is distinct from
       (old.provider_event_id, old.provider, old.kind, old.provider_reference,
        old.amount, old.currency, old.created_at) then
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
  if new.order_id is not null and
     (new.reconciliation_status='action_required' or (tg_op='UPDATE' and old.reconciliation_status='action_required'))
     and (tg_op='INSERT' or (new.order_id,new.reconciliation_status) is distinct from (old.order_id,old.reconciliation_status)) then
    -- Fence fulfillment, including trusted INSERT and old RR snapshots. Child
    -- writers must not wait backwards for an order held by another settlement.
    perform 1 from public.orders where id=new.order_id for update nowait;
    update public.orders set updated_at=now() where id=new.order_id;
  end if;
  return new;
end;
$$;

CREATE FUNCTION private.capture_refund_available(p_capture_id uuid) RETURNS numeric
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $$
  select t.amount
    - (select coalesce(sum(r.amount), 0) from commerce.payment_transactions r
       where r.parent_transaction_id = t.id and r.kind = 'refund' and r.status = 'succeeded')
    - (select coalesce(sum(r.amount), 0) from commerce.refund_requests r
       where r.parent_transaction_id = t.id and r.status in ('requested','submitted','processing'))
  from commerce.payment_transactions t where t.id = p_capture_id;
$$;

CREATE FUNCTION private.validate_refund_request() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_parent commerce.payment_transactions;
  v_refund commerce.refunds;
begin
  new.provider := lower(btrim(new.provider));
  new.currency := upper(btrim(new.currency));
  new.idempotency_key := btrim(new.idempotency_key);
  if new.provider_reference is not null then
    new.provider_reference := btrim(new.provider_reference);
  end if;
  select * into v_parent from commerce.payment_transactions t
  where t.id = new.parent_transaction_id;
  if not found or v_parent.order_id <> new.order_id
     or v_parent.provider <> new.provider or v_parent.kind <> 'capture'
     or v_parent.status <> 'succeeded' or v_parent.currency <> new.currency
     or new.amount > v_parent.amount then
    raise exception 'refund request does not match a succeeded capture';
  end if;
  if tg_op = 'INSERT' then
    -- Serialize capacity for both RPC and trusted table writers, including old
    -- REPEATABLE READ snapshots. NOWAIT avoids reverse child-to-order waiting.
    perform 1 from public.orders where id = new.order_id for update nowait;
    update public.orders set updated_at = now() where id = new.order_id;
    if new.status <> 'requested' or new.amount > private.capture_refund_available(v_parent.id) then
      raise exception 'refund request exceeds available capture balance or has invalid initial status';
    end if;
  end if;
  if new.result_refund_id is not null then
    select * into v_refund from commerce.refunds r where r.id = new.result_refund_id;
    if not found or (v_refund.order_id, v_refund.status, v_refund.amount, v_refund.currency)
       is distinct from (new.order_id, 'succeeded', new.amount, new.currency) then
      raise exception 'refund request result does not match succeeded refund';
    end if;
  end if;
  if tg_op = 'UPDATE' then
    if old.provider_refund_requested_at is not null
       and new.provider_refund_requested_at is distinct from old.provider_refund_requested_at then
      raise exception 'provider refund request marker is immutable';
    end if;
    if (new.order_id, new.parent_transaction_id, new.provider, new.source,
        new.amount, new.currency, new.idempotency_key, new.request_hash,
        new.reason, new.restock_requested, new.metadata, new.created_at)
       is distinct from
       (old.order_id, old.parent_transaction_id, old.provider, old.source,
        old.amount, old.currency, old.idempotency_key, old.request_hash,
        old.reason, old.restock_requested, old.metadata, old.created_at) then
      raise exception 'refund request commercial fields are immutable';
    end if;
    if new.actor_id is distinct from old.actor_id
       and not (old.actor_id is not null and new.actor_id is null) then
      raise exception 'refund request actor can only be anonymized';
    end if;
    if old.provider_reference is not null
       and new.provider_reference is distinct from old.provider_reference then
      raise exception 'refund request provider reference is immutable';
    end if;
    if old.status in ('succeeded', 'failed', 'cancelled') and new is distinct from old
       and not (old.actor_id is not null and new.actor_id is null
                and (to_jsonb(new) - 'actor_id') is not distinct from
                    (to_jsonb(old) - 'actor_id')) then
      raise exception 'completed refund request is immutable';
    end if;
    if new.status <> old.status and not (
      (old.status = 'requested' and new.status in ('submitted', 'processing', 'succeeded', 'failed', 'cancelled'))
      or (old.status = 'submitted' and new.status in ('processing', 'succeeded', 'failed', 'cancelled'))
      or (old.status = 'processing' and new.status in ('succeeded', 'failed', 'cancelled'))
    ) then
      raise exception 'invalid refund request transition: % -> %', old.status, new.status;
    end if;
    new.updated_at := now();
  end if;
  return new;
end;
$$;

CREATE FUNCTION private.validate_refund_request_line() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_request commerce.refund_requests;
  v_item public.order_items;
  v_active_qty integer;
  v_active_amount numeric(12, 2);
  v_expected numeric(12, 2);
begin
  select * into v_request from commerce.refund_requests r
  where r.id = new.refund_request_id;
  if not found or v_request.order_id <> new.order_id or v_request.status <> 'requested'
     or v_request.source <> 'items' then
    raise exception 'refund request line requires a requested item refund';
  end if;
  select * into v_item from public.order_items oi
  where oi.id = new.order_item_id and oi.order_id = new.order_id for update;
  if not found then raise exception 'refund request line does not match order item'; end if;
  select coalesce(sum(l.quantity), 0), coalesce(sum(l.amount), 0)
  into v_active_qty, v_active_amount
  from commerce.refund_request_lines l
  join commerce.refund_requests r on r.id = l.refund_request_id
  where l.order_item_id = new.order_item_id
    and r.status in ('requested', 'submitted', 'processing');
  if v_item.refunded_quantity + v_active_qty + new.quantity
     + private.zero_value_cancelled_quantity(v_item.id) > v_item.quantity then
    raise exception 'refund request line exceeds available quantity';
  end if;
  v_expected := private.proportional_refund(v_item.line_total, v_item.quantity, new.quantity,
    v_item.refunded_quantity + v_active_qty, v_item.refunded_amount + v_active_amount);
  if new.amount <> v_expected or v_expected < 0 then
    raise exception 'refund request line amount does not match refundable allocation';
  end if;
  return new;
end;
$$;

CREATE FUNCTION public.bind_payment_intent_provider(payment_intent_id uuid, provider_reference text, provider_status text, amount numeric, currency text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_intent commerce.payment_intents;
  v_status text := lower(btrim(provider_status));
  v_reference text := btrim(provider_reference);
begin
  if auth.role() <> 'service_role' then raise exception 'service role only'; end if;
  if coalesce(v_reference, '') = '' then raise exception 'provider_reference is required'; end if;
  if v_status not in ('requires_action', 'processing') then
    raise exception 'provider status % must be confirmed by webhook', v_status;
  end if;
  select * into v_intent from commerce.payment_intents i
  where i.id = bind_payment_intent_provider.payment_intent_id for update;
  if not found then raise exception 'payment intent not found'; end if;
  if (v_intent.amount, v_intent.currency)
     is distinct from (round(bind_payment_intent_provider.amount, 2), upper(btrim(currency))) then
    raise exception 'provider payment intent amount or currency mismatch';
  end if;
  if v_intent.provider_reference is not null
     and v_intent.provider_reference <> v_reference then
    raise exception 'payment intent is already bound to another provider reference';
  end if;
  if exists (
    select 1 from commerce.payment_intents i
    where i.provider = v_intent.provider and i.provider_reference = v_reference
      and i.id <> v_intent.id
  ) then
    raise exception 'provider reference is already bound to another payment intent';
  end if;
  update commerce.payment_intents i
  set provider_reference = v_reference,
      status = case when i.status in ('succeeded', 'failed', 'cancelled') then i.status else v_status end
  where i.id = v_intent.id returning * into v_intent;
  return private.payment_intent_json(v_intent);
end;
$$;

CREATE FUNCTION public.bind_refund_request_provider(refund_request_id uuid, provider_reference text, provider_status text, amount numeric, currency text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_request commerce.refund_requests;
  v_status text := lower(btrim(provider_status));
  v_reference text := btrim(provider_reference);
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service role only'; end if;
  if coalesce(v_reference, '') = '' then raise exception 'provider_reference is required'; end if;
  if v_status is null or v_status not in ('pending', 'succeeded', 'failed', 'canceled', 'cancelled') then
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
        else 'submitted' end,
      submitted_at = coalesce(r.submitted_at, now())
  where r.id = v_request.id returning * into v_request;
  return private.refund_request_json(v_request);
end;
$$;

CREATE FUNCTION public.prepare_paypal_refund(refund_request_id uuid, actor_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare
  v_request commerce.refund_requests;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service role only'; end if;
  if not exists (select 1 from public.profiles p where p.id = actor_id and p.role = 'admin') then
    raise exception 'admin actor required';
  end if;
  select * into v_request from commerce.refund_requests r
  where r.id = refund_request_id and r.provider = 'paypal' for update;
  if not found then raise exception 'refund request not found'; end if;
  -- Bound retries only GET the known resource, including terminal observations.
  if v_request.provider_reference is not null then return private.refund_request_json(v_request); end if;
  if v_request.status not in ('requested', 'submitted', 'processing') then
    raise exception 'terminal refund request cannot be dispatched';
  end if;
  -- A local conservative retry window, not a claim of unlimited provider deduplication.
  -- Older unknown outcomes require a trusted provider lookup/binding, never a fresh POST.
  if v_request.provider_refund_requested_at < clock_timestamp() - interval '1 hour' then
    raise exception 'unbound refund dispatch exceeded retry window; reconcile at provider';
  end if;
  perform 1 from public.orders o where o.id = v_request.order_id for update;
  if exists (select 1 from commerce.provider_money_movements m
    join commerce.payment_transactions t on t.provider_reference = m.provider_reference and t.provider = m.provider
    where t.id = v_request.parent_transaction_id and m.kind = 'refund'
      and m.refund_request_id is null and m.reconciliation_status = 'action_required') then
    raise exception 'capture has a provider reversal; reconcile before refund';
  end if;
  update commerce.refund_requests r set provider_refund_requested_at = coalesce(r.provider_refund_requested_at, clock_timestamp())
  where r.id = v_request.id returning * into v_request;
  return private.refund_request_json(v_request);
end;
$$;

CREATE FUNCTION public.cancel_refund_request(refund_request_id uuid, actor_id uuid, provider_confirmed boolean DEFAULT false, reason text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_request commerce.refund_requests;
begin
  if auth.role() <> 'service_role' then raise exception 'service role only'; end if;
  if not exists (
    select 1 from public.profiles p
    where p.id = cancel_refund_request.actor_id and p.role = 'admin'
  ) then
    raise exception 'admin actor required';
  end if;
  select * into v_request from commerce.refund_requests r
  where r.id = cancel_refund_request.refund_request_id for update;
  if not found then raise exception 'refund request not found'; end if;
  if v_request.status = 'cancelled' then return private.refund_request_json(v_request); end if;
  if v_request.status in ('succeeded', 'failed') then
    raise exception 'completed refund request cannot be cancelled';
  end if;
  if (v_request.provider_reference is not null or v_request.provider_refund_requested_at is not null)
     and not coalesce(provider_confirmed, false) then
    raise exception 'bound refund must be cancelled at the provider first';
  end if;
  update commerce.refund_requests r
  set status = 'cancelled', processed_at = now(),
      failure_code = 'cancelled_by_admin',
      failure_message = left(coalesce(cancel_refund_request.reason, 'cancelled by admin'), 2000)
  where r.id = v_request.id returning * into v_request;
  return private.refund_request_json(v_request);
end;
$$;

CREATE FUNCTION public.capture_payment_intent(payment_intent_id uuid, provider_reference text, idempotency_key text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_intent commerce.payment_intents;
  v_quote commerce.checkout_quotes;
  v_order public.orders;
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
  if v_intent.status not in ('requires_action', 'processing') then
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
  insert into commerce.payment_transactions (
    order_id, provider, kind, status, amount, currency, provider_reference,
    payment_intent_id, idempotency_key
  ) values (
    v_order.id, v_intent.provider, 'capture', 'succeeded', v_intent.amount,
    v_intent.currency, v_reference, v_intent.id, v_key
  ) returning * into v_transaction;
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

CREATE FUNCTION public.create_payment_intent(order_id uuid, provider text, idempotency_key text, metadata jsonb DEFAULT '{}'::jsonb, payment_method text DEFAULT 'paypal'::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_order public.orders;
  v_quote commerce.checkout_quotes;
  v_intent commerce.payment_intents;
  v_provider text := lower(btrim(provider));
  v_key text := btrim(idempotency_key);
  v_payment_method text := lower(btrim(payment_method));
begin
  if coalesce(v_provider, '') = '' or coalesce(v_key, '') = '' then
    raise exception 'provider and idempotency_key are required';
  end if;
  if metadata is null or jsonb_typeof(metadata) <> 'object' then
    raise exception 'metadata must be an object';
  end if;

  select * into v_quote from commerce.checkout_quotes q
  where q.order_id = create_payment_intent.order_id for update;
  select * into v_order from public.orders o
  where o.id = create_payment_intent.order_id for update;
  if not found then raise exception 'order not found'; end if;

  select * into v_intent from commerce.payment_intents i
  where i.order_id = v_order.id and i.provider = v_provider and i.idempotency_key = v_key;
  if found then
    if (v_intent.order_id, v_intent.amount, v_intent.currency, v_intent.payment_method)
       is distinct from (v_order.id, v_order.total, v_order.currency, v_payment_method) then
      raise exception 'idempotency key was used for another payment intent';
    end if;
  else
    if v_order.status <> 'open' or v_order.financial_status <> 'pending' then
      raise exception 'order is not payable';
    end if;
    if v_order.payment_expires_at <= clock_timestamp() then raise exception 'order payment window has expired'; end if;
    if v_order.total <= 0 then
      raise exception 'zero-amount orders do not require a payment intent';
    end if;
    if v_quote.id is not null
       and (v_quote.status <> 'converted' or v_quote.expires_at <= clock_timestamp()) then
      raise exception 'checkout reservation is not active';
    end if;
    insert into commerce.payment_intents
      (order_id, provider, amount, currency, idempotency_key, metadata, expires_at, payment_method)
    values (v_order.id, v_provider, v_order.total, v_order.currency, v_key, metadata,
            case when v_quote.id is not null then v_quote.expires_at else v_order.payment_expires_at end,
            v_payment_method)
    returning * into v_intent;
  end if;

  return jsonb_build_object(
    'id', v_intent.id, 'order_id', v_intent.order_id,
    'provider', v_intent.provider, 'payment_method', v_intent.payment_method,
    'status', v_intent.status,
    'amount', v_intent.amount, 'currency', v_intent.currency,
    'provider_reference', v_intent.provider_reference,
    'expires_at', v_intent.expires_at,
    'created_at', v_intent.created_at, 'updated_at', v_intent.updated_at
  );
end;
$$;

CREATE FUNCTION public.create_payment_intent_for_customer(order_id uuid, actor_id uuid, provider text, idempotency_key text, metadata jsonb DEFAULT '{}'::jsonb, payment_method text DEFAULT 'paypal'::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_intent commerce.payment_intents;
begin
  if auth.role() <> 'service_role' then raise exception 'service role only'; end if;
  if not exists (
    select 1 from public.orders o
    where o.id = create_payment_intent_for_customer.order_id
      and o.customer_id = private.customer_for_user(create_payment_intent_for_customer.actor_id)
  ) then
    raise exception 'payable order not found for customer';
  end if;
  perform public.create_payment_intent(
    create_payment_intent_for_customer.order_id,
    create_payment_intent_for_customer.provider,
    create_payment_intent_for_customer.idempotency_key,
    coalesce(create_payment_intent_for_customer.metadata, '{}'::jsonb)
      || jsonb_build_object('actor_id', create_payment_intent_for_customer.actor_id),
    create_payment_intent_for_customer.payment_method
  );
  select * into v_intent from commerce.payment_intents i
  where i.order_id = create_payment_intent_for_customer.order_id
    and i.provider = lower(btrim(create_payment_intent_for_customer.provider))
    and i.idempotency_key = btrim(create_payment_intent_for_customer.idempotency_key);
  return private.provider_payment_intent_json(v_intent);
end;
$$;

CREATE FUNCTION public.create_refund_request(order_id uuid, actor_id uuid, provider text, idempotency_key text, items jsonb DEFAULT NULL::jsonb, amount numeric DEFAULT NULL::numeric, reason text DEFAULT NULL::text, restock boolean DEFAULT false, metadata jsonb DEFAULT '{}'::jsonb, shipping_amount numeric DEFAULT NULL) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_provider text := lower(btrim(provider));
  v_key text := btrim(idempotency_key);
  v_items jsonb;
  v_request_hash text;
  v_existing commerce.refund_requests;
  v_order public.orders;
  v_parent commerce.payment_transactions;
  v_source text;
  v_amount numeric(12, 2) := 0;
  v_available numeric(12, 2);
  v_item jsonb;
  v_plan jsonb;
  v_lines jsonb;
  v_request commerce.refund_requests;
begin
  if auth.role() <> 'service_role' then raise exception 'service role only'; end if;
  if not exists (
    select 1 from public.profiles p
    where p.id = create_refund_request.actor_id and p.role = 'admin'
  ) then
    raise exception 'admin actor required';
  end if;
  if coalesce(v_provider, '') = '' or coalesce(v_key, '') = '' or length(v_key) > 200 then
    raise exception 'provider and idempotency_key are required';
  end if;
  if items is not null and amount is not null then
    raise exception 'pass either items or amount, not both';
  end if;
  if amount is not null and amount <> round(amount, 2) then
    raise exception 'refund amount supports at most two decimal places';
  end if;
  if metadata is null or jsonb_typeof(metadata) <> 'object' or pg_column_size(metadata) > 16384 then
    raise exception 'metadata must be a bounded object';
  end if;
  if reason is not null and char_length(reason) > 1000 then
    raise exception 'reason must be at most 1000 characters';
  end if;

  v_items := case when items is null then null
                  else private.canonical_order_item_quantities(items) end;
  if v_items is not null and jsonb_array_length(v_items) > 100 then
    raise exception 'refund request is limited to 100 lines';
  end if;
  if restock and v_items is null then
    raise exception 'restock requires item-based refund lines';
  end if;
  v_request_hash := private.command_request_hash(jsonb_build_object(
    'order_id', order_id, 'actor_id', actor_id, 'provider', v_provider,
    'items', v_items,
    'amount', case when amount is null then null else round(amount, 2) end,
    'reason', reason, 'restock', restock, 'metadata', metadata,
    'shipping_amount', case when shipping_amount is not null then round(shipping_amount, 2) end
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'provider.refund:' || v_provider || ':' || v_key, 0));

  select * into v_existing from commerce.refund_requests r
  where r.provider = v_provider and r.idempotency_key = v_key;
  if found then
    if v_existing.request_hash <> v_request_hash then
      raise exception 'idempotency key was used with different refund parameters';
    end if;
    return private.refund_request_json(v_existing);
  end if;

  select * into v_order from public.orders o
  where o.id = create_refund_request.order_id for update;
  if not found then raise exception 'order not found'; end if;
  if v_order.financial_status not in ('paid', 'partially_refunded') then
    raise exception 'order is not refundable (current: %)', v_order.financial_status;
  end if;

  select * into v_parent from commerce.payment_transactions t
  where t.order_id = v_order.id and t.provider = v_provider
    and t.kind = 'capture' and t.status = 'succeeded'
    and t.provider_reference is not null
  order by t.created_at, t.id limit 1
  for update;
  if not found then raise exception 'no succeeded provider capture is available for refund'; end if;

  v_available := private.capture_refund_available(v_parent.id);
  if v_available <= 0 then raise exception 'capture has no refundable balance'; end if;

  v_plan := private.plan_refund(v_order.id, v_items, amount, shipping_amount, v_available);
  v_source := v_plan ->> 'source'; v_amount := (v_plan ->> 'amount')::numeric;
  v_lines := v_plan -> 'lines';

  insert into commerce.refund_requests (
    order_id, parent_transaction_id, provider, source, amount, currency,
    idempotency_key, request_hash, reason, restock_requested, actor_id, metadata
  ) values (
    v_order.id, v_parent.id, v_provider, v_source, v_amount, v_order.currency,
    v_key, v_request_hash, reason, restock, actor_id, metadata
  ) returning * into v_request;

  for v_item in select value from jsonb_array_elements(v_lines)
  loop
    insert into commerce.refund_request_lines
      (refund_request_id, order_id, order_item_id, quantity, amount)
    values (
      v_request.id, v_order.id, (v_item ->> 'order_item_id')::uuid,
      (v_item ->> 'quantity')::integer, (v_item ->> 'amount')::numeric
    );
  end loop;
  for v_item in select value from jsonb_array_elements(v_plan -> 'components') loop
    insert into commerce.refund_request_components(refund_request_id, order_id, kind, tax_line_id, shipping_line_id, amount)
    values (v_request.id, v_order.id, v_item ->> 'kind', (v_item ->> 'tax_line_id')::uuid,
      (v_item ->> 'shipping_line_id')::uuid, (v_item ->> 'amount')::numeric);
  end loop;
  return private.refund_request_json(v_request);
end;
$$;

CREATE FUNCTION public.get_payment_intent_for_customer(payment_intent_id uuid, actor_id uuid, provider text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_intent commerce.payment_intents;
begin
  if auth.role() <> 'service_role' then raise exception 'service role only'; end if;
  select i.* into v_intent
  from commerce.payment_intents i
  join public.orders o on o.id = i.order_id
  where i.id = get_payment_intent_for_customer.payment_intent_id
    and i.provider = lower(btrim(get_payment_intent_for_customer.provider))
    and o.customer_id = private.customer_for_user(get_payment_intent_for_customer.actor_id);
  if not found then raise exception 'payment intent not found for customer'; end if;
  return private.provider_payment_intent_json(v_intent);
end;
$$;

CREATE FUNCTION public.get_payment_operations(order_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_order public.orders;
  v_privileged boolean := public.is_admin() or auth.role() = 'service_role';
begin
  select * into v_order from public.orders o where o.id = get_payment_operations.order_id;
  if not found or (
    v_order.customer_id = public.current_customer_id() or v_privileged
  ) is not true then
    raise exception 'order not found';
  end if;
  return jsonb_build_object(
    'order_id', v_order.id,
    'payment_intents', coalesce((
      select jsonb_agg(private.payment_intent_json(i) order by i.created_at, i.id)
      from commerce.payment_intents i where i.order_id = v_order.id
    ), '[]'::jsonb),
    'provider_money_movements', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id, 'kind', m.kind, 'provider', m.provider,
        'provider_reference', m.provider_reference,
        'amount', m.amount, 'currency', m.currency,
        'reconciliation_status', m.reconciliation_status,
        'payment_transaction_id', m.payment_transaction_id,
        'refund_request_id', m.refund_request_id,
        'error', case when v_privileged then m.last_error else null end,
        'created_at', m.created_at
      ) order by m.created_at, m.id)
      from commerce.provider_money_movements m where m.order_id = v_order.id
    ), '[]'::jsonb),
    'provider_events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'provider_event_id', e.provider_event_id, 'event_type', e.event_type,
        'status', e.status, 'outcome', e.outcome,
        'resource_type', e.resource_type, 'resource_id', e.resource_id,
        'attempts', e.attempts, 'occurred_at', e.occurred_at
      ) order by e.created_at, e.id)
      from commerce.payment_provider_events e
      where exists (
        select 1 from commerce.provider_money_movements m
        where m.provider_event_id = e.id and m.order_id = v_order.id
      ) or exists (
        select 1 from commerce.payment_intents i
        where i.order_id = v_order.id and i.id = e.resource_id
      ) or exists (
        select 1 from commerce.payment_transactions t
        where t.order_id = v_order.id and t.id = e.resource_id
      ) or exists (
        select 1 from commerce.refund_requests r
        where r.order_id = v_order.id and r.id = e.resource_id
      )
    ), '[]'::jsonb),
    'refund_requests', coalesce((
      select jsonb_agg(private.refund_request_json(r) order by r.created_at, r.id)
      from commerce.refund_requests r where r.order_id = v_order.id
    ), '[]'::jsonb)
  );
end;
$$;

CREATE FUNCTION public.list_admin_payment_provider_events(page_size integer DEFAULT 20, status_filter text DEFAULT NULL,
    resource_id uuid DEFAULT NULL, after_cursor jsonb DEFAULT NULL) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
declare v_time timestamptz; v_id uuid; v_items jsonb; v_next jsonb;
begin
  if not public.is_admin() then raise exception using errcode='42501', message='admin only'; end if;
  if page_size is null or page_size not between 1 and 100
    or (status_filter is not null and status_filter not in ('received','processed','ignored','failed')) then
    raise exception using errcode='22023', message='invalid page_size or status_filter';
  end if;
  if after_cursor is not null then
    if jsonb_typeof(after_cursor) is distinct from 'object'
      or jsonb_typeof(after_cursor->'created_at') is distinct from 'string'
      or jsonb_typeof(after_cursor->'id') is distinct from 'string'
      or after_cursor-array['created_at','id']<>'{}'::jsonb then
      raise exception using errcode='22023', message='cursor requires created_at and id';
    end if;
    v_time := (after_cursor->>'created_at')::timestamptz;
    v_id := (after_cursor->>'id')::uuid;
    if not isfinite(v_time) then raise exception using errcode='22023', message='cursor timestamp must be finite'; end if;
  end if;
  with candidates as materialized (
    select e.* from commerce.payment_provider_events e
    where (status_filter is null or e.status=status_filter)
      and (list_admin_payment_provider_events.resource_id is null or e.resource_id=list_admin_payment_provider_events.resource_id)
      and (v_time is null or (e.created_at,e.id)<(v_time,v_id))
    order by e.created_at desc,e.id desc limit page_size+1
  ), page as materialized (select * from candidates order by created_at desc,id desc limit page_size)
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',p.id,'provider',p.provider,'provider_event_id',p.provider_event_id,'source',p.source,
    'event_type',p.event_type,'status',p.status,'livemode',p.livemode,
    'resource_type',p.resource_type,'resource_id',p.resource_id,'attempts',p.attempts,
    'automatic_retry_exhausted',p.status in ('received','failed') and p.attempts>=25,
    'next_attempt_at',p.next_attempt_at,'processed_at',p.processed_at,
    'occurred_at',p.occurred_at,'created_at',p.created_at,'has_error',p.last_error is not null
  ) order by p.created_at desc,p.id desc),'[]'::jsonb),
    case when (select count(*) from candidates)>page_size then
      (select jsonb_build_object('created_at',created_at,'id',id) from page order by created_at,id limit 1) end
    into v_items,v_next from page p;
  return jsonb_build_object('items',v_items,'next_cursor',v_next);
end;
$$;

CREATE FUNCTION public.ingest_payment_provider_event(provider text, provider_event_id text, source text, event_type text, object_reference text, livemode boolean, occurred_at timestamp with time zone, payload_hash text, data jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  v_provider text := lower(btrim(provider));
  v_event_id text := btrim(provider_event_id);
  v_event commerce.payment_provider_events;
begin
  if auth.role() <> 'service_role' then raise exception 'service role only'; end if;
  if source not in ('webhook', 'api_response') then raise exception 'invalid provider event source'; end if;
  if coalesce(v_provider, '') = '' or coalesce(v_event_id, '') = ''
     or livemode is null or occurred_at is null
     or payload_hash !~ '^[0-9a-f]{64}$'
     or data is null or jsonb_typeof(data) <> 'object' then
    raise exception 'invalid provider event envelope';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'provider.event:' || v_provider || ':' || v_event_id, 0));
  insert into commerce.payment_provider_events (
    provider, provider_event_id, source, event_type, object_reference,
    livemode, occurred_at, payload_hash, data
  ) values (
    v_provider, v_event_id, source, btrim(event_type), nullif(btrim(object_reference), ''),
    livemode, occurred_at, lower(payload_hash), data
  ) on conflict on constraint payment_provider_events_provider_provider_event_id_key do nothing;
  select * into v_event from commerce.payment_provider_events e
  where e.provider = v_provider and e.provider_event_id = v_event_id for update;
  if (v_event.source, v_event.event_type, v_event.object_reference,
      v_event.livemode, v_event.occurred_at, v_event.payload_hash)
     is distinct from
     (source, btrim(event_type), nullif(btrim(object_reference), ''),
      livemode, occurred_at, lower(payload_hash))
     or v_event.data is distinct from data then
    raise exception 'provider event id was reused with different facts';
  end if;
  return private.process_payment_provider_event(v_event.id);
end;
$_$;

-- Cancellation/expiry does not prove an already dispatched Capture failed.
-- Once a capture money fact exists, Inbox retries/reconciliation own recovery.
CREATE FUNCTION public.list_pending_paypal_captures(max_requests integer DEFAULT 20) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_result jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service role only'; end if;
  if max_requests is null or max_requests not between 1 and 20 then
    raise exception 'max_requests must be between 1 and 20';
  end if;
  with candidates as materialized (
    select i.id
    from commerce.payment_intents i
    where i.provider = 'paypal' and i.provider_reference is not null
      and i.provider_capture_requested_at is not null
      and i.status in ('requires_action', 'processing', 'cancelled')
      and (i.last_provider_poll_at is null
           or i.last_provider_poll_at <= clock_timestamp() - interval '5 minutes')
      and not exists (
        select 1 from commerce.provider_money_movements m
        where m.payment_intent_id = i.id and m.kind = 'capture'
      )
    order by coalesce(i.last_provider_poll_at, i.provider_capture_requested_at), i.id
    for update skip locked
    limit max_requests
  ), claimed as (
    update commerce.payment_intents i
    set last_provider_poll_at = clock_timestamp(),
        provider_poll_attempts = i.provider_poll_attempts + 1
    from candidates c where i.id = c.id
    returning i as intent
  )
  select coalesce(jsonb_agg(private.provider_payment_intent_json(c.intent)
    order by (c.intent).provider_capture_requested_at, (c.intent).id), '[]'::jsonb)
  into v_result from claimed c;
  return v_result;
end;
$$;

CREATE FUNCTION public.list_pending_provider_refunds(provider text, max_requests integer DEFAULT 50) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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
      and candidate.status in ('submitted', 'processing')
      -- Once observed, local settlement belongs to Inbox's bounded retry budget,
      -- not repeated GET -> ingest calls from this automatic polling worker.
      and not exists (select 1 from commerce.provider_money_movements m
        where m.provider=candidate.provider and m.kind='refund'
          and m.provider_reference=candidate.provider_reference)
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

CREATE FUNCTION public.mark_order_paid(order_id uuid, idempotency_key text, provider text DEFAULT 'manual'::text, provider_ref text DEFAULT NULL::text) RETURNS public.orders
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_order public.orders;
  v_subject_id constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  v_key text := btrim(idempotency_key);
  v_hash text;
  v_record commerce.command_idempotency;
begin
  if not public.is_admin() then raise exception using errcode = '42501', message = 'admin only'; end if;
  if coalesce(v_key, '') = '' or length(v_key) > 200 then
    raise exception using errcode = '22023', message = 'idempotency_key is required and must be at most 200 characters';
  end if;
  v_hash := private.command_request_hash(jsonb_build_object('order_id',order_id,'provider',provider,'provider_ref',provider_ref));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('order.pay:' || v_subject_id || ':' || v_key, 0));
  select * into v_record from commerce.command_idempotency c
    where c.scope = 'order.pay' and c.subject_id = v_subject_id and c.idempotency_key = v_key;
  if found then
    if v_record.request_hash <> v_hash then
      raise exception using errcode = 'PT409', message = 'idempotency key was used with different payment parameters';
    end if;
    select * into v_order from public.orders where id = v_record.resource_id;
    if not found then raise exception using errcode = 'PT404', message = 'idempotency resource no longer exists'; end if;
    return v_order;
  end if;
  perform 1 from commerce.payment_intents i
  where i.order_id = mark_order_paid.order_id order by i.id for update;
  perform 1 from commerce.checkout_quotes q
  where q.order_id = mark_order_paid.order_id for update;
  select * into v_order from public.orders o
  where o.id = mark_order_paid.order_id for update;
  if not found then raise exception 'order not found'; end if;
  if v_order.financial_status = 'pending' and v_order.payment_expires_at <= clock_timestamp() then
    raise exception 'order payment window has expired';
  end if;
  if v_order.financial_status <> 'pending' then
    raise exception 'order is not pending payment (current: %)', v_order.financial_status;
  end if;
  if v_order.status <> 'open' then
    raise exception 'order is not open (current: %)', v_order.status;
  end if;
  if exists (
    select 1 from commerce.payment_intents i where i.order_id = v_order.id
      and i.status in ('requires_action', 'processing')
  ) then
    raise exception 'online payment intent must be reconciled or cancelled at the provider before manual payment';
  end if;

  perform private.consume_order_reservation(v_order.id);
  if v_order.total > 0 then
    v_order := private.mark_order_paid(v_order.id, provider, provider_ref);
  else
    update public.orders
    set financial_status = 'paid', paid_at = now(),
        status = case when fulfillment_status = 'fulfilled' then 'completed' else status end,
        completed_at = case when fulfillment_status = 'fulfilled' then now() else completed_at end
    where id = v_order.id returning * into v_order;
    insert into public.order_events (order_id, actor_id, type, data)
    values (v_order.id, auth.uid(), 'payment_received',
            jsonb_build_object('provider', provider, 'amount', 0, 'free_order', true));
  end if;
  insert into commerce.command_idempotency(scope,subject_id,idempotency_key,request_hash,resource_type,resource_id)
    values ('order.pay',v_subject_id,v_key,v_hash,'order',v_order.id);
  return v_order;
end;
$$;

CREATE FUNCTION public.prepare_paypal_capture(payment_intent_id uuid, actor_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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
  if not found or v_order.customer_id is distinct from private.customer_for_user(prepare_paypal_capture.actor_id) then
    raise exception 'payable order not found for customer';
  end if;
  if v_order.status <> 'open' or v_order.financial_status <> 'pending' then
    raise exception 'order is not payable';
  end if;
  if (v_order.total, v_order.currency) is distinct from (v_intent.amount, v_intent.currency) then
    raise exception 'order total changed after payment intent creation';
  end if;
  if v_intent.provider_reference is null
     or v_intent.status not in ('requires_action', 'processing') then
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

CREATE FUNCTION public.retry_payment_provider_events(max_events integer DEFAULT 50) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_id uuid;
  v_results jsonb := '[]'::jsonb;
begin
  if auth.role() <> 'service_role' then raise exception 'service role only'; end if;
  if max_events is null or max_events not between 1 and 200 then
    raise exception 'max_events must be between 1 and 200';
  end if;
  for v_id in
    select e.id from commerce.payment_provider_events e
    where e.status in ('received', 'failed') and e.attempts < 25
      and e.next_attempt_at <= clock_timestamp()
    order by e.created_at, e.id
    for update skip locked limit max_events
  loop
    v_results := v_results || jsonb_build_array(private.process_payment_provider_event(v_id));
  end loop;
  return v_results;
end;
$$;

CREATE FUNCTION public.list_admin_payment_operations(order_id uuid, kind text,
    page_size integer DEFAULT 20, after_id uuid DEFAULT NULL) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
declare v_items jsonb; v_next uuid;
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if order_id is null or kind is null or kind not in ('payment_intent','refund_request','money_movement')
    or page_size is null or page_size not between 1 and 100 then
    raise exception using errcode='22023', message='invalid payment operation filters';
  end if;
  with candidates as materialized (
    select i.id,jsonb_build_object('id',i.id,'order_id',i.order_id,'provider',i.provider,
      'payment_method',i.payment_method,'status',i.status,'amount',i.amount::text,'currency',i.currency,
      'expires_at',i.expires_at,'provider_capture_requested_at',i.provider_capture_requested_at,
      'last_provider_poll_at',i.last_provider_poll_at,'provider_poll_attempts',i.provider_poll_attempts,
      'created_at',i.created_at,'updated_at',i.updated_at) as dto
    from commerce.payment_intents i where kind='payment_intent' and i.order_id=list_admin_payment_operations.order_id
      and (after_id is null or i.id>after_id)
    union all
    select r.id,jsonb_build_object('id',r.id,'order_id',r.order_id,'parent_transaction_id',r.parent_transaction_id,
      'provider',r.provider,'status',r.status,'source',r.source,'amount',r.amount::text,'currency',r.currency,
      'restock_requested',r.restock_requested,'result_refund_id',r.result_refund_id,
      'has_error',r.failure_code is not null or r.failure_message is not null,
      'submitted_at',r.submitted_at,'processed_at',r.processed_at,
      'provider_refund_requested_at',r.provider_refund_requested_at,'last_provider_poll_at',r.last_provider_poll_at,
      'provider_poll_attempts',r.provider_poll_attempts,'created_at',r.created_at,'updated_at',r.updated_at)
    from commerce.refund_requests r where kind='refund_request' and r.order_id=list_admin_payment_operations.order_id
      and (after_id is null or r.id>after_id)
    union all
    select m.id,jsonb_build_object('id',m.id,'order_id',m.order_id,'provider_event_id',m.provider_event_id,
      'provider',m.provider,'kind',m.kind,'amount',m.amount::text,'currency',m.currency,
      'payment_intent_id',m.payment_intent_id,'refund_request_id',m.refund_request_id,
      'payment_transaction_id',m.payment_transaction_id,'reconciliation_status',m.reconciliation_status,
      'has_error',m.last_error is not null,'matched_at',m.matched_at,'created_at',m.created_at)
    from commerce.provider_money_movements m where list_admin_payment_operations.kind='money_movement'
      and m.order_id=list_admin_payment_operations.order_id and (after_id is null or m.id>after_id)
    order by id limit page_size+1
  ), page as materialized (select * from candidates order by id limit page_size)
  select coalesce(jsonb_agg(p.dto order by p.id),'[]'::jsonb),
    case when (select count(*) from candidates)>page_size then (select id from page order by id desc limit 1) end
  into v_items,v_next from page p;
  return jsonb_build_object('order_id',order_id,'kind',kind,'items',v_items,'next_cursor',v_next);
end;
$$;

CREATE FUNCTION public.get_admin_payment_summary(start_at timestamptz, end_at timestamptz) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
declare v_count bigint; v_captures bigint; v_refunds bigint; v_captured numeric; v_refunded numeric;
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if start_at is null or end_at is null or not isfinite(start_at) or not isfinite(end_at)
    or end_at<=start_at or end_at-start_at>interval '744 hours' then
    raise exception using errcode='22023', message='require finite increasing range of at most 31 days';
  end if;
  select count(*),count(*) filter (where t.kind='capture'),count(*) filter (where t.kind='refund'),
    coalesce(sum(t.amount) filter (where t.kind='capture'),0),
    coalesce(sum(t.amount) filter (where t.kind='refund'),0)
  into v_count,v_captures,v_refunds,v_captured,v_refunded
  from (select p.kind,p.amount from commerce.payment_transactions p
    where p.status='succeeded' and p.kind in ('capture','refund')
      and p.created_at>=start_at and p.created_at<end_at limit 10001) t;
  if v_count>10000 then
    raise exception using errcode='PT422', message='report exceeds 10000 records; narrow the time range';
  end if;
  return jsonb_build_object('start_at',start_at,'end_at',end_at,'currency','USD',
    'time_basis','payment_transactions.created_at','capture_count',v_captures::text,'refund_count',v_refunds::text,
    'captured_amount',round(v_captured,2)::text,'refunded_amount',round(v_refunded,2)::text,
    'net_amount',round(v_captured-v_refunded,2)::text);
end;
$$;

CREATE FUNCTION public.list_admin_reconciliation_issues(page_size integer DEFAULT 20,
    status_filter text DEFAULT 'unmatched', after_cursor jsonb DEFAULT NULL) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
declare v_time timestamptz; v_id uuid; v_items jsonb; v_next jsonb;
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if page_size is null or page_size not between 1 and 100
    or status_filter is null or status_filter not in ('unmatched','action_required') then
    raise exception using errcode='22023', message='invalid reconciliation filters';
  end if;
  if after_cursor is not null then
    if jsonb_typeof(after_cursor) is distinct from 'object'
      or jsonb_typeof(after_cursor->'created_at') is distinct from 'string'
      or jsonb_typeof(after_cursor->'id') is distinct from 'string'
      or after_cursor-array['created_at','id']<>'{}'::jsonb then
      raise exception using errcode='22023', message='cursor requires created_at and id';
    end if;
    v_time := (after_cursor->>'created_at')::timestamptz;
    v_id := (after_cursor->>'id')::uuid;
    if not isfinite(v_time) then raise exception using errcode='22023', message='cursor timestamp must be finite'; end if;
  end if;
  with candidates as materialized (
    select m.* from commerce.provider_money_movements m
    where m.reconciliation_status<>'matched' and m.reconciliation_status=status_filter
      and (v_time is null or (m.created_at,m.id)>(v_time,v_id))
    order by m.created_at,m.id limit page_size+1
  ), page as materialized (select * from candidates order by created_at,id limit page_size)
  select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'provider_event_id',p.provider_event_id,
    'provider',p.provider,'kind',p.kind,'amount',p.amount::text,'currency',p.currency,
    'order_id',p.order_id,'payment_intent_id',p.payment_intent_id,'refund_request_id',p.refund_request_id,
    'reconciliation_status',p.reconciliation_status,'has_error',p.last_error is not null,'created_at',p.created_at)
    order by p.created_at,p.id),'[]'::jsonb),
    case when (select count(*) from candidates)>page_size then
      (select jsonb_build_object('created_at',created_at,'id',id) from page order by created_at desc,id desc limit 1) end
  into v_items,v_next from page p;
  return jsonb_build_object('items',v_items,'next_cursor',v_next);
end;
$$;

commit;
