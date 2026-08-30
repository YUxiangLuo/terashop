-- ============================================================
-- 真实支付渠道边界：Provider Event Inbox / 外部资金事实 / 异步退款请求
-- - Webhook 只在 Edge Function 验签后进入 service-only RPC
-- - 外部成功资金先落 provider money movement，再尝试匹配内部交易
-- - 异步退款仅在渠道确认 succeeded 后修改订单、退款账本和库存
-- ============================================================

-- ============================================================
-- A. Provider Event Inbox 与外部资金事实
-- ============================================================
create table commerce.payment_provider_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (length(btrim(provider)) between 1 and 50),
  provider_event_id text not null check (length(btrim(provider_event_id)) between 1 and 255),
  source text not null check (source in ('webhook', 'api_response')),
  event_type text not null check (length(btrim(event_type)) between 1 and 200),
  object_reference text check (object_reference is null or length(object_reference) between 1 and 255),
  livemode boolean not null,
  occurred_at timestamptz not null,
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  data jsonb not null default '{}'::jsonb check (
    jsonb_typeof(data) = 'object' and pg_column_size(data) <= 65536
  ),
  status text not null default 'received'
    check (status in ('received', 'processed', 'ignored', 'failed')),
  outcome text,
  resource_type text check (resource_type is null or resource_type in (
    'payment_intent', 'payment_transaction', 'refund_request', 'provider_money_movement'
  )),
  resource_id uuid,
  attempts integer not null default 0 check (attempts >= 0),
  last_error text check (last_error is null or char_length(last_error) <= 4000),
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_event_id),
  check ((resource_type is null) = (resource_id is null)),
  check ((status in ('processed', 'ignored')) = (processed_at is not null))
);

create index payment_provider_events_retry_idx
  on commerce.payment_provider_events (status, created_at, id)
  where status in ('received', 'failed');
create index payment_provider_events_object_idx
  on commerce.payment_provider_events (provider, object_reference, created_at)
  where object_reference is not null;

create table commerce.provider_money_movements (
  id uuid primary key default gen_random_uuid(),
  provider_event_id uuid not null unique
    references commerce.payment_provider_events (id) on delete restrict,
  provider text not null check (length(btrim(provider)) between 1 and 50),
  kind text not null check (kind in ('capture', 'refund')),
  provider_reference text not null check (length(provider_reference) between 1 and 255),
  amount numeric(12, 2) not null check (amount > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  order_id uuid references public.orders (id) on delete restrict,
  payment_intent_id uuid references commerce.payment_intents (id) on delete restrict,
  refund_request_id uuid,
  payment_transaction_id uuid unique
    references commerce.payment_transactions (id) on delete restrict,
  reconciliation_status text not null default 'unmatched'
    check (reconciliation_status in ('unmatched', 'matched', 'action_required')),
  last_error text check (last_error is null or char_length(last_error) <= 4000),
  matched_at timestamptz,
  created_at timestamptz not null default now(),
  unique (provider, kind, provider_reference),
  check ((reconciliation_status = 'matched') = (payment_transaction_id is not null)),
  check ((reconciliation_status = 'matched') = (matched_at is not null))
);

create index provider_money_movements_order_idx
  on commerce.provider_money_movements (order_id, created_at desc)
  where order_id is not null;
create index provider_money_movements_reconcile_idx
  on commerce.provider_money_movements (reconciliation_status, created_at, id)
  where reconciliation_status <> 'matched';

-- ============================================================
-- B. 异步退款请求（渠道确认前只预留可退额度/数量）
-- ============================================================
create table commerce.refund_requests (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete restrict,
  parent_transaction_id uuid not null
    references commerce.payment_transactions (id) on delete restrict,
  provider text not null check (length(btrim(provider)) between 1 and 50),
  status text not null default 'requested' check (status in (
    'requested', 'submitted', 'processing', 'requires_action',
    'succeeded', 'failed', 'cancelled'
  )),
  source text not null check (source in ('items', 'custom_amount', 'remaining')),
  amount numeric(12, 2) not null check (amount > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  idempotency_key text not null check (length(btrim(idempotency_key)) between 1 and 200),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  provider_reference text,
  reason text check (reason is null or char_length(reason) <= 1000),
  restock_requested boolean not null default false,
  actor_id uuid references public.profiles (id) on delete set null,
  result_refund_id uuid unique references commerce.refunds (id) on delete restrict,
  failure_code text check (failure_code is null or char_length(failure_code) <= 200),
  failure_message text check (failure_message is null or char_length(failure_message) <= 2000),
  metadata jsonb not null default '{}'::jsonb check (
    jsonb_typeof(metadata) = 'object' and pg_column_size(metadata) <= 16384
  ),
  submitted_at timestamptz,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, idempotency_key),
  unique (id, order_id),
  check (provider_reference is null or length(provider_reference) between 1 and 255),
  check ((status = 'succeeded') = (result_refund_id is not null)),
  check ((status in ('succeeded', 'failed', 'cancelled')) = (processed_at is not null))
);

create unique index refund_requests_provider_reference_uk
  on commerce.refund_requests (provider, provider_reference)
  where provider_reference is not null;
create index refund_requests_order_idx
  on commerce.refund_requests (order_id, created_at desc);
create index refund_requests_active_idx
  on commerce.refund_requests (order_id, parent_transaction_id, id)
  where status in ('requested', 'submitted', 'processing', 'requires_action');

create table commerce.refund_request_lines (
  refund_request_id uuid not null,
  order_id uuid not null,
  order_item_id uuid not null,
  quantity integer not null check (quantity > 0),
  amount numeric(12, 2) not null check (amount >= 0),
  created_at timestamptz not null default now(),
  primary key (refund_request_id, order_item_id),
  foreign key (refund_request_id, order_id)
    references commerce.refund_requests (id, order_id) on delete restrict,
  foreign key (order_item_id, order_id)
    references public.order_items (id, order_id) on delete restrict
);

alter table commerce.provider_money_movements
  add constraint provider_money_movements_refund_request_fk
  foreign key (refund_request_id) references commerce.refund_requests (id) on delete restrict;

create index refund_request_lines_item_idx
  on commerce.refund_request_lines (order_item_id, refund_request_id);

-- ============================================================
-- C. 状态、不变量与不可变保护
-- ============================================================
create or replace function private.validate_payment_provider_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
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

create trigger payment_provider_events_validate
  before insert or update on commerce.payment_provider_events
  for each row execute function private.validate_payment_provider_event();
create trigger payment_provider_events_no_delete
  before delete on commerce.payment_provider_events
  for each row execute function private.protect_immutable_row();
create trigger payment_provider_events_no_truncate
  before truncate on commerce.payment_provider_events
  for each statement execute function private.protect_immutable_row();

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
  return new;
end;
$$;

create trigger provider_money_movements_validate
  before insert or update on commerce.provider_money_movements
  for each row execute function private.validate_provider_money_movement();
create trigger provider_money_movements_no_delete
  before delete on commerce.provider_money_movements
  for each row execute function private.protect_immutable_row();
create trigger provider_money_movements_no_truncate
  before truncate on commerce.provider_money_movements
  for each statement execute function private.protect_immutable_row();

create or replace function private.validate_refund_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
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
  if new.result_refund_id is not null then
    select * into v_refund from commerce.refunds r where r.id = new.result_refund_id;
    if not found or (v_refund.order_id, v_refund.status, v_refund.amount, v_refund.currency)
       is distinct from (new.order_id, 'succeeded', new.amount, new.currency) then
      raise exception 'refund request result does not match succeeded refund';
    end if;
  end if;
  if tg_op = 'UPDATE' then
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
      (old.status = 'requested' and new.status in ('submitted', 'processing', 'requires_action', 'succeeded', 'failed', 'cancelled'))
      or (old.status = 'submitted' and new.status in ('processing', 'requires_action', 'succeeded', 'failed', 'cancelled'))
      or (old.status = 'processing' and new.status in ('requires_action', 'succeeded', 'failed', 'cancelled'))
      or (old.status = 'requires_action' and new.status in ('processing', 'succeeded', 'failed', 'cancelled'))
    ) then
      raise exception 'invalid refund request transition: % -> %', old.status, new.status;
    end if;
    new.updated_at := now();
  end if;
  return new;
end;
$$;

create trigger refund_requests_validate
  before insert or update on commerce.refund_requests
  for each row execute function private.validate_refund_request();

create or replace function private.validate_refund_request_line()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
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
    and r.status in ('requested', 'submitted', 'processing', 'requires_action');
  if v_item.refunded_quantity + v_active_qty + new.quantity > v_item.quantity then
    raise exception 'refund request line exceeds available quantity';
  end if;
  v_expected := case
    when v_item.refunded_quantity + v_active_qty + new.quantity = v_item.quantity
      then v_item.line_total - v_item.refunded_amount - v_active_amount
    else round(v_item.line_total * new.quantity / v_item.quantity, 2)
  end;
  if new.amount <> v_expected or v_expected < 0 then
    raise exception 'refund request line amount does not match refundable allocation';
  end if;
  return new;
end;
$$;

create trigger refund_request_lines_validate
  before insert on commerce.refund_request_lines
  for each row execute function private.validate_refund_request_line();
create trigger refund_requests_no_delete
  before delete on commerce.refund_requests
  for each row execute function private.protect_immutable_row();
create trigger refund_requests_no_truncate
  before truncate on commerce.refund_requests
  for each statement execute function private.protect_immutable_row();
create trigger refund_request_lines_immutable
  before update or delete on commerce.refund_request_lines
  for each row execute function private.protect_immutable_row();
create trigger refund_request_lines_no_truncate
  before truncate on commerce.refund_request_lines
  for each statement execute function private.protect_immutable_row();

create or replace function private.assert_refund_request_lines()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_request commerce.refund_requests;
  v_count integer;
  v_amount numeric(12, 2);
begin
  if tg_table_name = 'refund_requests' then
    v_id := new.id;
  else
    v_id := coalesce(new.refund_request_id, old.refund_request_id);
  end if;
  select * into v_request from commerce.refund_requests r where r.id = v_id;
  if not found then return coalesce(new, old); end if;
  select count(*), coalesce(sum(l.amount), 0)
  into v_count, v_amount
  from commerce.refund_request_lines l where l.refund_request_id = v_id;
  if (v_request.source = 'items' and (v_count = 0 or v_amount <> v_request.amount))
     or (v_request.source <> 'items' and v_count <> 0) then
    raise exception 'refund request lines do not match header %', v_id;
  end if;
  return coalesce(new, old);
end;
$$;

create constraint trigger refund_requests_require_lines
  after insert on commerce.refund_requests
  deferrable initially deferred
  for each row execute function private.assert_refund_request_lines();
create constraint trigger refund_request_lines_match_header
  after insert or update or delete on commerce.refund_request_lines
  deferrable initially deferred
  for each row execute function private.assert_refund_request_lines();

-- 同一订单不能同时暴露多个可确认的 client secret；历史冲突必须先人工核对渠道状态。
do $migration$
begin
  if exists (
    select 1 from commerce.payment_intents i
    where i.status in ('requires_payment_method', 'requires_action', 'processing')
    group by i.order_id having count(*) > 1
  ) then
    raise exception 'cannot enforce one active payment intent per order: historical conflicts exist';
  end if;
end;
$migration$;
create unique index payment_intents_one_active_per_order_uk
  on commerce.payment_intents (order_id)
  where status in ('requires_payment_method', 'requires_action', 'processing');

-- PaymentIntent 允许渠道失败后回到 requires_payment_method，并允许随后成功。
create or replace function private.validate_payment_intent()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
begin
  new.provider := lower(btrim(new.provider));
  new.currency := upper(btrim(new.currency));
  new.idempotency_key := btrim(new.idempotency_key);
  if tg_op = 'INSERT' then
    select * into v_order from public.orders o where o.id = new.order_id for update;
    if not found or v_order.status <> 'open' or v_order.financial_status <> 'pending'
       or (v_order.total, v_order.currency) is distinct from (new.amount, new.currency) then
      raise exception 'payment intent does not match a payable order';
    end if;
    if exists (
      select 1 from commerce.payment_intents i
      where i.order_id = new.order_id
        and i.status in ('requires_payment_method', 'requires_action', 'processing')
    ) then
      raise exception 'order already has an active payment intent';
    end if;
  else
    if (new.order_id, new.provider, new.amount, new.currency, new.idempotency_key)
       is distinct from
       (old.order_id, old.provider, old.amount, old.currency, old.idempotency_key) then
      raise exception 'payment intent commercial fields are immutable';
    end if;
    if old.provider_reference is not null
       and new.provider_reference is distinct from old.provider_reference then
      raise exception 'payment intent provider reference is immutable';
    end if;
    if new.status <> old.status and not (
      (old.status = 'requires_payment_method' and new.status in ('requires_action', 'processing', 'succeeded', 'failed', 'cancelled'))
      or (old.status = 'requires_action' and new.status in ('requires_payment_method', 'processing', 'succeeded', 'failed', 'cancelled'))
      or (old.status = 'processing' and new.status in ('requires_payment_method', 'requires_action', 'succeeded', 'failed', 'cancelled'))
    ) then
      raise exception 'invalid payment intent transition: % -> %', old.status, new.status;
    end if;
    new.updated_at := now();
  end if;
  return new;
end;
$$;

-- 手工同步退款不得穿透尚未完成的异步退款预留。
create or replace function private.prevent_refund_during_async_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.kind = 'refund'
     and coalesce(current_setting('commerce.async_refund_finalize', true), 'off') <> 'on'
     and exists (
       select 1 from commerce.refund_requests r
       where r.order_id = new.order_id
         and r.status in ('requested', 'submitted', 'processing', 'requires_action')
     ) then
    raise exception 'order has an active asynchronous refund request';
  end if;
  return new;
end;
$$;

create trigger payments_async_refund_guard
  before insert on public.payments
  for each row execute function private.prevent_refund_during_async_request();

-- ============================================================
-- D. 安全 DTO 与创建/绑定 RPC
-- ============================================================
create or replace function private.payment_intent_json(p_intent commerce.payment_intents)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_intent.id, 'order_id', p_intent.order_id,
    'provider', p_intent.provider, 'status', p_intent.status,
    'amount', p_intent.amount, 'currency', p_intent.currency,
    'provider_reference', p_intent.provider_reference,
    'expires_at', p_intent.expires_at,
    'created_at', p_intent.created_at, 'updated_at', p_intent.updated_at
  );
$$;

create or replace function private.refund_request_json(p_request commerce.refund_requests)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_request.id, 'order_id', p_request.order_id,
    'provider', p_request.provider, 'status', p_request.status,
    'source', p_request.source, 'amount', p_request.amount,
    'currency', p_request.currency,
    'provider_reference', p_request.provider_reference,
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
begin
  if auth.role() <> 'service_role' then raise exception 'service role only'; end if;
  if not exists (
    select 1 from public.orders o
    where o.id = create_payment_intent_for_customer.order_id
      and o.customer_id = create_payment_intent_for_customer.customer_id
  ) then
    raise exception 'payable order not found for customer';
  end if;
  return public.create_payment_intent(
    create_payment_intent_for_customer.order_id,
    create_payment_intent_for_customer.provider,
    create_payment_intent_for_customer.idempotency_key,
    coalesce(create_payment_intent_for_customer.metadata, '{}'::jsonb)
      || jsonb_build_object('customer_id', create_payment_intent_for_customer.customer_id)
  );
end;
$$;

create or replace function public.bind_payment_intent_provider(
  payment_intent_id uuid,
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
  v_intent commerce.payment_intents;
  v_status text := lower(btrim(provider_status));
  v_reference text := btrim(provider_reference);
begin
  if auth.role() <> 'service_role' then raise exception 'service role only'; end if;
  if coalesce(v_reference, '') = '' then raise exception 'provider_reference is required'; end if;
  if v_status not in ('requires_payment_method', 'requires_action', 'processing') then
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

create or replace function public.create_refund_request(
  order_id uuid,
  actor_id uuid,
  provider text,
  idempotency_key text,
  items jsonb default null,
  amount numeric default null,
  reason text default null,
  restock boolean default false,
  metadata jsonb default '{}'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
  v_refunded numeric(12, 2);
  v_reserved numeric(12, 2);
  v_item jsonb;
  v_line public.order_items;
  v_qty integer;
  v_active_qty integer;
  v_active_amount numeric(12, 2);
  v_line_amount numeric(12, 2);
  v_lines jsonb := '[]'::jsonb;
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
    'reason', reason, 'restock', restock, 'metadata', metadata
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

  select coalesce(sum(t.amount), 0) into v_refunded
  from commerce.payment_transactions t
  where t.parent_transaction_id = v_parent.id
    and t.kind = 'refund' and t.status = 'succeeded';
  select coalesce(sum(r.amount), 0) into v_reserved
  from commerce.refund_requests r
  where r.parent_transaction_id = v_parent.id
    and r.status in ('requested', 'submitted', 'processing', 'requires_action');
  v_available := v_parent.amount - v_refunded - v_reserved;
  if v_available <= 0 then raise exception 'capture has no refundable balance'; end if;

  if v_items is not null then
    v_source := 'items';
    for v_item in select value from jsonb_array_elements(v_items)
    loop
      v_qty := (v_item ->> 'quantity')::integer;
      select * into v_line from public.order_items oi
      where oi.id = (v_item ->> 'order_item_id')::uuid
        and oi.order_id = v_order.id for update;
      if not found then
        raise exception 'order item % does not belong to this order', v_item ->> 'order_item_id';
      end if;
      select coalesce(sum(l.quantity), 0), coalesce(sum(l.amount), 0)
      into v_active_qty, v_active_amount
      from commerce.refund_request_lines l
      join commerce.refund_requests r on r.id = l.refund_request_id
      where l.order_item_id = v_line.id
        and r.status in ('requested', 'submitted', 'processing', 'requires_action');
      if v_line.refunded_quantity + v_active_qty + v_qty > v_line.quantity then
        raise exception 'refund quantity exceeds available request balance for item %', v_line.id;
      end if;
      if v_line.refunded_quantity + v_active_qty + v_qty = v_line.quantity then
        v_line_amount := v_line.line_total - v_line.refunded_amount - v_active_amount;
      else
        v_line_amount := round(v_line.line_total * v_qty / v_line.quantity, 2);
      end if;
      if v_line_amount < 0 then raise exception 'refund line amount became negative'; end if;
      v_amount := v_amount + v_line_amount;
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'order_item_id', v_line.id, 'quantity', v_qty, 'amount', v_line_amount
      ));
    end loop;
  elsif amount is not null then
    v_source := 'custom_amount';
    v_amount := round(amount, 2);
    if v_amount <= 0 then raise exception 'refund amount must be positive'; end if;
  else
    v_source := 'remaining';
    v_amount := v_available;
  end if;
  if v_amount <= 0 or v_amount > v_available then
    raise exception 'refund request amount % exceeds available provider balance %', v_amount, v_available;
  end if;

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
  return private.refund_request_json(v_request);
end;
$$;

create or replace function public.cancel_refund_request(
  refund_request_id uuid,
  actor_id uuid,
  provider_confirmed boolean default false,
  reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
  if v_request.provider_reference is not null and not coalesce(provider_confirmed, false) then
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
  v_next text;
begin
  if auth.role() <> 'service_role' then raise exception 'service role only'; end if;
  if coalesce(v_reference, '') = '' then raise exception 'provider_reference is required'; end if;
  if v_status not in ('pending', 'requires_action', 'succeeded', 'failed', 'canceled', 'cancelled') then
    raise exception 'unsupported provider refund status %', v_status;
  end if;
  select * into v_request from commerce.refund_requests r
  where r.id = bind_refund_request_provider.refund_request_id for update;
  if not found then raise exception 'refund request not found'; end if;
  if (v_request.amount, v_request.currency)
     is distinct from (round(bind_refund_request_provider.amount, 2), upper(btrim(currency))) then
    raise exception 'provider refund amount or currency mismatch';
  end if;
  if v_request.provider_reference is not null
     and v_request.provider_reference <> v_reference then
    raise exception 'refund request is already bound to another provider reference';
  end if;
  v_next := case v_status
    when 'pending' then 'processing'
    when 'requires_action' then 'requires_action'
    else 'submitted'
  end;
  update commerce.refund_requests r
  set provider_reference = v_reference,
      status = case when r.status in ('succeeded', 'failed', 'cancelled') then r.status else v_next end,
      submitted_at = coalesce(r.submitted_at, now())
  where r.id = v_request.id returning * into v_request;
  return private.refund_request_json(v_request);
end;
$$;

-- ============================================================
-- E. 渠道事件处理与异步退款最终落账
-- ============================================================
create or replace function private.provider_minor_amount(p_minor text, p_currency text)
returns numeric
language plpgsql
immutable
strict
set search_path = ''
as $$
begin
  if upper(p_currency) <> 'CNY' then
    raise exception 'provider currency % is outside the current CNY capability', p_currency;
  end if;
  if p_minor !~ '^[1-9][0-9]*$' then
    raise exception 'provider amount_minor must be a positive integer';
  end if;
  return round(p_minor::numeric / 100, 2);
end;
$$;

create or replace function private.record_provider_money_movement(
  p_event commerce.payment_provider_events,
  p_kind text,
  p_amount numeric,
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

create or replace function private.require_reconciliation(
  p_movement_id uuid,
  p_error text,
  p_order_id uuid default null,
  p_payment_intent_id uuid default null,
  p_refund_request_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
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

create or replace function private.finalize_refund_request(
  p_request_id uuid,
  p_event commerce.payment_provider_events,
  p_data jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request commerce.refund_requests;
  v_order public.orders;
  v_line record;
  v_variant_id uuid;
  v_location_id uuid;
  v_on_hand integer;
  v_payment public.payments;
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

  perform set_config('commerce.async_refund_finalize', 'on', true);
  perform set_config('commerce.refund_write', 'on', true);
  insert into public.payments (
    order_id, provider, kind, status, amount, currency,
    provider_ref, raw, idempotency_key
  ) values (
    v_order.id, v_request.provider, 'refund', 'succeeded',
    v_request.amount, v_request.currency, p_event.object_reference,
    p_data, p_event.provider_event_id
  ) returning * into v_payment;
  select * into v_transaction from commerce.payment_transactions t
  where t.legacy_payment_id = v_payment.id;
  if not found then raise exception 'refund payment transaction was not recorded'; end if;

  insert into commerce.refunds (
    order_id, payment_transaction_id, legacy_payment_id, status, source,
    amount, currency, reason, restock_requested, actor_id, metadata
  ) values (
    v_order.id, v_transaction.id, v_payment.id, 'succeeded', v_request.source,
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

    v_variant_id := v_line.variant_id;
    v_location_id := null;
    if v_request.restock_requested and v_variant_id is not null then
      select im.location_id into v_location_id
      from public.inventory_movements im
      where im.order_id = v_order.id and im.variant_id = v_variant_id
        and im.reason = 'order' and im.delta < 0
      order by im.id limit 1;
      if v_location_id is not null then
        insert into public.inventory_levels (variant_id, location_id, on_hand)
        values (v_variant_id, v_location_id, 0)
        on conflict on constraint inventory_levels_pkey do nothing;
        update public.inventory_levels il
        set on_hand = il.on_hand + v_line.quantity
        where il.variant_id = v_variant_id and il.location_id = v_location_id
        returning il.on_hand into v_on_hand;
        insert into public.inventory_movements (
          variant_id, location_id, delta, on_hand_after, reason,
          order_id, actor_id, note
        ) values (
          v_variant_id, v_location_id, v_line.quantity, v_on_hand, 'return',
          v_order.id, v_request.actor_id, v_request.reason
        );
      end if;
    end if;

    insert into commerce.refund_lines (
      refund_id, order_id, order_item_id, quantity, amount, restocked_quantity
    ) values (
      v_refund_id, v_order.id, v_line.order_item_id, v_line.quantity, v_line.amount,
      case when v_request.restock_requested and v_location_id is not null
           then v_line.quantity else 0 end
    );
  end loop;

  select coalesce(sum(p.amount), 0) into v_refunded
  from public.payments p
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
  v_amount numeric(12, 2);
  v_currency text := upper(p_event.data ->> 'currency');
  v_transaction_id uuid;
  v_transaction commerce.payment_transactions;
  v_movement commerce.provider_money_movements;
  v_target_status text;
  v_error text;
begin
  if v_metadata_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    select * into v_intent from commerce.payment_intents i
    where i.id = v_metadata_id::uuid and i.provider = p_event.provider for update;
  end if;
  if not found and p_event.object_reference is not null then
    select * into v_intent from commerce.payment_intents i
    where i.provider = p_event.provider
      and i.provider_reference = p_event.object_reference for update;
  end if;

  if p_event.event_type = 'payment_intent.succeeded' then
    v_amount := private.provider_minor_amount(p_event.data ->> 'amount_minor', v_currency);
    v_movement := private.record_provider_money_movement(
      p_event, 'capture', v_amount, v_currency,
      case when v_intent.id is null then null else v_intent.order_id end,
      v_intent.id, null
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
    if (v_intent.amount, v_intent.currency)
       is distinct from (v_amount, v_currency) then
      v_error := format('provider capture %s %s does not match intent %s %s',
                        v_amount, v_currency, v_intent.amount, v_intent.currency);
      perform private.require_reconciliation(
        v_movement.id, v_error, v_intent.order_id, v_intent.id, null
      );
      return jsonb_build_object('status', 'processed', 'outcome', 'action_required',
                                'resource_type', 'provider_money_movement',
                                'resource_id', v_movement.id);
    end if;
    if v_intent.provider_reference is null then
      update commerce.payment_intents set provider_reference = p_event.object_reference
      where id = v_intent.id;
    elsif v_intent.provider_reference <> p_event.object_reference then
      perform private.require_reconciliation(
        v_movement.id, 'provider reference conflicts with payment intent',
        v_intent.order_id, v_intent.id, null
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
    update commerce.payment_intents set provider_reference = p_event.object_reference
    where id = v_intent.id;
  elsif v_intent.provider_reference <> p_event.object_reference then
    raise exception 'provider reference conflicts with payment intent';
  end if;

  if v_intent.status in ('succeeded', 'failed', 'cancelled') then
    return jsonb_build_object('status', 'ignored', 'outcome', 'stale_payment_event',
                              'resource_type', 'payment_intent', 'resource_id', v_intent.id);
  end if;
  if p_event.event_type = 'payment_intent.processing' then
    v_target_status := 'processing';
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
      left(p_event.data ->> 'failure_message', 2000), p_event.data, now()
    ) on conflict (provider, idempotency_key) where idempotency_key is not null do nothing;
  end if;
  return jsonb_build_object('status', 'processed', 'outcome', v_target_status,
                            'resource_type', 'payment_intent', 'resource_id', v_intent.id);
end;
$$;

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
  v_amount numeric(12, 2);
  v_currency text := upper(p_event.data ->> 'currency');
  v_movement commerce.provider_money_movements;
  v_refund_id uuid;
  v_transaction_id uuid;
  v_error text;
begin
  v_amount := private.provider_minor_amount(p_event.data ->> 'amount_minor', v_currency);
  if v_metadata_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    select * into v_request from commerce.refund_requests r
    where r.id = v_metadata_id::uuid and r.provider = p_event.provider for update;
  end if;
  if not found and p_event.object_reference is not null then
    select * into v_request from commerce.refund_requests r
    where r.provider = p_event.provider
      and r.provider_reference = p_event.object_reference for update;
  end if;

  if v_status = 'succeeded' then
    v_movement := private.record_provider_money_movement(
      p_event, 'refund', v_amount, v_currency,
      case when v_request.id is null then null else v_request.order_id end,
      null, v_request.id
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
    if (v_request.amount, v_request.currency)
       is distinct from (v_amount, v_currency) then
      perform private.require_reconciliation(
        v_movement.id, 'provider refund amount or currency mismatch',
        v_request.order_id, null, v_request.id
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
  if (v_request.amount, v_request.currency)
     is distinct from (v_amount, v_currency) then
    raise exception 'provider refund amount or currency mismatch';
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
    raise exception 'provider refund reference mismatch';
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

create or replace function public.ingest_payment_provider_event(
  provider text,
  provider_event_id text,
  source text,
  event_type text,
  object_reference text,
  livemode boolean,
  occurred_at timestamptz,
  payload_hash text,
  data jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

create or replace function public.retry_payment_provider_events(max_events integer default 50)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
    order by e.created_at, e.id
    for update skip locked limit max_events
  loop
    v_results := v_results || jsonb_build_array(private.process_payment_provider_event(v_id));
  end loop;
  return v_results;
end;
$$;

-- capture_payment_intent V3：允许 Stripe 初始 requires_payment_method 直接由签名成功事件捕获。
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
  update commerce.payment_intents
  set status = 'succeeded', provider_reference = v_reference
  where id = v_intent.id;
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
-- F. 可观测 DTO / Outbox
-- ============================================================
create or replace function public.get_payment_operations(order_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_order public.orders;
  v_privileged boolean := public.is_admin() or auth.role() = 'service_role';
begin
  select * into v_order from public.orders o where o.id = get_payment_operations.order_id;
  if not found or not (
    v_order.customer_id = auth.uid() or v_privileged
  ) then
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

create or replace function private.refund_request_to_outbox()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
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

create trigger refund_requests_enqueue_outbox
  after insert or update of status on commerce.refund_requests
  for each row execute function private.refund_request_to_outbox();

-- ============================================================
-- G. 匿名化补丁：新增/既有审计 actor 只能单向清空
-- ============================================================
create or replace function public.anonymize_user(p_user_id uuid)
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles;
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  update public.profiles p
  set email = '', full_name = '', phone = null
  where p.id = p_user_id
  returning * into v_profile;
  if not found then raise exception 'user not found'; end if;

  delete from public.addresses a where a.customer_id = p_user_id;
  delete from public.metafields m
  where m.owner_type = 'customer' and m.owner_id = p_user_id;
  update public.inventory_movements set actor_id = null where actor_id = p_user_id;
  update public.order_events set actor_id = null where actor_id = p_user_id;
  update commerce.order_adjustments set actor_id = null where actor_id = p_user_id;
  update commerce.refunds set actor_id = null where actor_id = p_user_id;
  update commerce.refund_requests set actor_id = null where actor_id = p_user_id;
  return v_profile;
end;
$$;

-- ============================================================
-- H. RLS / ACL：物理表隐藏；支付渠道写入口仅 service role
-- ============================================================
alter table commerce.payment_provider_events enable row level security;
alter table commerce.provider_money_movements enable row level security;
alter table commerce.refund_requests enable row level security;
alter table commerce.refund_request_lines enable row level security;
revoke all on commerce.payment_provider_events from public, anon, authenticated, service_role;
revoke all on commerce.provider_money_movements from public, anon, authenticated, service_role;
revoke all on commerce.refund_requests from public, anon, authenticated, service_role;
revoke all on commerce.refund_request_lines from public, anon, authenticated, service_role;
revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function private.valid_country_codes(text[]) to authenticated, service_role;

revoke all on function public.create_payment_intent_for_customer(uuid, uuid, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.bind_payment_intent_provider(uuid, text, text, numeric, text)
  from public, anon, authenticated;
revoke all on function public.create_refund_request(uuid, uuid, text, text, jsonb, numeric, text, boolean, jsonb)
  from public, anon, authenticated;
revoke all on function public.cancel_refund_request(uuid, uuid, boolean, text)
  from public, anon, authenticated;
revoke all on function public.bind_refund_request_provider(uuid, text, text, numeric, text)
  from public, anon, authenticated;
revoke all on function public.ingest_payment_provider_event(text, text, text, text, text, boolean, timestamptz, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.retry_payment_provider_events(integer)
  from public, anon, authenticated;
grant execute on function public.create_payment_intent_for_customer(uuid, uuid, text, text, jsonb)
  to service_role;
grant execute on function public.bind_payment_intent_provider(uuid, text, text, numeric, text)
  to service_role;
grant execute on function public.create_refund_request(uuid, uuid, text, text, jsonb, numeric, text, boolean, jsonb)
  to service_role;
grant execute on function public.cancel_refund_request(uuid, uuid, boolean, text)
  to service_role;
grant execute on function public.bind_refund_request_provider(uuid, text, text, numeric, text)
  to service_role;
grant execute on function public.ingest_payment_provider_event(text, text, text, text, text, boolean, timestamptz, text, jsonb)
  to service_role;
grant execute on function public.retry_payment_provider_events(integer)
  to service_role;

revoke all on function public.get_payment_operations(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_payment_operations(uuid) to authenticated, service_role;

-- 保持既有支付入口信任边界。
revoke all on function public.capture_payment_intent(uuid, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.capture_payment_intent(uuid, text, text, jsonb)
  to service_role;
