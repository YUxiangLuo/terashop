-- ============================================================
-- 8. 关系化交易账本与 Outbox（V1 兼容双写）
--
-- 目标：
--   - 核心交易事实进入不对 PostgREST 暴露的 commerce schema
--   - 保留 payments / fulfillments / order_items 兼容字段与既有 RPC
--   - 新写入在同一数据库事务中双写关系化账本
--   - 提供安全 Ledger DTO、支付意图捕获入口和可租约 Outbox
-- ============================================================

create schema if not exists commerce;
revoke all on schema commerce from public, anon, authenticated;

-- 关系化行表使用复合 FK，数据库直接保证“行属于同一订单”。
alter table public.order_items
  add constraint order_items_id_order_uk unique (id, order_id);
alter table public.fulfillments
  add constraint fulfillments_id_order_uk unique (id, order_id);

-- ============================================================
-- A. Order Adjustment Ledger
-- amount 为有符号金额：正数增加应付，负数减少应付。
-- 恒等式：orders.subtotal + sum(adjustments.amount) = orders.total
-- ============================================================
create table commerce.order_adjustments (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders (id) on delete restrict,
  order_item_id uuid,
  kind text not null check (kind in ('discount', 'shipping', 'tax', 'manual', 'rounding')),
  amount numeric(12, 2) not null check (amount <> 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  label text not null default '',
  source_type text not null default 'order_snapshot',
  source_ref text,
  idempotency_key text not null unique,
  metadata jsonb not null default '{}' check (jsonb_typeof(metadata) = 'object'),
  actor_id uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (order_item_id, order_id)
    references public.order_items (id, order_id) on delete restrict
);

create index order_adjustments_order_idx
  on commerce.order_adjustments (order_id, id);
create index order_adjustments_order_item_idx
  on commerce.order_adjustments (order_item_id) where order_item_id is not null;

-- 历史订单只回填可由订单快照无歧义推导的三个组成部分。
insert into commerce.order_adjustments
  (order_id, kind, amount, currency, label, source_ref, idempotency_key, created_at)
select o.id, 'discount', -o.discount_total, o.currency, 'Discount', 'discount_total',
       'order:' || o.id || ':initial:discount', o.created_at
from public.orders o where o.discount_total > 0
union all
select o.id, 'shipping', o.shipping_total, o.currency, 'Shipping', 'shipping_total',
       'order:' || o.id || ':initial:shipping', o.created_at
from public.orders o where o.shipping_total > 0
union all
select o.id, 'tax', o.tax_total, o.currency, 'Tax', 'tax_total',
       'order:' || o.id || ':initial:tax', o.created_at
from public.orders o where o.tax_total > 0;

do $migration$
begin
  if exists (
    select 1 from public.orders o
    left join lateral (
      select coalesce(sum(a.amount), 0) amount
      from commerce.order_adjustments a where a.order_id = o.id
    ) a on true
    where round(o.subtotal + a.amount, 2) <> o.total
  ) then
    raise exception 'cannot backfill order adjustments: historical order totals are unbalanced';
  end if;
end;
$migration$;

create or replace function private.sync_order_adjustments()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
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

create trigger orders_adjustment_ledger_insert
  after insert on public.orders
  for each row execute function private.sync_order_adjustments();
create trigger orders_adjustment_ledger_update
  after update of subtotal, discount_total, shipping_total, tax_total, total, currency
  on public.orders
  for each row execute function private.sync_order_adjustments();

-- ============================================================
-- B. Payment Intent / Transaction Ledger
-- public.payments 保留为兼容投影；commerce.payment_transactions 是新账本。
-- ============================================================
create table commerce.payment_intents (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete restrict,
  provider text not null check (length(btrim(provider)) > 0),
  status text not null default 'requires_action' check (status in (
    'requires_payment_method', 'requires_action', 'processing',
    'succeeded', 'failed', 'cancelled'
  )),
  amount numeric(12, 2) not null check (amount > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  idempotency_key text not null check (length(btrim(idempotency_key)) > 0),
  provider_reference text,
  metadata jsonb not null default '{}' check (jsonb_typeof(metadata) = 'object'),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, idempotency_key)
);

create unique index payment_intents_provider_reference_uk
  on commerce.payment_intents (provider, provider_reference)
  where provider_reference is not null;
create index payment_intents_order_idx
  on commerce.payment_intents (order_id, created_at desc);

alter table public.payments
  add column payment_intent_id uuid references commerce.payment_intents (id) on delete restrict,
  add column idempotency_key text;
create unique index payments_provider_idempotency_uk
  on public.payments (provider, idempotency_key)
  where idempotency_key is not null;

create table commerce.payment_transactions (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete restrict,
  payment_intent_id uuid references commerce.payment_intents (id) on delete restrict,
  parent_transaction_id uuid references commerce.payment_transactions (id) on delete restrict,
  legacy_payment_id uuid unique references public.payments (id) on delete restrict,
  provider text not null check (length(btrim(provider)) > 0),
  kind text not null check (kind in ('authorization', 'capture', 'refund', 'void')),
  status text not null check (status in ('pending', 'succeeded', 'failed', 'cancelled')),
  amount numeric(12, 2) not null check (amount > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  provider_reference text,
  idempotency_key text,
  failure_code text,
  failure_message text,
  metadata jsonb not null default '{}' check (jsonb_typeof(metadata) = 'object'),
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index payment_transactions_provider_idempotency_uk
  on commerce.payment_transactions (provider, idempotency_key)
  where idempotency_key is not null;
create index payment_transactions_order_idx
  on commerce.payment_transactions (order_id, created_at desc);
create index payment_transactions_intent_idx
  on commerce.payment_transactions (payment_intent_id, created_at desc)
  where payment_intent_id is not null;
create index payment_transactions_parent_idx
  on commerce.payment_transactions (parent_transaction_id)
  where parent_transaction_id is not null;

-- 历史 0 元 payment 是旧版兼容事实，不把它伪装成资金交易。
insert into commerce.payment_transactions
  (order_id, payment_intent_id, legacy_payment_id, provider, kind, status,
   amount, currency, provider_reference, idempotency_key, metadata,
   processed_at, created_at, updated_at)
select p.order_id, p.payment_intent_id, p.id, p.provider,
       case p.kind when 'charge' then 'capture' else p.kind end,
       p.status, p.amount, p.currency, p.provider_ref, p.idempotency_key,
       jsonb_build_object('legacy_payment', true),
       case when p.status = 'succeeded' then p.updated_at end,
       p.created_at, p.updated_at
from public.payments p
where p.kind <> 'refund' and p.amount > 0;

insert into commerce.payment_transactions
  (order_id, payment_intent_id, parent_transaction_id, legacy_payment_id,
   provider, kind, status, amount, currency, provider_reference,
   idempotency_key, metadata, processed_at, created_at, updated_at)
select p.order_id, p.payment_intent_id,
       (select t.id from commerce.payment_transactions t
        where t.order_id = p.order_id and t.kind = 'capture' and t.status = 'succeeded'
        order by t.created_at, t.id limit 1),
       p.id, p.provider, 'refund', p.status, p.amount, p.currency,
       p.provider_ref, p.idempotency_key,
       jsonb_build_object('legacy_payment', true),
       case when p.status = 'succeeded' then p.updated_at end,
       p.created_at, p.updated_at
from public.payments p
where p.kind = 'refund' and p.amount > 0;

do $migration$
begin
  if exists (
    select 1
    from public.orders o
    left join lateral (
      select coalesce(sum(t.amount) filter (
               where t.kind = 'capture' and t.status = 'succeeded'), 0) captured,
             coalesce(sum(t.amount) filter (
               where t.kind = 'refund' and t.status = 'succeeded'), 0) refunded
      from commerce.payment_transactions t where t.order_id = o.id
    ) money on true
    where money.refunded > money.captured
       or money.captured > o.total
       or (o.financial_status in ('paid', 'partially_refunded', 'refunded')
           and o.total > 0 and money.captured < o.total)
  ) then
    raise exception 'cannot backfill payment transactions: historical payment totals are inconsistent';
  end if;
end;
$migration$;

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
      (old.status = 'requires_payment_method' and new.status in ('requires_action', 'processing', 'failed', 'cancelled'))
      or (old.status = 'requires_action' and new.status in ('processing', 'succeeded', 'failed', 'cancelled'))
      or (old.status = 'processing' and new.status in ('succeeded', 'failed', 'cancelled'))
    ) then
      raise exception 'invalid payment intent transition: % -> %', old.status, new.status;
    end if;
    new.updated_at := now();
  end if;
  return new;
end;
$$;

create trigger payment_intents_validate
  before insert or update on commerce.payment_intents
  for each row execute function private.validate_payment_intent();

create or replace function private.validate_payment_transaction()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
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

create trigger payment_transactions_validate
  before insert or update on commerce.payment_transactions
  for each row execute function private.validate_payment_transaction();

create or replace function private.sync_legacy_payment_transaction()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
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

create trigger payments_sync_transaction_insert
  after insert on public.payments
  for each row execute function private.sync_legacy_payment_transaction();
create trigger payments_sync_transaction_update
  after update on public.payments
  for each row execute function private.sync_legacy_payment_transaction();

-- ============================================================
-- C. Fulfillment Lines（关系化履约明细）
-- ============================================================
create table commerce.fulfillment_lines (
  fulfillment_id uuid not null,
  order_id uuid not null,
  order_item_id uuid not null,
  quantity integer not null check (quantity > 0),
  created_at timestamptz not null default now(),
  primary key (fulfillment_id, order_item_id),
  foreign key (fulfillment_id, order_id)
    references public.fulfillments (id, order_id) on delete restrict,
  foreign key (order_item_id, order_id)
    references public.order_items (id, order_id) on delete restrict
);

create index fulfillment_lines_order_item_idx
  on commerce.fulfillment_lines (order_item_id, fulfillment_id);
create index fulfillment_lines_order_idx
  on commerce.fulfillment_lines (order_id, fulfillment_id);

do $migration$
begin
  if exists (
    select 1 from public.fulfillments f
    where jsonb_typeof(f.items) <> 'array' or jsonb_array_length(f.items) = 0
  ) then
    raise exception 'cannot backfill fulfillment lines: historical items must be non-empty arrays';
  end if;
end;
$migration$;

insert into commerce.fulfillment_lines
  (fulfillment_id, order_id, order_item_id, quantity, created_at)
select f.id, f.order_id, (e.value ->> 'order_item_id')::uuid,
       sum((e.value ->> 'quantity')::integer)::integer, f.created_at
from public.fulfillments f
cross join lateral jsonb_array_elements(f.items) e
where jsonb_typeof(f.items) = 'array'
group by f.id, f.order_id, (e.value ->> 'order_item_id')::uuid, f.created_at;

do $migration$
begin
  if exists (
    select 1
    from public.order_items oi
    join (
      select fl.order_item_id, sum(fl.quantity) quantity
      from commerce.fulfillment_lines fl
      join public.fulfillments f on f.id = fl.fulfillment_id
      where f.status <> 'cancelled'
      group by fl.order_item_id
    ) fulfilled on fulfilled.order_item_id = oi.id
    where fulfilled.quantity > oi.quantity
  ) then
    raise exception 'cannot backfill fulfillment lines: historical fulfillment exceeds ordered quantity';
  end if;
end;
$migration$;

create or replace function private.validate_fulfillment_line()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ordered integer;
  v_fulfilled integer;
  v_status text;
begin
  -- 与 RPC 使用同一订单锁，阻止受信后台并发直写造成超发。
  perform 1 from public.orders o where o.id = new.order_id for update;
  select oi.quantity into v_ordered
  from public.order_items oi
  where oi.id = new.order_item_id and oi.order_id = new.order_id;
  if not found then
    raise exception 'fulfillment line order item does not belong to its order';
  end if;
  select f.status into v_status from public.fulfillments f where f.id = new.fulfillment_id;
  if v_status <> 'cancelled' then
    select coalesce(sum(fl.quantity), 0) into v_fulfilled
    from commerce.fulfillment_lines fl
    join public.fulfillments f on f.id = fl.fulfillment_id
    where fl.order_id = new.order_id
      and fl.order_item_id = new.order_item_id
      and f.status <> 'cancelled';
    if v_fulfilled + new.quantity > v_ordered then
      raise exception 'fulfillment quantity exceeds remaining (ordered %, fulfilled %, requested %)',
        v_ordered, v_fulfilled, new.quantity;
    end if;
  end if;
  return new;
end;
$$;

create trigger fulfillment_lines_validate
  before insert on commerce.fulfillment_lines
  for each row execute function private.validate_fulfillment_line();

create or replace function private.sync_fulfillment_lines()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
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

create trigger fulfillments_sync_lines
  after insert on public.fulfillments
  for each row execute function private.sync_fulfillment_lines();

-- create_fulfillment V3：关系化 fulfillment_lines 成为数量汇总的权威来源。
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
  v_ordered integer;
  v_fulfilled integer;
  v_qty integer;
  v_all_fulfilled boolean;
  v_any_fulfilled boolean;
begin
  if not public.is_admin() then
    raise exception 'admin only';
  end if;
  if items is null or jsonb_typeof(items) <> 'array' or jsonb_array_length(items) = 0 then
    raise exception 'items must be a non-empty array';
  end if;

  select * into v_order from public.orders o
  where o.id = create_fulfillment.order_id for update;
  if not found then
    raise exception 'order not found';
  end if;
  if v_order.status <> 'open' then
    raise exception 'order is not open (current: %)', v_order.status;
  end if;

  for v_item in select value from jsonb_array_elements(items)
  loop
    v_qty := coalesce((v_item ->> 'quantity')::integer, 0);
    if v_qty <= 0 then
      raise exception 'fulfillment quantity must be positive';
    end if;
    select oi.quantity into v_ordered
    from public.order_items oi
    where oi.id = (v_item ->> 'order_item_id')::uuid
      and oi.order_id = v_order.id;
    if not found then
      raise exception 'order item % does not belong to this order', v_item ->> 'order_item_id';
    end if;

    select coalesce(sum(fl.quantity), 0) into v_fulfilled
    from commerce.fulfillment_lines fl
    join public.fulfillments f on f.id = fl.fulfillment_id
    where fl.order_id = v_order.id
      and fl.order_item_id = (v_item ->> 'order_item_id')::uuid
      and f.status <> 'cancelled';
    if v_fulfilled + v_qty > v_ordered then
      raise exception 'fulfillment quantity exceeds remaining (ordered %, fulfilled %, requested %)',
        v_ordered, v_fulfilled, v_qty;
    end if;
  end loop;

  insert into public.fulfillments
    (order_id, items, carrier, tracking_number, tracking_url, status, shipped_at)
  values (v_order.id, items, carrier, tracking_number, tracking_url, 'shipped', now())
  returning * into v_fulfillment;

  select bool_and(oi.quantity <= coalesce(f.fulfilled_qty, 0)),
         bool_or(coalesce(f.fulfilled_qty, 0) > 0)
  into v_all_fulfilled, v_any_fulfilled
  from public.order_items oi
  left join lateral (
    select sum(fl.quantity) as fulfilled_qty
    from commerce.fulfillment_lines fl
    join public.fulfillments fu on fu.id = fl.fulfillment_id
    where fl.order_id = v_order.id
      and fl.order_item_id = oi.id
      and fu.status <> 'cancelled'
  ) f on true
  where oi.order_id = v_order.id;

  update public.orders
  set fulfillment_status = case
        when v_all_fulfilled then 'fulfilled'
        when v_any_fulfilled then 'partially_fulfilled'
        else 'unfulfilled' end,
      status = case when v_all_fulfilled and financial_status = 'paid' then 'completed' else status end,
      completed_at = case when v_all_fulfilled and financial_status = 'paid' then now() else completed_at end
  where id = v_order.id;

  insert into public.order_events (order_id, actor_id, type, data)
  values (v_order.id, auth.uid(), 'fulfillment_created',
          jsonb_build_object('fulfillment_id', v_fulfillment.id,
                             'tracking_number', tracking_number));
  return v_fulfillment;
end;
$$;

-- ============================================================
-- D. Refund / Refund Lines
-- ============================================================
create table commerce.refunds (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete restrict,
  payment_transaction_id uuid unique
    references commerce.payment_transactions (id) on delete restrict,
  legacy_payment_id uuid unique references public.payments (id) on delete restrict,
  status text not null check (status in ('pending', 'succeeded', 'failed', 'cancelled')),
  source text not null check (source in ('items', 'custom_amount', 'remaining', 'legacy')),
  amount numeric(12, 2) not null check (amount > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  reason text,
  restock_requested boolean not null default false,
  actor_id uuid references public.profiles (id) on delete set null,
  metadata jsonb not null default '{}' check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  unique (id, order_id)
);

create index refunds_order_idx on commerce.refunds (order_id, created_at desc);

create table commerce.refund_lines (
  refund_id uuid not null,
  order_id uuid not null,
  order_item_id uuid not null,
  quantity integer not null check (quantity > 0),
  amount numeric(12, 2) not null check (amount >= 0),
  restocked_quantity integer not null default 0
    check (restocked_quantity >= 0 and restocked_quantity <= quantity),
  created_at timestamptz not null default now(),
  primary key (refund_id, order_item_id),
  foreign key (refund_id, order_id)
    references commerce.refunds (id, order_id) on delete restrict,
  foreign key (order_item_id, order_id)
    references public.order_items (id, order_id) on delete restrict
);

create index refund_lines_order_item_idx
  on commerce.refund_lines (order_item_id, refund_id);

create or replace function private.validate_refund_header()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
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

create trigger refunds_validate
  before insert on commerce.refunds
  for each row execute function private.validate_refund_header();

create or replace function private.assert_refund_lines_total()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
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

create constraint trigger refund_lines_total_matches_header
  after insert or update or delete on commerce.refund_lines
  deferrable initially deferred
  for each row execute function private.assert_refund_lines_total();

insert into commerce.refunds
  (order_id, payment_transaction_id, legacy_payment_id, status, source,
   amount, currency, metadata, created_at)
select p.order_id, t.id, p.id, p.status, 'legacy', p.amount, p.currency,
       jsonb_build_object('backfilled', true), p.created_at
from public.payments p
join commerce.payment_transactions t on t.legacy_payment_id = p.id
where p.kind = 'refund' and p.amount > 0;

-- refund_order V3：沿用已加固 V1 核心，并在同一事务内写 Refund V2 账本。
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
  if not public.is_admin() then
    raise exception 'admin only';
  end if;
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
             'order_item_id', x.order_item_id, 'quantity', x.quantity)
             order by x.order_item_id)
    into v_items
    from (
      select e.value ->> 'order_item_id' as order_item_id,
             sum((e.value ->> 'quantity')::integer)::integer as quantity
      from jsonb_array_elements(items) e
      group by e.value ->> 'order_item_id'
    ) x;

    select coalesce(jsonb_object_agg(oi.id::text, jsonb_build_object(
             'quantity', oi.refunded_quantity, 'amount', oi.refunded_amount)), '{}'::jsonb)
    into v_before_lines
    from public.order_items oi
    where oi.order_id = refund_order.order_id
      and oi.id in (
        select (e.value ->> 'order_item_id')::uuid
        from jsonb_array_elements(v_items) e
      );
  end if;

  select coalesce(array_agg(p.id), '{}'::uuid[]),
         coalesce(sum(p.amount), 0)
  into v_before_payment_ids, v_refunds_before
  from public.payments p
  where p.order_id = refund_order.order_id
    and p.kind = 'refund' and p.status = 'succeeded';

  perform set_config('commerce.refund_write', 'on', true);
  v_order := private.refund_order(
    refund_order.order_id, v_items, refund_order.amount, refund_order.reason,
    refund_order.restock, refund_order.provider
  );
  perform set_config('commerce.refund_write', 'off', true);

  select coalesce(sum(p.amount) filter (where p.kind = 'charge'), 0),
         coalesce(sum(p.amount) filter (where p.kind = 'refund'), 0)
  into v_captured, v_refunds_after
  from public.payments p
  where p.order_id = refund_order.order_id and p.status = 'succeeded';
  if v_refunds_after <= v_refunds_before then
    raise exception 'refund amount must be positive';
  end if;
  if v_refunds_after > v_captured then
    raise exception 'refund amount exceeds captured amount (refunded %, captured %)',
      v_refunds_after, v_captured;
  end if;

  select p.* into v_payment
  from public.payments p
  where p.order_id = refund_order.order_id and p.kind = 'refund'
    and not (p.id = any(v_before_payment_ids))
  order by p.created_at desc, p.id desc limit 1;
  if not found then
    raise exception 'refund payment was not recorded';
  end if;
  select t.id into v_transaction_id
  from commerce.payment_transactions t where t.legacy_payment_id = v_payment.id;
  if not found then
    raise exception 'refund payment transaction was not recorded';
  end if;

  v_source := case when v_items is not null then 'items'
                   when amount is not null then 'custom_amount'
                   else 'remaining' end;
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
      select oi.refunded_quantity, oi.refunded_amount
      into v_after_qty, v_after_amount
      from public.order_items oi
      where oi.id = (v_item ->> 'order_item_id')::uuid;

      insert into commerce.refund_lines
        (refund_id, order_id, order_item_id, quantity, amount, restocked_quantity)
      values (
        v_refund_id, v_order.id, (v_item ->> 'order_item_id')::uuid,
        v_after_qty - v_before_qty, v_after_amount - v_before_amount,
        case when restock and exists (
          select 1 from public.inventory_movements im
          where im.order_id = v_order.id
            and im.variant_id = (select oi.variant_id from public.order_items oi
                                 where oi.id = (v_item ->> 'order_item_id')::uuid)
            and im.reason = 'order' and im.delta < 0
        ) then v_after_qty - v_before_qty else 0 end
      );
    end loop;
  end if;

  return private.storefront_order_json(v_order);
end;
$$;

-- ============================================================
-- E. Command Idempotency（V2 写入口共用）
-- ============================================================
create table commerce.command_idempotency (
  scope text not null check (scope in ('order.create', 'fulfillment.create', 'order.refund')),
  subject_id uuid not null,
  idempotency_key text not null
    check (length(btrim(idempotency_key)) between 1 and 200),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  resource_type text not null,
  resource_id uuid not null,
  check ((scope = 'order.create' and resource_type = 'order')
      or (scope = 'fulfillment.create' and resource_type = 'fulfillment')
      or (scope = 'order.refund' and resource_type = 'refund')),
  created_at timestamptz not null default now(),
  primary key (scope, subject_id, idempotency_key)
);

create index command_idempotency_resource_idx
  on commerce.command_idempotency (resource_type, resource_id);

create or replace function private.command_request_hash(p_request jsonb)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select pg_catalog.encode(extensions.digest(p_request::text, 'sha256'), 'hex');
$$;

create or replace function private.fulfillment_json(p_fulfillment public.fulfillments)
returns jsonb
language sql
immutable
strict
set search_path = ''
as $$
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

create or replace function private.canonical_variant_quantities(p_items jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
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
    if jsonb_typeof(v_item) <> 'object' or coalesce(v_item ->> 'variant_id', '') = '' then
      raise exception 'each item requires variant_id';
    end if;
    perform (v_item ->> 'variant_id')::uuid;
    if coalesce(v_item ->> 'quantity', '') !~ '^[1-9][0-9]*$' then
      raise exception 'item quantity must be a positive integer';
    end if;
  end loop;
  select jsonb_agg(jsonb_build_object(
           'variant_id', x.variant_id, 'quantity', x.quantity)
           order by x.variant_id)
  into v_result
  from (
    select (e.value ->> 'variant_id')::uuid variant_id,
           sum((e.value ->> 'quantity')::integer)::integer quantity
    from jsonb_array_elements(p_items) e
    group by (e.value ->> 'variant_id')::uuid
  ) x;
  return v_result;
end;
$$;

create or replace function private.canonical_order_item_quantities(p_items jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
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
$$;

-- ============================================================
-- F. Transactional Outbox
-- ============================================================
create table commerce.outbox_events (
  id bigint generated always as identity primary key,
  event_id uuid not null default gen_random_uuid() unique,
  aggregate_type text not null check (length(btrim(aggregate_type)) > 0),
  aggregate_id uuid not null,
  event_type text not null check (length(btrim(event_type)) > 0),
  payload jsonb not null default '{}' check (jsonb_typeof(payload) = 'object'),
  idempotency_key text not null unique,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'published', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  published_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);

create index outbox_events_claim_idx
  on commerce.outbox_events (status, available_at, id)
  where status in ('pending', 'failed', 'processing');

create or replace function private.enqueue_outbox_event(
  p_aggregate_type text,
  p_aggregate_id uuid,
  p_event_type text,
  p_payload jsonb,
  p_idempotency_key text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
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

-- 既有事件回填；同一 order_event 永远只生成一个 outbox event。
insert into commerce.outbox_events
  (aggregate_type, aggregate_id, event_type, payload, idempotency_key, created_at)
select 'order', e.order_id, e.type,
       e.data || jsonb_build_object('order_event_id', e.id, 'actor_id', e.actor_id),
       'order-event:' || e.id, e.created_at
from public.order_events e;

create or replace function private.order_event_to_outbox()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.enqueue_outbox_event(
    'order', new.order_id, new.type,
    new.data || jsonb_build_object('order_event_id', new.id, 'actor_id', new.actor_id),
    'order-event:' || new.id
  );
  return new;
end;
$$;

create trigger order_events_enqueue_outbox
  after insert on public.order_events
  for each row execute function private.order_event_to_outbox();

create or replace function private.payment_intent_to_outbox()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
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

create trigger payment_intents_enqueue_outbox
  after insert or update of status on commerce.payment_intents
  for each row execute function private.payment_intent_to_outbox();

create or replace function private.payment_transaction_to_outbox()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
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

create trigger payment_transactions_enqueue_outbox
  after insert or update of status on commerce.payment_transactions
  for each row execute function private.payment_transaction_to_outbox();

create or replace function private.refund_to_outbox()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
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

create trigger refunds_enqueue_outbox
  after insert on commerce.refunds
  for each row execute function private.refund_to_outbox();

-- ============================================================
-- G. 不可变性与状态保护
-- ============================================================
create or replace function private.protect_immutable_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception '% is immutable', tg_table_name;
end;
$$;

create trigger command_idempotency_immutable
  before update or delete on commerce.command_idempotency
  for each row execute function private.protect_immutable_row();
create trigger command_idempotency_no_truncate
  before truncate on commerce.command_idempotency
  for each statement execute function private.protect_immutable_row();

create trigger payment_intents_no_delete
  before delete on commerce.payment_intents
  for each row execute function private.protect_immutable_row();
create trigger payment_intents_no_truncate
  before truncate on commerce.payment_intents
  for each statement execute function private.protect_immutable_row();
create trigger payment_transactions_no_delete
  before delete on commerce.payment_transactions
  for each row execute function private.protect_immutable_row();
create trigger payment_transactions_no_truncate
  before truncate on commerce.payment_transactions
  for each statement execute function private.protect_immutable_row();

create trigger order_adjustments_append_only
  before update or delete on commerce.order_adjustments
  for each row execute function private.protect_audit_row();
create trigger order_adjustments_no_truncate
  before truncate on commerce.order_adjustments
  for each statement execute function private.protect_audit_row();

create trigger fulfillment_lines_immutable
  before update or delete on commerce.fulfillment_lines
  for each row execute function private.protect_immutable_row();
create trigger fulfillment_lines_no_truncate
  before truncate on commerce.fulfillment_lines
  for each statement execute function private.protect_immutable_row();
create trigger refund_lines_immutable
  before update or delete on commerce.refund_lines
  for each row execute function private.protect_immutable_row();
create trigger refund_lines_no_truncate
  before truncate on commerce.refund_lines
  for each statement execute function private.protect_immutable_row();
create trigger refunds_append_only
  before update or delete on commerce.refunds
  for each row execute function private.protect_audit_row();
create trigger refunds_no_truncate
  before truncate on commerce.refunds
  for each statement execute function private.protect_audit_row();

create or replace function private.protect_paid_order_snapshot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
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

create trigger orders_paid_snapshot_immutable
  before update on public.orders
  for each row execute function private.protect_paid_order_snapshot();

create or replace function private.validate_order_financial_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
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

create trigger orders_financial_status_validate
  before update of financial_status on public.orders
  for each row execute function private.validate_order_financial_status();

create trigger orders_no_delete
  before delete on public.orders
  for each row execute function private.protect_immutable_row();
create trigger orders_no_truncate
  before truncate on public.orders
  for each statement execute function private.protect_immutable_row();

create or replace function private.protect_order_item_snapshot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
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

create trigger order_items_snapshot_immutable
  before insert or update or delete on public.order_items
  for each row execute function private.protect_order_item_snapshot();

create or replace function private.protect_fulfillment_record()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
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

create trigger fulfillments_commercial_fields_immutable
  before update or delete on public.fulfillments
  for each row execute function private.protect_fulfillment_record();
create trigger fulfillments_no_truncate
  before truncate on public.fulfillments
  for each statement execute function private.protect_fulfillment_record();

create or replace function private.recalculate_order_fulfillment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_all_fulfilled boolean;
  v_any_fulfilled boolean;
begin
  if new.status = old.status then return new; end if;
  select * into v_order from public.orders o where o.id = new.order_id for update;

  select bool_and(oi.quantity <= coalesce(f.fulfilled_qty, 0)),
         bool_or(coalesce(f.fulfilled_qty, 0) > 0)
  into v_all_fulfilled, v_any_fulfilled
  from public.order_items oi
  left join lateral (
    select sum(fl.quantity) as fulfilled_qty
    from commerce.fulfillment_lines fl
    join public.fulfillments fu on fu.id = fl.fulfillment_id
    where fl.order_id = new.order_id
      and fl.order_item_id = oi.id
      and fu.status <> 'cancelled'
  ) f on true
  where oi.order_id = new.order_id;

  update public.orders
  set fulfillment_status = case
        when v_all_fulfilled then 'fulfilled'
        when v_any_fulfilled then 'partially_fulfilled'
        else 'unfulfilled' end,
      status = case
        when v_all_fulfilled and financial_status = 'paid' then 'completed'
        when not v_all_fulfilled and status = 'completed'
             and financial_status in ('paid', 'partially_refunded') then 'open'
        else status end,
      completed_at = case
        when v_all_fulfilled and financial_status = 'paid'
          then coalesce(completed_at, now())
        when not v_all_fulfilled and financial_status in ('paid', 'partially_refunded')
          then null
        else completed_at end
  where id = new.order_id;

  insert into public.order_events (order_id, actor_id, type, data)
  values (new.order_id, auth.uid(),
          case when new.status = 'cancelled' then 'fulfillment_cancelled'
               else 'fulfillment_' || new.status end,
          jsonb_build_object('fulfillment_id', new.id,
                             'before', old.status, 'after', new.status));
  return new;
end;
$$;

create trigger fulfillments_recalculate_order
  after update of status on public.fulfillments
  for each row execute function private.recalculate_order_fulfillment();

create or replace function private.protect_legacy_payment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
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

create trigger payments_commercial_fields_immutable
  before update or delete on public.payments
  for each row execute function private.protect_legacy_payment();
create trigger payments_no_truncate
  before truncate on public.payments
  for each statement execute function private.protect_legacy_payment();

create or replace function private.protect_outbox_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
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

create trigger outbox_events_protect
  before update or delete on commerce.outbox_events
  for each row execute function private.protect_outbox_event();
create trigger outbox_events_no_truncate
  before truncate on commerce.outbox_events
  for each statement execute function private.protect_outbox_event();

-- ============================================================
-- H. 幂等业务命令 RPC（保留 V1；新集成优先使用 V2）
-- ============================================================
create or replace function public.create_order_v2(
  items jsonb,
  idempotency_key text,
  address jsonb default null,
  address_id uuid default null,
  shipping_method_id uuid default null,
  discount_code text default null,
  note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subject_id uuid := auth.uid();
  v_key text := btrim(idempotency_key);
  v_items jsonb;
  v_address jsonb;
  v_request_hash text;
  v_response jsonb;
  v_record commerce.command_idempotency;
  v_order public.orders;
begin
  if v_subject_id is null then raise exception 'authentication required'; end if;
  if coalesce(v_key, '') = '' or length(v_key) > 200 then
    raise exception 'idempotency_key is required and must be at most 200 characters';
  end if;
  v_items := private.canonical_variant_quantities(items);
  v_address := private.normalize_checkout_address(address);
  v_request_hash := private.command_request_hash(jsonb_build_object(
    'items', v_items, 'address', v_address, 'address_id', address_id,
    'shipping_method_id', shipping_method_id,
    'discount_code', upper(nullif(btrim(discount_code), '')), 'note', note
  ));

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'order.create:' || v_subject_id || ':' || v_key, 0));
  select * into v_record from commerce.command_idempotency c
  where c.scope = 'order.create' and c.subject_id = v_subject_id
    and c.idempotency_key = v_key;
  if found then
    if v_record.request_hash <> v_request_hash then
      raise exception 'idempotency key was used with different order parameters';
    end if;
    select * into v_order from public.orders o
    where o.id = v_record.resource_id and o.customer_id = v_subject_id;
    if not found then raise exception 'idempotency record points to a missing order'; end if;
    return private.storefront_order_json(v_order);
  end if;

  v_response := public.create_order(
    v_items, v_address, address_id, shipping_method_id,
    upper(nullif(btrim(discount_code), '')), note
  );
  insert into commerce.command_idempotency
    (scope, subject_id, idempotency_key, request_hash, resource_type, resource_id)
  values ('order.create', v_subject_id, v_key, v_request_hash,
          'order', (v_response ->> 'id')::uuid);
  return v_response;
end;
$$;

create or replace function public.create_fulfillment_v2(
  order_id uuid,
  items jsonb,
  idempotency_key text,
  carrier text default '',
  tracking_number text default '',
  tracking_url text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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

create or replace function public.refund_order_v2(
  order_id uuid,
  idempotency_key text,
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

-- ============================================================
-- I. 支付服务 RPC（仅 service_role）
-- ============================================================
create or replace function public.create_payment_intent(
  order_id uuid,
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
  v_order public.orders;
  v_intent commerce.payment_intents;
  v_provider text := lower(btrim(provider));
  v_key text := btrim(idempotency_key);
begin
  if coalesce(v_provider, '') = '' or coalesce(v_key, '') = '' then
    raise exception 'provider and idempotency_key are required';
  end if;
  if metadata is null or jsonb_typeof(metadata) <> 'object' then
    raise exception 'metadata must be an object';
  end if;

  select * into v_order from public.orders o
  where o.id = create_payment_intent.order_id for update;
  if not found then raise exception 'order not found'; end if;

  select * into v_intent from commerce.payment_intents i
  where i.provider = v_provider and i.idempotency_key = v_key;
  if found then
    if (v_intent.order_id, v_intent.amount, v_intent.currency)
       is distinct from (v_order.id, v_order.total, v_order.currency) then
      raise exception 'idempotency key was used for another payment intent';
    end if;
  else
    if v_order.status <> 'open' or v_order.financial_status <> 'pending' then
      raise exception 'order is not payable';
    end if;
    if v_order.total <= 0 then
      raise exception 'zero-amount orders do not require a payment intent';
    end if;
    insert into commerce.payment_intents
      (order_id, provider, amount, currency, idempotency_key, metadata)
    values (v_order.id, v_provider, v_order.total, v_order.currency, v_key, metadata)
    returning * into v_intent;
  end if;

  return jsonb_build_object(
    'id', v_intent.id, 'order_id', v_intent.order_id,
    'provider', v_intent.provider, 'status', v_intent.status,
    'amount', v_intent.amount, 'currency', v_intent.currency,
    'provider_reference', v_intent.provider_reference,
    'created_at', v_intent.created_at, 'updated_at', v_intent.updated_at
  );
end;
$$;

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

  select * into v_transaction
  from commerce.payment_transactions t
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

  if v_intent.status = 'succeeded' then
    raise exception 'payment intent is already captured';
  end if;
  if v_intent.status not in ('requires_action', 'processing') then
    raise exception 'payment intent cannot be captured from status %', v_intent.status;
  end if;

  select * into v_order from public.orders o where o.id = v_intent.order_id for update;
  if v_order.status <> 'open' or v_order.financial_status <> 'pending' then
    raise exception 'order is not payable';
  end if;
  if v_order.total <> v_intent.amount or v_order.currency <> v_intent.currency then
    raise exception 'order total changed after payment intent creation';
  end if;

  insert into public.payments
    (order_id, provider, kind, status, amount, currency, provider_ref, raw,
     payment_intent_id, idempotency_key)
  values (v_order.id, v_intent.provider, 'charge', 'succeeded',
          v_intent.amount, v_intent.currency, v_reference, raw,
          v_intent.id, v_key)
  returning * into v_payment;

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
                             'transaction_id', v_transaction.id));

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
-- J. Worker Outbox RPC（仅 service_role）
-- ============================================================
create or replace function public.claim_outbox_events(
  worker_id text,
  max_events integer default 50,
  lease_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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

create or replace function public.complete_outbox_event(
  event_id uuid,
  worker_id text,
  succeeded boolean,
  error_message text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
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

-- ============================================================
-- K. 安全 Order Ledger DTO（authenticated owner/admin，service_role）
-- ============================================================
create or replace function public.get_order_ledger(order_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
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

-- ============================================================
-- L. RLS / ACL：commerce 物理账本默认不可直接访问
-- ============================================================
alter table commerce.order_adjustments enable row level security;
alter table commerce.payment_intents enable row level security;
alter table commerce.payment_transactions enable row level security;
alter table commerce.fulfillment_lines enable row level security;
alter table commerce.refunds enable row level security;
alter table commerce.refund_lines enable row level security;
alter table commerce.command_idempotency enable row level security;
alter table commerce.outbox_events enable row level security;

revoke all on all tables in schema commerce from public, anon, authenticated;
revoke all on all sequences in schema commerce from public, anon, authenticated;
revoke all on all functions in schema commerce from public, anon, authenticated;
revoke all on all functions in schema private from public, anon, authenticated;
alter default privileges in schema commerce revoke all on tables from public, anon, authenticated;
alter default privileges in schema commerce revoke all on sequences from public, anon, authenticated;
alter default privileges in schema commerce revoke all on functions from public, anon, authenticated;
-- shipping_methods CHECK 仍需 authenticated 执行这个 OID 绑定的辅助函数。
grant execute on function private.valid_country_codes(text[]) to authenticated, service_role;

revoke all on function public.refund_order(uuid, jsonb, numeric, text, boolean, text)
  from public, anon, authenticated;
grant execute on function public.refund_order(uuid, jsonb, numeric, text, boolean, text)
  to authenticated;

revoke all on function public.create_order_v2(jsonb, text, jsonb, uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.create_fulfillment_v2(uuid, jsonb, text, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.refund_order_v2(uuid, text, jsonb, numeric, text, boolean, text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_order_v2(jsonb, text, jsonb, uuid, uuid, text, text)
  to authenticated;
grant execute on function public.create_fulfillment_v2(uuid, jsonb, text, text, text, text)
  to authenticated;
grant execute on function public.refund_order_v2(uuid, text, jsonb, numeric, text, boolean, text)
  to authenticated;

revoke all on function public.create_payment_intent(uuid, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.capture_payment_intent(uuid, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.claim_outbox_events(text, integer, integer)
  from public, anon, authenticated;
revoke all on function public.complete_outbox_event(uuid, text, boolean, text)
  from public, anon, authenticated;
grant execute on function public.create_payment_intent(uuid, text, text, jsonb) to service_role;
grant execute on function public.capture_payment_intent(uuid, text, text, jsonb) to service_role;
grant execute on function public.claim_outbox_events(text, integer, integer) to service_role;
grant execute on function public.complete_outbox_event(uuid, text, boolean, text) to service_role;

revoke all on function public.get_order_ledger(uuid) from public, anon, authenticated;
grant execute on function public.get_order_ledger(uuid) to authenticated, service_role;
