begin;

-- No reservations or business writes. Row locks give the planner a coherent
-- order snapshot; the command recomputes under the same lock before writing.
create or replace function public.preview_manual_refund(order_id uuid, items jsonb default null,
  amount numeric default null, shipping_amount numeric default null, restock boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_order public.orders;
  v_ledger jsonb;
  v_available numeric;
  v_plan jsonb;
  v_lines jsonb := '[]'::jsonb;
  v_components jsonb;
  v_line jsonb;
  v_tax record;
  v_tax_amount numeric;
  v_cancelled integer;
  v_restocked integer;
  v_result jsonb;
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  if restock is null then raise exception 'restock must be explicit boolean'; end if;
  if items is null and amount is null and shipping_amount is null then
    raise exception 'explicit refund scope is required';
  end if;
  if restock and items is null then raise exception 'restock requires item-based refund lines'; end if;
  select * into v_order from public.orders where id = preview_manual_refund.order_id for update;
  if not found then raise exception 'order not found'; end if;
  if v_order.currency <> 'USD' or v_order.financial_status not in ('paid','partially_refunded') then
    raise exception 'order is not refundable';
  end if;
  -- This new contract is deliberately manual-only. Provider refunds need their
  -- own guarded request contract, not an offline ledger entry.
  if exists(select 1 from commerce.payment_intents where payment_intents.order_id = v_order.id)
    or exists(select 1 from commerce.payment_transactions where payment_transactions.order_id = v_order.id and provider <> 'manual')
    or exists(select 1 from commerce.refund_requests where refund_requests.order_id = v_order.id) then
    raise exception 'manual-only payment history required';
  end if;
  v_ledger := public.get_order_ledger(v_order.id);
  if not (v_ledger #>> '{balances,is_balanced}')::boolean then raise exception 'ledger is not balanced'; end if;
  v_available := least(v_order.total, (v_ledger #>> '{balances,captured}')::numeric)
    - (v_ledger #>> '{balances,refunded}')::numeric;
  v_plan := private.plan_refund(v_order.id, items, amount, shipping_amount, v_available);
  v_components := v_plan -> 'components';
  for v_line in select value from jsonb_array_elements(v_plan -> 'lines') loop
    select least((v_line ->> 'quantity')::integer - (v_line ->> 'restock_shipped_quantity')::integer, b.available_quantity)
      into v_cancelled from private.order_item_fulfillment_balance((v_line ->> 'order_item_id')::uuid) b;
    perform private.assert_shipped_restock((v_line ->> 'order_item_id')::uuid, (v_line ->> 'restock_shipped_quantity')::integer);
    v_restocked := case when restock and exists (
      select 1 from public.inventory_movements im join public.order_items oi on oi.variant_id = im.variant_id
      where oi.id = (v_line ->> 'order_item_id')::uuid and im.order_id = v_order.id and im.reason = 'order' and im.delta < 0
    ) then v_cancelled else 0 end;
    v_lines := v_lines || jsonb_build_array(v_line || jsonb_build_object(
      'cancelled_quantity', v_cancelled, 'restocked_quantity', v_restocked));
    -- Match refund_line_taxes without inserting rows or advancing quantities.
    for v_tax in select id from commerce.order_tax_lines
      where order_item_id = (v_line ->> 'order_item_id')::uuid order by id loop
      v_tax_amount := private.item_refund_tax(v_tax.id, (v_line ->> 'quantity')::integer);
      if v_tax_amount > 0 then
        v_components := v_components || jsonb_build_array(jsonb_build_object(
          'kind', 'tax', 'tax_line_id', v_tax.id, 'amount', v_tax_amount));
      end if;
    end loop;
  end loop;
  select coalesce(jsonb_agg(jsonb_build_object('kind', c ->> 'kind',
      'tax_line_id', c -> 'tax_line_id', 'shipping_line_id', c -> 'shipping_line_id', 'amount', c -> 'amount')
      order by c ->> 'kind', c ->> 'tax_line_id', c ->> 'shipping_line_id'), '[]'::jsonb)
    into v_components from jsonb_array_elements(v_components) c;
  v_result := jsonb_build_object('order_id', v_order.id, 'currency', v_order.currency,
    'available_amount', v_available, 'source', v_plan -> 'source', 'amount', v_plan -> 'amount',
    'lines', v_lines, 'components', v_components, 'restock', restock);
  return v_result || jsonb_build_object('preview_token', private.command_request_hash(v_result));
end;
$$;

create or replace function public.commit_manual_refund(order_id uuid, preview_token text, idempotency_key text,
  items jsonb default null, amount numeric default null, shipping_amount numeric default null,
  restock boolean default false, reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_subject constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  v_key text := btrim(idempotency_key);
  v_items jsonb := case when items is null then null else private.canonical_refund_items(items) end;
  v_hash text;
  v_record commerce.command_idempotency;
  v_preview jsonb;
  v_refund_id uuid;
  v_refund jsonb;
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  if coalesce(v_key, '') = '' or length(v_key) > 200 then raise exception 'valid idempotency_key required'; end if;
  if preview_token is null or preview_token !~ '^[0-9a-f]{64}$' then raise exception 'valid preview_token required'; end if;
  if coalesce(btrim(reason), '') = '' or length(reason) > 2000 then raise exception 'refund reason required (maximum 2000 characters)'; end if;
  v_hash := private.command_request_hash(jsonb_build_object('contract', 'manual-preview-v1',
    'order_id', order_id, 'preview_token', preview_token, 'items', v_items,
    'amount', amount, 'shipping_amount', shipping_amount, 'restock', restock, 'reason', reason));
  -- Share the legacy refund key namespace so a key cannot create one refund
  -- through each API. Replay precedes eligibility/preview checks.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('order.refund:' || v_subject || ':' || v_key, 0));
  select * into v_record from commerce.command_idempotency c
    where c.scope = 'order.refund' and c.subject_id = v_subject and c.idempotency_key = v_key;
  if found then
    if v_record.request_hash <> v_hash then raise exception 'idempotency key was used with different refund parameters'; end if;
    v_refund_id := v_record.resource_id;
  else
    v_preview := public.preview_manual_refund(order_id, v_items, amount, shipping_amount, restock);
    if v_preview ->> 'preview_token' <> preview_token then
      raise exception 'refund preview changed; preview and confirm again';
    end if;
    v_refund_id := private.refund_order(order_id, v_items, amount, reason, restock, 'manual', shipping_amount);
    perform private.refresh_order_fulfillment(order_id);
    insert into commerce.command_idempotency(scope, subject_id, idempotency_key, request_hash, resource_type, resource_id)
      values ('order.refund', v_subject, v_key, v_hash, 'refund', v_refund_id);
  end if;
  select r into v_refund from jsonb_array_elements(public.get_order_ledger(order_id) -> 'refunds') r
    where r ->> 'id' = v_refund_id::text;
  if v_refund is null then raise exception 'idempotency record points to a missing refund'; end if;
  -- Catch divergence between preview and write triggers atomically, including
  -- tax rounding and cancellation effects, rather than returning a wrong receipt.
  if v_preview is not null and jsonb_build_object('source', v_refund -> 'source',
      'amount', v_refund -> 'amount', 'lines', v_refund -> 'lines', 'components', v_refund -> 'components',
      'restock', v_refund -> 'restock_requested') is distinct from
      (v_preview - array['order_id','currency','available_amount','preview_token']) then
    raise exception 'refund execution differs from preview';
  end if;
  return jsonb_build_object('order_id', order_id, 'preview_token', preview_token, 'refund', v_refund);
end;
$$;

revoke all on function public.preview_manual_refund(uuid,jsonb,numeric,numeric,boolean) from public, anon, service_role;
revoke all on function public.commit_manual_refund(uuid,text,text,jsonb,numeric,numeric,boolean,text) from public, anon, service_role;
grant execute on function public.preview_manual_refund(uuid,jsonb,numeric,numeric,boolean) to authenticated;
grant execute on function public.commit_manual_refund(uuid,text,text,jsonb,numeric,numeric,boolean,text) to authenticated;
notify pgrst, 'reload schema';
commit;
