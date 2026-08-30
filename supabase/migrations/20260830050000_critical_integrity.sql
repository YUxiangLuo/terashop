-- ============================================================
-- 7. 商用化第一批修复：交易不变量、API 返回边界、并发与目录可见性
--
-- 本迁移只做向前兼容修复，不修改既有 migration 历史：
--   - 国家码统一与金额约束
--   - 客户可调用订单 RPC 返回安全 JSON（不泄露 admin_note）
--   - 退款总额不得超过成功收款、履约请求先合并重复行
--   - 已支付订单不可通过改地址直接重定价
--   - 取消/退款回补以原始库存流水为准，不依赖变体当前 track_inventory
--   - 默认地址和最后 admin 的并发保护
--   - 库存/订单审计 append-only
--   - Storefront 子资源继承父商品发布状态
--   - Metafield definition 类型与 owner 完整性
-- ============================================================

-- ---------- 私有 schema：保存物理实现，public 只保留稳定包装 RPC ----------
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- ---------- 国家码规范 ----------
create or replace function private.normalize_country_code(
  p_country text,
  p_allow_wildcard boolean default false
)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_country text := upper(btrim(p_country));
begin
  if p_allow_wildcard and v_country = '*' then
    return v_country;
  end if;
  if v_country is null or v_country !~ '^[A-Z]{2}$' then
    raise exception using
      errcode = '22023',
      message = format('invalid ISO country code: %s', coalesce(p_country, '<null>'));
  end if;
  return v_country;
end;
$$;

create or replace function private.normalize_checkout_address(p_address jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_address is null then
    return null;
  end if;
  if jsonb_typeof(p_address) <> 'object' then
    raise exception using errcode = '22023', message = 'address must be an object';
  end if;
  return p_address || jsonb_build_object(
    'country', private.normalize_country_code(coalesce(p_address ->> 'country', 'CN'))
  );
end;
$$;

create or replace function private.valid_country_codes(p_countries text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(bool_and(c is not null and c ~ '^[A-Z]{2}$'), true)
  from unnest(p_countries) as x(c);
$$;

create or replace function private.normalize_address_country()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.country := private.normalize_country_code(coalesce(new.country, 'CN'));
  return new;
end;
$$;

create or replace function private.normalize_tax_country()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.country := private.normalize_country_code(coalesce(new.country, '*'), true);
  return new;
end;
$$;

create or replace function private.normalize_shipping_countries()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  select coalesce(array_agg(private.normalize_country_code(c) order by ord), '{}')
  into new.countries
  from unnest(coalesce(new.countries, '{}')) with ordinality as x(c, ord);
  return new;
end;
$$;

update public.addresses
set country = private.normalize_country_code(country)
where country <> private.normalize_country_code(country);

update public.tax_rates
set country = private.normalize_country_code(country, true)
where country <> private.normalize_country_code(country, true);

with normalized as (
  select sm.id,
         (
           select coalesce(array_agg(private.normalize_country_code(x.c) order by x.ord), '{}')
           from unnest(sm.countries) with ordinality as x(c, ord)
         ) as countries
  from public.shipping_methods sm
)
update public.shipping_methods sm
set countries = n.countries
from normalized n
where sm.id = n.id and sm.countries is distinct from n.countries;

create trigger addresses_normalize_country
  before insert or update of country on public.addresses
  for each row execute function private.normalize_address_country();

create trigger tax_rates_normalize_country
  before insert or update of country on public.tax_rates
  for each row execute function private.normalize_tax_country();

create trigger shipping_methods_normalize_countries
  before insert or update of countries on public.shipping_methods
  for each row execute function private.normalize_shipping_countries();

alter table public.addresses
  add constraint addresses_country_iso_chk check (country ~ '^[A-Z]{2}$');
alter table public.tax_rates
  add constraint tax_rates_country_iso_chk check (country = '*' or country ~ '^[A-Z]{2}$'),
  add constraint tax_rates_rate_range_chk check (rate >= 0 and rate <= 1);
alter table public.shipping_methods
  add constraint shipping_methods_countries_iso_chk
    check (private.valid_country_codes(countries));

-- 当前税务引擎每个国家只选择一条有效税率，数据库也必须保证这一语义。
-- 历史库若已有重复配置，保留最新一条有效记录，其余记录仅停用、不删除。
with ranked as (
  select id,
         row_number() over (partition by country order by created_at desc, id desc) as rn
  from public.tax_rates
  where is_active
)
update public.tax_rates t
set is_active = false
from ranked r
where t.id = r.id and r.rn > 1;

create unique index tax_rates_one_active_country_idx
  on public.tax_rates (country) where is_active;

-- ---------- 核心金额与促销配置约束 ----------
-- 订单快照是历史商业记录，只规范国家码大小写，不重算金额，也不改历史 updated_at。
alter table public.orders disable trigger orders_updated_at;
update public.orders
set shipping_address = shipping_address || jsonb_build_object(
  'country', private.normalize_country_code(coalesce(shipping_address ->> 'country', 'CN'))
)
where jsonb_typeof(shipping_address) = 'object'
  and (shipping_address ->> 'country') is distinct from
      private.normalize_country_code(coalesce(shipping_address ->> 'country', 'CN'));

update public.orders
set billing_address = billing_address || jsonb_build_object(
  'country', private.normalize_country_code(coalesce(billing_address ->> 'country', 'CN'))
)
where billing_address is not null
  and jsonb_typeof(billing_address) = 'object'
  and (billing_address ->> 'country') is distinct from
      private.normalize_country_code(coalesce(billing_address ->> 'country', 'CN'));
alter table public.orders enable trigger orders_updated_at;

alter table public.orders
  add constraint orders_discount_range_chk
    check (discount_total >= 0 and discount_total <= subtotal),
  add constraint orders_components_nonnegative_chk
    check (shipping_total >= 0 and tax_total >= 0),
  add constraint orders_total_formula_chk
    check (total = round(subtotal - discount_total + shipping_total + tax_total, 2)),
  add constraint orders_shipping_address_country_chk
    check (
      jsonb_typeof(shipping_address) = 'object'
      and shipping_address ? 'country'
      and (shipping_address ->> 'country') ~ '^[A-Z]{2}$'
    ),
  add constraint orders_billing_address_country_chk
    check (
      billing_address is null or (
        jsonb_typeof(billing_address) = 'object'
        and billing_address ? 'country'
        and (billing_address ->> 'country') ~ '^[A-Z]{2}$'
      )
    );

alter table public.order_items
  add constraint order_items_refunded_amount_within_net_chk
    check (refunded_amount <= line_total);

alter table public.payments drop constraint payments_amount_nonneg;
-- 旧版本可能为历史 0 元订单写过 0 元 payment。保留该账本事实，但禁止所有新行继续写 0。
alter table public.payments
  add constraint payments_amount_positive_chk check (amount > 0) not valid;

alter table public.promotions
  add constraint promotions_code_nonempty_chk
    check (code is null or length(btrim(code)) > 0),
  add constraint promotions_usage_limit_positive_chk
    check (usage_limit is null or usage_limit > 0),
  add constraint promotions_used_count_nonnegative_chk
    check (used_count >= 0),
  add constraint promotions_used_within_limit_chk
    check (usage_limit is null or used_count <= usage_limit),
  add constraint promotions_per_customer_limit_positive_chk
    check (per_customer_limit > 0),
  add constraint promotions_schedule_chk
    check (starts_at is null or ends_at is null or starts_at <= ends_at);

-- ---------- 默认地址：数据库唯一约束 + BEFORE trigger ----------
create or replace function public.enforce_single_default_address()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- 同一客户串行切换默认地址；唯一索引仍作为最终不变量兜底。
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('tera-headless:default-address:' || new.customer_id::text, 0)
  );
  update public.addresses
  set is_default = false
  where customer_id = new.customer_id
    and id <> new.id
    and is_default;
  return new;
end;
$$;

-- 清理旧版本并发竞争可能留下的重复默认地址，保留最近更新的一条。
with ranked as (
  select id,
         row_number() over (
           partition by customer_id order by updated_at desc, created_at desc, id desc
         ) as rn
  from public.addresses
  where is_default
)
update public.addresses a
set is_default = false
from ranked r
where a.id = r.id and r.rn > 1;

drop trigger addresses_single_default on public.addresses;
create trigger addresses_single_default
  before insert or update of is_default on public.addresses
  for each row
  when (new.is_default)
  execute function public.enforce_single_default_address();

create unique index addresses_one_default_per_customer_idx
  on public.addresses (customer_id) where is_default;

-- ---------- Metafield definition 与 owner 完整性 ----------
create or replace function private.enforce_metafield_integrity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_definition_type text;
begin
  select d.type into v_definition_type
  from public.metafield_definitions d
  where d.owner_type = new.owner_type
    and d.namespace = new.namespace
    and d.key = new.key;

  if found and new.type <> v_definition_type then
    raise exception 'metafield "%" type % does not match definition type %',
      new.key, new.type, v_definition_type;
  end if;

  case new.owner_type
    when 'product' then
      if not exists (select 1 from public.products p where p.id = new.owner_id) then
        raise exception 'metafield owner product not found: %', new.owner_id;
      end if;
    when 'variant' then
      if not exists (select 1 from public.product_variants v where v.id = new.owner_id) then
        raise exception 'metafield owner variant not found: %', new.owner_id;
      end if;
    when 'category' then
      if not exists (select 1 from public.categories c where c.id = new.owner_id) then
        raise exception 'metafield owner category not found: %', new.owner_id;
      end if;
    when 'customer' then
      if not exists (select 1 from public.profiles p where p.id = new.owner_id) then
        raise exception 'metafield owner customer not found: %', new.owner_id;
      end if;
    when 'order' then
      if not exists (select 1 from public.orders o where o.id = new.owner_id) then
        raise exception 'metafield owner order not found: %', new.owner_id;
      end if;
    when 'shop' then
      null; -- 单店部署模式下 shop 使用约定的 singleton UUID，后续由 store_settings 替代。
  end case;

  return new;
end;
$$;

create trigger metafields_definition_integrity
  before insert or update on public.metafields
  for each row execute function private.enforce_metafield_integrity();

create or replace function private.enforce_metafield_definition_compatibility()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.metafields m
    where m.owner_type = new.owner_type
      and m.namespace = new.namespace
      and m.key = new.key
      and m.type <> new.type
  ) then
    raise exception 'metafield definition type % conflicts with existing values', new.type;
  end if;
  return new;
end;
$$;

create trigger metafield_definitions_existing_values_compatible
  before insert or update of owner_type, namespace, key, type
  on public.metafield_definitions
  for each row execute function private.enforce_metafield_definition_compatibility();

-- ============================================================
-- 将既有物理 RPC 移入 private，并在 public 暴露安全包装。
-- 这样无需复制 create_order/price_checkout 的大段稳定实现，同时可在包装层
-- 统一规范输入、执行交易后置不变量，并控制返回字段。
-- ============================================================
alter function public.price_checkout(jsonb, jsonb, uuid, text) set schema private;
alter function public.create_order(jsonb, jsonb, uuid, uuid, text, text) set schema private;
alter function public.cancel_order(uuid, text) set schema private;
alter function public.update_order_address(uuid, jsonb, uuid) set schema private;
alter function public.create_fulfillment(uuid, jsonb, text, text, text) set schema private;
alter function public.refund_order(uuid, jsonb, numeric, text, boolean, text) set schema private;
alter function public.set_user_role(uuid, text) set schema private;
alter function public.mark_order_paid(uuid, text, text) set schema private;

-- V1 边界修复：没有正运费的 checkout 中，free_shipping 不是候选，不能错误取得
-- 独占权；相同 priority/created_at 时显式码优先并以 code/name/UUID 排序，确保结果稳定。
-- 这里对已固定的历史核心函数做带断言的窄补丁，避免复制整套 V1 引擎。
do $migration$
declare
  v_definition text;
  v_filter_old constant text := $patch$
    where p.is_active
      and (p.starts_at is null or now() >= p.starts_at)$patch$;
  v_filter_new constant text := $patch$
    where p.is_active
      and (
        p.type <> 'free_shipping'
        or exists (
          select 1 from public.shipping_methods candidate_shipping
          where candidate_shipping.id = shipping_method_id
            and candidate_shipping.is_active
            and candidate_shipping.price > 0
        )
      )
      and (p.starts_at is null or now() >= p.starts_at)$patch$;
  v_order_old constant text := '    order by p.priority, p.created_at';
  v_order_new constant text :=
    '    order by p.priority, p.created_at, (p.code is null), p.code, p.name, p.id';
begin
  select pg_catalog.pg_get_functiondef(
    'private.price_checkout(jsonb,jsonb,uuid,text)'::regprocedure
  ) into v_definition;

  if pg_catalog.strpos(v_definition, v_filter_old) = 0
     or pg_catalog.strpos(v_definition, v_order_old) = 0 then
    raise exception 'price_checkout V1 definition changed; apply the boundary fix manually';
  end if;

  v_definition := pg_catalog.replace(v_definition, v_filter_old, v_filter_new);
  v_definition := pg_catalog.replace(v_definition, v_order_old, v_order_new);
  execute v_definition;
end;
$migration$;

-- 与取消订单保持同一库存语义：是否允许退款回补取决于下单时真实存在的扣减流水，
-- 而不是变体退款时的 track_inventory 当前值；从未扣减的商品也不得回落默认仓增库。
do $migration$
declare
  v_definition text;
  v_old constant text := $patch$      if restock and v_line.track_inventory then
        select im.location_id into v_src_location
        from public.inventory_movements im
        where im.order_id = v_order.id
          and im.variant_id = v_line.variant_id
          and im.reason = 'order'
        order by im.id
        limit 1;
        v_src_location := coalesce(v_src_location, v_default_location);$patch$;
  v_new constant text := $patch$      if restock and exists (
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
        limit 1;$patch$;
begin
  select pg_catalog.pg_get_functiondef(
    'private.refund_order(uuid,jsonb,numeric,text,boolean,text)'::regprocedure
  ) into v_definition;
  if pg_catalog.strpos(v_definition, v_old) = 0 then
    raise exception 'refund_order V1 definition changed; apply inventory ledger fix manually';
  end if;
  execute pg_catalog.replace(v_definition, v_old, v_new);
end;
$migration$;

revoke all on function private.price_checkout(jsonb, jsonb, uuid, text) from public, anon, authenticated;
revoke all on function private.create_order(jsonb, jsonb, uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function private.cancel_order(uuid, text) from public, anon, authenticated;
revoke all on function private.update_order_address(uuid, jsonb, uuid) from public, anon, authenticated;
revoke all on function private.create_fulfillment(uuid, jsonb, text, text, text) from public, anon, authenticated;
revoke all on function private.refund_order(uuid, jsonb, numeric, text, boolean, text) from public, anon, authenticated;
revoke all on function private.set_user_role(uuid, text) from public, anon, authenticated;
revoke all on function private.mark_order_paid(uuid, text, text) from public, anon, authenticated;

create or replace function private.storefront_order_json(p_order public.orders)
returns jsonb
language sql
immutable
strict
set search_path = ''
as $$
  -- 显式 allowlist；orders 以后新增内部列时不会自动进入 Storefront 响应。
  select jsonb_build_object(
    'id', p_order.id,
    'order_number', p_order.order_number,
    'customer_id', p_order.customer_id,
    'email', p_order.email,
    'status', p_order.status,
    'financial_status', p_order.financial_status,
    'fulfillment_status', p_order.fulfillment_status,
    'currency', p_order.currency,
    'subtotal', p_order.subtotal,
    'discount_total', p_order.discount_total,
    'shipping_total', p_order.shipping_total,
    'tax_total', p_order.tax_total,
    'total', p_order.total,
    'shipping_address', p_order.shipping_address,
    'billing_address', p_order.billing_address,
    'shipping_method_id', p_order.shipping_method_id,
    'shipping_method_name', p_order.shipping_method_name,
    'discount_code', p_order.discount_code,
    'customer_note', p_order.customer_note,
    'cancel_reason', p_order.cancel_reason,
    'paid_at', p_order.paid_at,
    'cancelled_at', p_order.cancelled_at,
    'completed_at', p_order.completed_at,
    'created_at', p_order.created_at,
    'updated_at', p_order.updated_at
  );
$$;

-- ---------- price_checkout：统一国家码 ----------
create or replace function public.price_checkout(
  items jsonb,
  address jsonb default null,
  shipping_method_id uuid default null,
  discount_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  return private.price_checkout(
    price_checkout.items,
    private.normalize_checkout_address(price_checkout.address),
    price_checkout.shipping_method_id,
    price_checkout.discount_code
  );
end;
$$;

-- ---------- create_order：统一地址 + 安全返回 ----------
create or replace function public.create_order(
  items jsonb,
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
  v_order public.orders;
begin
  v_order := private.create_order(
    create_order.items,
    private.normalize_checkout_address(create_order.address),
    create_order.address_id,
    create_order.shipping_method_id,
    create_order.discount_code,
    create_order.note
  );
  return private.storefront_order_json(v_order);
end;
$$;

-- ---------- cancel_order：安全返回；核心实现下方改为按原扣减流水回补 ----------
create or replace function public.cancel_order(order_id uuid, reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
begin
  v_order := private.cancel_order(cancel_order.order_id, cancel_order.reason);
  return private.storefront_order_json(v_order);
end;
$$;

-- ---------- update_order_address：支付后禁止直接改变订单金额 ----------
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
  select * into v_order
  from public.orders o
  where o.id = update_order_address.order_id
  for update;

  if not found then
    raise exception 'order not found';
  end if;
  if v_order.customer_id <> auth.uid() and not public.is_admin() then
    raise exception 'not allowed';
  end if;
  if v_order.financial_status <> 'pending' then
    raise exception 'paid orders require an order edit adjustment';
  end if;

  v_updated := private.update_order_address(
    update_order_address.order_id,
    private.normalize_checkout_address(update_order_address.address),
    update_order_address.address_id
  );
  return private.storefront_order_json(v_updated);
end;
$$;

-- ---------- create_fulfillment：同一请求先合并重复订单项 ----------
create or replace function public.create_fulfillment(
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
$$;

-- ---------- refund_order：最终退款账本不得超过成功收款 ----------
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
  v_refunds_before numeric(12, 2);
  v_refunds_after numeric(12, 2);
  v_captured numeric(12, 2);
begin
  if not public.is_admin() then
    raise exception 'admin only';
  end if;

  -- 与核心 refund_order 使用同一订单锁，串行化同订单退款。
  perform 1 from public.orders o
  where o.id = refund_order.order_id
  for update;

  select coalesce(sum(p.amount), 0) into v_refunds_before
  from public.payments p
  where p.order_id = refund_order.order_id
    and p.kind = 'refund' and p.status = 'succeeded';

  v_order := private.refund_order(
    refund_order.order_id,
    refund_order.items,
    refund_order.amount,
    refund_order.reason,
    refund_order.restock,
    refund_order.provider
  );

  select coalesce(sum(p.amount) filter (where p.kind = 'charge'), 0),
         coalesce(sum(p.amount) filter (where p.kind = 'refund'), 0)
  into v_captured, v_refunds_after
  from public.payments p
  where p.order_id = refund_order.order_id
    and p.status = 'succeeded';

  if v_refunds_after <= v_refunds_before then
    raise exception 'refund amount must be positive';
  end if;
  if v_refunds_after > v_captured then
    raise exception 'refund amount exceeds captured amount (refunded %, captured %)',
      v_refunds_after, v_captured;
  end if;

  return private.storefront_order_json(v_order);
end;
$$;

-- ---------- set_user_role：串行化“最后 admin”检查 ----------
create or replace function public.set_user_role(user_id uuid, role text)
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('tera-headless:set-user-role', 0)
  );
  return private.set_user_role(set_user_role.user_id, set_user_role.role);
end;
$$;

-- ---------- mark_order_paid：payments 恒正；0 元订单无需创建 payment 行 ----------
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
  if not public.is_admin() then
    raise exception 'admin only';
  end if;

  select * into v_order
  from public.orders o
  where o.id = mark_order_paid.order_id
  for update;

  if not found then
    raise exception 'order not found';
  end if;

  if v_order.total > 0 then
    return private.mark_order_paid(
      mark_order_paid.order_id,
      mark_order_paid.provider,
      mark_order_paid.provider_ref
    );
  end if;

  if v_order.financial_status <> 'pending' then
    raise exception 'order is not pending payment (current: %)', v_order.financial_status;
  end if;
  if v_order.status <> 'open' then
    raise exception 'order is not open (current: %)', v_order.status;
  end if;

  update public.orders
  set financial_status = 'paid',
      paid_at = now(),
      status = case when fulfillment_status = 'fulfilled' then 'completed' else status end,
      completed_at = case when fulfillment_status = 'fulfilled' then now() else completed_at end
  where id = v_order.id
  returning * into v_order;

  insert into public.order_events (order_id, actor_id, type, data)
  values (v_order.id, auth.uid(), 'payment_received',
          jsonb_build_object('provider', provider, 'amount', 0, 'free_order', true));

  return v_order;
end;
$$;

-- ---------- cancel_order 核心：库存流水是“下单时是否扣减”的权威事实 ----------
create or replace function private.cancel_order(order_id uuid, reason text default null)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_stock record;
  v_on_hand integer;
begin
  select * into v_order
  from public.orders o
  where o.id = cancel_order.order_id
  for update;

  if not found then
    raise exception 'order not found';
  end if;
  if v_order.customer_id <> auth.uid() and not public.is_admin() then
    raise exception 'not allowed';
  end if;
  if v_order.status <> 'open' then
    raise exception 'order is not open (current: %)', v_order.status;
  end if;
  if v_order.financial_status <> 'pending' then
    raise exception 'paid orders must go through refund flow';
  end if;
  if v_order.fulfillment_status <> 'unfulfilled' then
    raise exception 'order already has fulfillments';
  end if;

  for v_stock in
    select im.variant_id, im.location_id, (-sum(im.delta))::integer as quantity
    from public.inventory_movements im
    where im.order_id = v_order.id
      and im.reason = 'order'
      and im.delta < 0
    group by im.variant_id, im.location_id
  loop
    insert into public.inventory_levels (variant_id, location_id, on_hand)
    values (v_stock.variant_id, v_stock.location_id, 0)
    on conflict on constraint inventory_levels_pkey do nothing;

    update public.inventory_levels il
    set on_hand = il.on_hand + v_stock.quantity
    where il.variant_id = v_stock.variant_id
      and il.location_id = v_stock.location_id
    returning il.on_hand into v_on_hand;

    insert into public.inventory_movements
      (variant_id, location_id, delta, on_hand_after, reason, order_id, actor_id)
    values (v_stock.variant_id, v_stock.location_id, v_stock.quantity, v_on_hand,
            'cancel', v_order.id, auth.uid());
  end loop;

  delete from public.discount_redemptions dr where dr.order_id = v_order.id;
  update public.promotions p
  set used_count = greatest(p.used_count - 1, 0)
  where p.id in (
    select op.promotion_id from public.order_promotions op
    where op.order_id = v_order.id
  );

  update public.orders
  set status = 'cancelled', cancel_reason = reason, cancelled_at = now()
  where id = v_order.id
  returning * into v_order;

  insert into public.order_events (order_id, actor_id, type, data)
  values (v_order.id, auth.uid(), 'order_cancelled', jsonb_build_object('reason', reason));

  return v_order;
end;
$$;

-- ---------- 包装 RPC 最小权限 ----------
revoke all on function public.price_checkout(jsonb, jsonb, uuid, text) from public, anon, authenticated;
revoke all on function public.create_order(jsonb, jsonb, uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.cancel_order(uuid, text) from public, anon, authenticated;
revoke all on function public.update_order_address(uuid, jsonb, uuid) from public, anon, authenticated;
revoke all on function public.create_fulfillment(uuid, jsonb, text, text, text) from public, anon, authenticated;
revoke all on function public.refund_order(uuid, jsonb, numeric, text, boolean, text) from public, anon, authenticated;
revoke all on function public.set_user_role(uuid, text) from public, anon, authenticated;
revoke all on function public.mark_order_paid(uuid, text, text) from public, anon, authenticated;

-- 历史默认权限会把新函数显式授予 anon/authenticated，因此必须先逐角色 revoke。
revoke all on function public.adjust_inventory(uuid, integer, text, text, uuid)
  from public, anon, authenticated;
revoke all on function public.anonymize_user(uuid) from public, anon, authenticated;
revoke all on function public.moderate_review(uuid, text) from public, anon, authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.handle_user_email_change() from public, anon, authenticated;
revoke all on function public.set_updated_at() from public, anon, authenticated;
revoke all on function public.enforce_single_default_address() from public, anon, authenticated;
revoke all on function public.review_edit_requires_moderation() from public, anon, authenticated;
revoke all on function public.validate_promotion_params() from public, anon, authenticated;
revoke all on function public.normalize_promotion_code() from public, anon, authenticated;
revoke all on function public.validate_metafield_value() from public, anon, authenticated;
revoke all on function public._line_in_scope(uuid, text, uuid, uuid, uuid[])
  from public, anon, authenticated;
revoke all on function public.assert_metaobject_exists(text) from public, anon, authenticated;

grant execute on function public.assert_metaobject_exists(text) to authenticated;
grant execute on function public.price_checkout(jsonb, jsonb, uuid, text) to anon, authenticated;
grant execute on function public.create_order(jsonb, jsonb, uuid, uuid, text, text) to authenticated;
grant execute on function public.cancel_order(uuid, text) to authenticated;
grant execute on function public.update_order_address(uuid, jsonb, uuid) to authenticated;
grant execute on function public.create_fulfillment(uuid, jsonb, text, text, text) to authenticated;
grant execute on function public.refund_order(uuid, jsonb, numeric, text, boolean, text) to authenticated;
grant execute on function public.set_user_role(uuid, text) to authenticated;
grant execute on function public.mark_order_paid(uuid, text, text) to authenticated;
grant execute on function public.adjust_inventory(uuid, integer, text, text, uuid) to authenticated;
grant execute on function public.anonymize_user(uuid) to authenticated;
grant execute on function public.moderate_review(uuid, text) to authenticated;

-- ---------- 审计表 append-only（service role / security definer 仍可写） ----------
drop policy "inventory_movements: admin all" on public.inventory_movements;
create policy "inventory_movements: admin read" on public.inventory_movements
  for select using (public.is_admin());

revoke insert, update, delete, truncate on public.inventory_movements from anon, authenticated;
revoke insert, update, delete, truncate on public.order_events from anon, authenticated;

create or replace function private.protect_audit_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
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

create trigger inventory_movements_append_only
  before update or delete on public.inventory_movements
  for each row execute function private.protect_audit_row();
create trigger inventory_movements_no_truncate
  before truncate on public.inventory_movements
  for each statement execute function private.protect_audit_row();
create trigger order_events_append_only
  before update or delete on public.order_events
  for each row execute function private.protect_audit_row();
create trigger order_events_no_truncate
  before truncate on public.order_events
  for each statement execute function private.protect_audit_row();

-- ---------- Storefront 子资源继承父商品发布状态 ----------
drop policy "product_categories: public read" on public.product_categories;
create policy "product_categories: public read published" on public.product_categories
  for select using (
    public.is_admin() or (
      exists (select 1 from public.products p
              where p.id = product_id and p.status = 'active')
      and exists (select 1 from public.categories c
                  where c.id = category_id and c.is_active)
    )
  );

drop policy "product_options: public read" on public.product_options;
create policy "product_options: public read published" on public.product_options
  for select using (
    public.is_admin() or exists (
      select 1 from public.products p
      where p.id = product_id and p.status = 'active'
    )
  );

drop policy "product_option_values: public read" on public.product_option_values;
create policy "product_option_values: public read published" on public.product_option_values
  for select using (
    public.is_admin() or exists (
      select 1
      from public.product_options po
      join public.products p on p.id = po.product_id
      where po.id = option_id and p.status = 'active'
    )
  );

drop policy "product_variants: public read active" on public.product_variants;
create policy "product_variants: public read published" on public.product_variants
  for select using (
    public.is_admin() or (
      is_active and exists (
        select 1 from public.products p
        where p.id = product_id and p.status = 'active'
      )
    )
  );

drop policy "variant_option_values: public read" on public.variant_option_values;
create policy "variant_option_values: public read published" on public.variant_option_values
  for select using (
    public.is_admin() or exists (
      select 1
      from public.product_variants v
      join public.products p on p.id = v.product_id
      where v.id = variant_id and v.is_active and p.status = 'active'
    )
  );

drop policy "product_images: public read" on public.product_images;
create policy "product_images: public read published" on public.product_images
  for select using (
    public.is_admin() or exists (
      select 1 from public.products p
      where p.id = product_id and p.status = 'active'
    )
  );

drop policy "metafields: scoped read" on public.metafields;
create policy "metafields: scoped read" on public.metafields
  for select using (
    public.is_admin()
    or owner_type = 'shop'
    or (owner_type = 'customer' and owner_id = auth.uid())
    or (owner_type = 'product' and exists (
      select 1 from public.products p where p.id = owner_id and p.status = 'active'))
    or (owner_type = 'variant' and exists (
      select 1 from public.product_variants v
      join public.products p on p.id = v.product_id
      where v.id = owner_id and v.is_active and p.status = 'active'))
    or (owner_type = 'category' and exists (
      select 1 from public.categories c where c.id = owner_id and c.is_active))
  );

drop policy "product_reviews: public read approved" on public.product_reviews;
create policy "product_reviews: public read approved" on public.product_reviews
  for select using (
    public.is_admin()
    or auth.uid() = customer_id
    or (
      status = 'approved' and exists (
        select 1 from public.products p
        where p.id = product_id and p.status = 'active'
      )
    )
  );

drop policy "product_reviews: customer insert own" on public.product_reviews;
create policy "product_reviews: customer insert own" on public.product_reviews
  for insert with check (
    auth.uid() = customer_id and exists (
      select 1 from public.products p
      where p.id = product_id and p.status = 'active'
    )
  );

-- FK 常用路径索引（取消、层级和客户查询的高频路径）
create index discount_redemptions_order_idx on public.discount_redemptions (order_id);
create index categories_parent_idx on public.categories (parent_id);
create index product_reviews_customer_idx on public.product_reviews (customer_id);
create index promotion_targets_variant_idx on public.promotion_targets (variant_id);

-- private 中只有 shipping_methods 的 CHECK 需要由受信角色直接执行辅助函数。
revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function private.valid_country_codes(text[]) to authenticated, service_role;

-- PostgreSQL 对新函数的全局默认是 PUBLIC EXECUTE；必须在全局默认层撤销，
-- per-schema REVOKE 无法抵消这一内置权限。
alter default privileges for role postgres
  revoke execute on functions from public;

-- 后续 public 对象默认拒绝客户端访问；每个 API DTO/RPC 必须在 migration 中显式授权。
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;
alter default privileges for role postgres in schema private
  revoke all on tables from public, anon, authenticated;
alter default privileges for role postgres in schema private
  revoke all on sequences from public, anon, authenticated;
alter default privileges for role postgres in schema private
  revoke execute on functions from public, anon, authenticated;
