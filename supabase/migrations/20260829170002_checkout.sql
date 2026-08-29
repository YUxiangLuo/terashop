-- ============================================================
-- 3. 交易层：地址 / 运费 / 税 / 折扣 / 订单 / 履约 / 支付 / 审计
-- ============================================================

-- ---------- 客户地址簿 ----------
create table public.addresses (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  label text not null default '默认',    -- 家 / 公司
  receiver text not null,
  phone text not null,
  country text not null default 'CN',
  province text not null default '',
  city text not null default '',
  detail text not null,
  postal_code text,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index addresses_customer_idx on public.addresses (customer_id);

create trigger addresses_updated_at before update on public.addresses
  for each row execute function public.set_updated_at();

-- ---------- 运费方式 ----------
create table public.shipping_methods (
  id uuid primary key default gen_random_uuid(),
  name text not null,                    -- 标准快递 / 顺丰速运
  description text not null default '',
  countries text[] not null default '{}',  -- 空数组 = 全球可用
  price numeric(12, 2) not null default 0 check (price >= 0),
  free_above numeric(12, 2),             -- 折后小计满额包邮
  estimated_days text not null default '',  -- "3-5天"
  position integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger shipping_methods_updated_at before update on public.shipping_methods
  for each row execute function public.set_updated_at();

-- ---------- 税率 ----------
create table public.tax_rates (
  id uuid primary key default gen_random_uuid(),
  name text not null,                    -- 增值税 13%
  country text not null default '*',     -- 国家码，'*' = 兜底
  rate numeric(5, 4) not null check (rate >= 0),   -- 0.1300
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------- 折扣码 ----------
create table public.discounts (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,             -- 统一存大写
  type text not null check (type in ('percentage', 'fixed_amount', 'free_shipping')),
  value numeric(12, 2) not null default 0,   -- percentage: 10 = 9折；fixed_amount: 金额
  min_subtotal numeric(12, 2),           -- 最低消费门槛
  usage_limit integer,                   -- 总使用次数上限（null = 不限）
  used_count integer not null default 0,
  starts_at timestamptz,
  ends_at timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger discounts_updated_at before update on public.discounts
  for each row execute function public.set_updated_at();

-- 折扣核销记录（每客每码限用一次；也用于审计）
create table public.discount_redemptions (
  id uuid primary key default gen_random_uuid(),
  discount_id uuid not null references public.discounts (id),
  customer_id uuid not null references public.profiles (id),
  order_id uuid,                         -- 关联订单（下单成功后写入）
  created_at timestamptz not null default now()
);

create index discount_redemptions_lookup_idx
  on public.discount_redemptions (discount_id, customer_id);

-- ---------- 订单 ----------
-- Shopify 风格双状态：financial（支付）与 fulfillment（发货）正交
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number bigint generated always as identity (start with 1001),
  customer_id uuid not null references public.profiles (id),
  email text not null,
  status text not null default 'open'
    check (status in ('open', 'completed', 'cancelled')),
  financial_status text not null default 'pending' check (financial_status in
    ('pending', 'paid', 'partially_refunded', 'refunded', 'voided')),
  fulfillment_status text not null default 'unfulfilled'
    check (fulfillment_status in ('unfulfilled', 'partially_fulfilled', 'fulfilled')),
  currency text not null default 'CNY',
  -- 金额四件套：total = subtotal - discount_total + shipping_total + tax_total
  subtotal numeric(12, 2) not null check (subtotal >= 0),
  discount_total numeric(12, 2) not null default 0,
  shipping_total numeric(12, 2) not null default 0,
  tax_total numeric(12, 2) not null default 0,
  total numeric(12, 2) not null check (total >= 0),
  -- 快照：地址与下单时选择的服务，之后用户改地址簿/商家改运费不影响历史订单
  shipping_address jsonb not null,
  billing_address jsonb,
  shipping_method_id uuid references public.shipping_methods (id),
  shipping_method_name text,
  discount_id uuid references public.discounts (id),
  discount_code text,
  customer_note text,
  admin_note text,                       -- 列级权限：不对客户端暴露
  cancel_reason text,
  cancelled_at timestamptz,
  paid_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index orders_customer_idx on public.orders (customer_id);
create index orders_status_idx on public.orders (status, financial_status, fulfillment_status);

create trigger orders_updated_at before update on public.orders
  for each row execute function public.set_updated_at();

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  variant_id uuid references public.product_variants (id),   -- 历史订单不随商品删除
  product_id uuid references public.products (id),
  -- 快照字段
  sku text,
  name text not null,
  variant_title text not null default '',
  options jsonb not null default '{}',   -- {"颜色":"黑","尺寸":"M"}
  unit_price numeric(12, 2) not null check (unit_price >= 0),
  quantity integer not null check (quantity > 0),
  total numeric(12, 2) not null check (total >= 0)
);

create index order_items_order_idx on public.order_items (order_id);

-- ---------- 履约（支持一个订单多次发货） ----------
create table public.fulfillments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  status text not null default 'shipped'
    check (status in ('pending', 'shipped', 'delivered', 'cancelled')),
  items jsonb not null,                  -- [{"order_item_id":"uuid","quantity":1}]
  carrier text not null default '',      -- 顺丰 / YTO
  tracking_number text not null default '',
  tracking_url text,
  shipped_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index fulfillments_order_idx on public.fulfillments (order_id);

create trigger fulfillments_updated_at before update on public.fulfillments
  for each row execute function public.set_updated_at();

-- ---------- 支付（Stripe/PayPal 扩展点） ----------
-- 一次订单可有多条支付记录（多次尝试、部分退款等）；kind='refund' 记退款
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  provider text not null default 'manual',   -- stripe / paypal / manual
  kind text not null default 'charge'
    check (kind in ('authorization', 'charge', 'refund')),
  status text not null default 'pending'
    check (status in ('pending', 'succeeded', 'failed', 'cancelled')),
  amount numeric(12, 2) not null,
  currency text not null default 'CNY',
  provider_ref text,                     -- payment_intent id / paypal order id
  raw jsonb,                             -- webhook 原始载荷（列级权限：不对客户端暴露）
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index payments_order_idx on public.payments (order_id);
create index payments_provider_ref_idx on public.payments (provider, provider_ref);

create trigger payments_updated_at before update on public.payments
  for each row execute function public.set_updated_at();

-- ---------- 订单事件（审计日志） ----------
create table public.order_events (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders (id) on delete cascade,
  actor_id uuid references public.profiles (id),   -- null = 系统/webhook
  type text not null,   -- order_created / payment_received / fulfillment_created / order_cancelled / note
  data jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index order_events_order_idx on public.order_events (order_id);

-- ============================================================
-- RPC：下单（核心事务）
-- items: [{"variant_id":"uuid","quantity":2}, ...]
-- 价格/库存/折扣/运费/税全部服务端计算，客户端传价无效
-- ============================================================
create or replace function public.create_order(
  items jsonb,
  address jsonb default null,
  address_id uuid default null,
  shipping_method_id uuid default null,
  discount_code text default null,
  note text default null
)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_item jsonb;
  v_lines jsonb := '[]'::jsonb;
  v_variant record;
  v_options jsonb;
  v_variant_title text;
  v_qty integer;
  v_location_id uuid;
  v_on_hand integer;
  v_address jsonb;
  v_subtotal numeric(12, 2) := 0;
  v_discount_total numeric(12, 2) := 0;
  v_shipping_total numeric(12, 2) := 0;
  v_tax_total numeric(12, 2) := 0;
  v_tax_rate numeric(5, 4);
  v_discount_id uuid;
  v_discount_type text;
  v_discount_code text;
  v_shipping_id uuid;
  v_shipping_name text;
  v_order public.orders;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  if items is null or jsonb_typeof(items) <> 'array' or jsonb_array_length(items) = 0 then
    raise exception 'items must be a non-empty array';
  end if;

  -- ----- 地址：address_id 优先（校验归属权），否则直接用传入快照 -----
  if address_id is not null then
    select jsonb_build_object(
      'receiver', a.receiver, 'phone', a.phone, 'country', a.country,
      'province', a.province, 'city', a.city, 'detail', a.detail,
      'postal_code', a.postal_code)
    into v_address
    from public.addresses a
    where a.id = address_id and a.customer_id = v_uid;
    if not found then
      raise exception 'address not found';
    end if;
  else
    v_address := address;
  end if;
  if v_address is null
     or v_address ->> 'receiver' is null
     or v_address ->> 'detail' is null then
    raise exception 'address requires at least receiver and detail';
  end if;
  v_address := coalesce(v_address, '{}') || jsonb_build_object('country', coalesce(v_address ->> 'country', 'CN'));

  -- 默认仓
  select id into v_location_id from public.locations where is_default and is_active limit 1;

  -- ----- 第 1 遍：锁变体+库存行（FOR UPDATE 防并发超卖），计价并组装快照 -----
  for v_item in select * from jsonb_array_elements(items) loop
    v_qty := coalesce((v_item ->> 'quantity')::int, 0);
    if v_qty <= 0 then
      raise exception 'quantity must be positive';
    end if;

    select v.*, p.name as product_name, p.status as product_status
    into v_variant
    from public.product_variants v
    join public.products p on p.id = v.product_id
    where v.id = (v_item ->> 'variant_id')::uuid
    for update of v;

    if not found or not v_variant.is_active or v_variant.product_status <> 'active' then
      raise exception 'variant not available: %', v_item ->> 'variant_id';
    end if;

    if v_variant.track_inventory then
      if v_location_id is null then
        raise exception 'no default location configured';
      end if;
      -- 无库存行视为 0 库存（不存在则补建行再锁）
      insert into public.inventory_levels (variant_id, location_id, on_hand)
      values (v_variant.id, v_location_id, 0)
      on conflict (variant_id, location_id) do nothing;

      select il.on_hand into v_on_hand
      from public.inventory_levels il
      where il.variant_id = v_variant.id and il.location_id = v_location_id
      for update;

      if v_on_hand < v_qty then
        raise exception 'insufficient stock for "%" (have %, need %)',
          v_variant.product_name, v_on_hand, v_qty;
      end if;
    end if;

    -- 选项快照 {"颜色":"黑","尺寸":"M"}
    select coalesce(jsonb_object_agg(po.name, pov.value order by po.position), '{}')
    into v_options
    from public.variant_option_values vov
    join public.product_option_values pov on pov.id = vov.option_value_id
    join public.product_options po on po.id = pov.option_id
    where vov.variant_id = v_variant.id;

    select string_agg(pov.value, ' / ' order by po.position)
    into v_variant_title
    from public.variant_option_values vov
    join public.product_option_values pov on pov.id = vov.option_value_id
    join public.product_options po on po.id = pov.option_id
    where vov.variant_id = v_variant.id;

    v_subtotal := v_subtotal + v_variant.price * v_qty;
    v_lines := v_lines || jsonb_build_object(
      'variant_id', v_variant.id,
      'product_id', v_variant.product_id,
      'sku', v_variant.sku,
      'name', v_variant.product_name,
      'variant_title', coalesce(v_variant_title, ''),
      'options', v_options,
      'unit_price', v_variant.price,
      'quantity', v_qty,
      'track_inventory', v_variant.track_inventory
    );
  end loop;

  -- ----- 折扣码 -----
  if discount_code is not null then
    select d.id, d.type, d.code into v_discount_id, v_discount_type, v_discount_code
    from public.discounts d
    where d.code = upper(discount_code)
      and d.is_active
      and (d.starts_at is null or now() >= d.starts_at)
      and (d.ends_at is null or now() <= d.ends_at)
    for update of d;

    if not found then
      raise exception 'invalid or expired discount code';
    end if;
    if exists (select 1 from public.discounts d
               where d.id = v_discount_id
                 and d.usage_limit is not null and d.used_count >= d.usage_limit) then
      raise exception 'discount usage limit reached';
    end if;
    if exists (select 1 from public.discounts d
               where d.id = v_discount_id
                 and d.min_subtotal is not null and v_subtotal < d.min_subtotal) then
      raise exception 'discount minimum subtotal not met';
    end if;
    -- 每客每码限用一次（已取消订单不计）
    if exists (
      select 1 from public.discount_redemptions dr
      join public.orders o on o.id = dr.order_id
      where dr.discount_id = v_discount_id
        and dr.customer_id = v_uid
        and o.status <> 'cancelled'
    ) then
      raise exception 'discount code already used';
    end if;

    v_discount_total := case v_discount_type
      when 'percentage' then round(v_subtotal * least(
          (select d.value from public.discounts d where d.id = v_discount_id), 100) / 100, 2)
      when 'fixed_amount' then least(
          (select d.value from public.discounts d where d.id = v_discount_id), v_subtotal)
      else 0
    end;
  end if;

  -- ----- 运费 -----
  if shipping_method_id is not null then
    select m.id, m.name, m.price into v_shipping_id, v_shipping_name, v_shipping_total
    from public.shipping_methods m
    where m.id = shipping_method_id and m.is_active;
    if not found then
      raise exception 'shipping method not available';
    end if;
    if exists (select 1 from public.shipping_methods m
               where m.id = v_shipping_id
                 and array_length(m.countries, 1) is not null
                 and not (v_address ->> 'country' = any (m.countries))) then
      raise exception 'shipping method not available for this country';
    end if;
    if exists (select 1 from public.shipping_methods m
               where m.id = v_shipping_id and m.free_above is not null
                 and (v_subtotal - v_discount_total) >= m.free_above) then
      v_shipping_total := 0;
    end if;
    if v_discount_type = 'free_shipping' then
      v_shipping_total := 0;
    end if;
  end if;

  -- ----- 税（按收货国家匹配，'*' 兜底） -----
  select rate into v_tax_rate
  from public.tax_rates
  where is_active and (country = v_address ->> 'country' or country = '*')
  order by (country = '*') asc
  limit 1;
  v_tax_total := round((v_subtotal - v_discount_total) * coalesce(v_tax_rate, 0), 2);

  -- ----- 落单 -----
  insert into public.orders (
    customer_id, email,
    subtotal, discount_total, shipping_total, tax_total, total,
    shipping_address, shipping_method_id, shipping_method_name,
    discount_id, discount_code, customer_note
  ) values (
    v_uid,
    (select email from public.profiles where id = v_uid),
    v_subtotal, v_discount_total, v_shipping_total, v_tax_total,
    v_subtotal - v_discount_total + v_shipping_total + v_tax_total,
    v_address, v_shipping_id, v_shipping_name,
    v_discount_id, v_discount_code, note
  )
  returning * into v_order;

  -- ----- 第 2 遍：写明细 + 扣库存（行锁仍持有） -----
  for v_item in select * from jsonb_array_elements(v_lines) loop
    insert into public.order_items (
      order_id, variant_id, product_id, sku, name, variant_title,
      options, unit_price, quantity, total
    ) values (
      v_order.id,
      (v_item ->> 'variant_id')::uuid,
      (v_item ->> 'product_id')::uuid,
      v_item ->> 'sku',
      v_item ->> 'name',
      v_item ->> 'variant_title',
      v_item -> 'options',
      (v_item ->> 'unit_price')::numeric,
      (v_item ->> 'quantity')::int,
      round((v_item ->> 'unit_price')::numeric * (v_item ->> 'quantity')::int, 2)
    );

    if (v_item ->> 'track_inventory')::boolean then
      update public.inventory_levels
      set on_hand = on_hand - (v_item ->> 'quantity')::int
      where variant_id = (v_item ->> 'variant_id')::uuid
        and location_id = v_location_id;
    end if;
  end loop;

  -- 折扣核销
  if v_discount_id is not null then
    insert into public.discount_redemptions (discount_id, customer_id, order_id)
    values (v_discount_id, v_uid, v_order.id);
    update public.discounts set used_count = used_count + 1 where id = v_discount_id;
  end if;

  insert into public.order_events (order_id, actor_id, type, data)
  values (v_order.id, v_uid, 'order_created',
          jsonb_build_object('total', v_order.total, 'discount_code', v_discount_code));

  return v_order;
end;
$$;

-- ============================================================
-- RPC：取消订单（仅未支付未发货；回补库存 + 释放折扣）
-- ============================================================
create or replace function public.cancel_order(order_id uuid, reason text default null)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_location_id uuid;
begin
  select * into v_order from public.orders where id = cancel_order.order_id for update;

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

  select id into v_location_id from public.locations where is_default and is_active limit 1;

  -- 回补库存（仅追踪库存的变体）
  update public.inventory_levels il
  set on_hand = il.on_hand + oi.quantity
  from public.order_items oi
  join public.product_variants v on v.id = oi.variant_id
  where oi.order_id = v_order.id
    and v.track_inventory
    and il.variant_id = oi.variant_id
    and il.location_id = v_location_id;

  -- 释放折扣
  if v_order.discount_id is not null then
    delete from public.discount_redemptions where order_id = v_order.id;
    update public.discounts
    set used_count = greatest(used_count - 1, 0)
    where id = v_order.discount_id;
  end if;

  update public.orders
  set status = 'cancelled', cancel_reason = reason, cancelled_at = now()
  where id = v_order.id
  returning * into v_order;

  insert into public.order_events (order_id, actor_id, type, data)
  values (v_order.id, auth.uid(), 'order_cancelled', jsonb_build_object('reason', reason));

  return v_order;
end;
$$;

-- ============================================================
-- RPC：标记已支付（admin / 线下收款 / 调试；接 Stripe 后由 webhook 直写）
-- ============================================================
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

  select * into v_order from public.orders where id = mark_order_paid.order_id for update;
  if not found then
    raise exception 'order not found';
  end if;
  if v_order.financial_status <> 'pending' then
    raise exception 'order is not pending payment (current: %)', v_order.financial_status;
  end if;
  if v_order.status <> 'open' then
    raise exception 'order is not open (current: %)', v_order.status;
  end if;

  insert into public.payments (order_id, provider, kind, status, amount, currency, provider_ref)
  values (v_order.id, provider, 'charge', 'succeeded', v_order.total, v_order.currency, provider_ref);

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

-- ============================================================
-- RPC：创建履约/发货（admin）
-- items: [{"order_item_id":"uuid","quantity":1}]
-- 自动推进 fulfillment_status；全部发完且已支付 → 订单 completed
-- ============================================================
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
  v_order public.orders;
  v_fulfillment public.fulfillments;
  v_all_fulfilled boolean;
  v_any_fulfilled boolean;
begin
  if not public.is_admin() then
    raise exception 'admin only';
  end if;
  if items is null or jsonb_typeof(items) <> 'array' or jsonb_array_length(items) = 0 then
    raise exception 'items must be a non-empty array';
  end if;

  select * into v_order from public.orders where id = create_fulfillment.order_id for update;
  if not found then
    raise exception 'order not found';
  end if;
  if v_order.status <> 'open' then
    raise exception 'order is not open (current: %)', v_order.status;
  end if;

  insert into public.fulfillments (order_id, items, carrier, tracking_number, tracking_url, status, shipped_at)
  values (v_order.id, items, carrier, tracking_number, tracking_url, 'shipped', now())
  returning * into v_fulfillment;

  -- 汇总所有有效履约，重算订单履约状态
  select
    bool_and(oi.quantity <= coalesce(f.fulfilled_qty, 0)),
    bool_or(coalesce(f.fulfilled_qty, 0) > 0)
  into v_all_fulfilled, v_any_fulfilled
  from public.order_items oi
  left join lateral (
    select sum((it ->> 'quantity')::int) as fulfilled_qty
    from public.fulfillments fu, jsonb_array_elements(fu.items) it
    where fu.order_id = v_order.id
      and fu.status <> 'cancelled'
      and (it ->> 'order_item_id')::uuid = oi.id
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
          jsonb_build_object('fulfillment_id', v_fulfillment.id, 'tracking_number', tracking_number));

  return v_fulfillment;
end;
$$;

-- ============================================================
-- RLS + 列级权限
-- ============================================================
alter table public.addresses enable row level security;
alter table public.shipping_methods enable row level security;
alter table public.tax_rates enable row level security;
alter table public.discounts enable row level security;
alter table public.discount_redemptions enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.fulfillments enable row level security;
alter table public.payments enable row level security;
alter table public.order_events enable row level security;

-- 地址簿：本人全权管理
create policy "addresses: own all" on public.addresses
  for all using (auth.uid() = customer_id or public.is_admin());

-- 运费/税率：公开可读（结账页需要），admin 可写
create policy "shipping_methods: public read" on public.shipping_methods
  for select using (is_active or public.is_admin());
create policy "shipping_methods: admin write" on public.shipping_methods
  for all using (public.is_admin());
create policy "tax_rates: public read" on public.tax_rates
  for select using (is_active or public.is_admin());
create policy "tax_rates: admin write" on public.tax_rates
  for all using (public.is_admin());

-- 折扣码：不对客户端公开（防止爬取全部码），验证在 create_order 内完成
create policy "discounts: admin all" on public.discounts
  for all using (public.is_admin());
create policy "discount_redemptions: read own or admin" on public.discount_redemptions
  for select using (auth.uid() = customer_id or public.is_admin());

-- 订单：本人可读；admin 可改（备注、地址修正等）；
-- 无 insert 策略 → 客户端不能直接建单，必须走 create_order RPC
create policy "orders: read own or admin" on public.orders
  for select using (auth.uid() = customer_id or public.is_admin());
create policy "orders: admin update" on public.orders
  for update using (public.is_admin());

create policy "order_items: read own or admin" on public.order_items
  for select using (
    exists (select 1 from public.orders o
            where o.id = order_id and (o.customer_id = auth.uid() or public.is_admin()))
  );

-- 履约：客户可读自己订单的物流信息；admin 可写（也可走 create_fulfillment RPC）
create policy "fulfillments: read own or admin" on public.fulfillments
  for select using (
    exists (select 1 from public.orders o
            where o.id = order_id and (o.customer_id = auth.uid() or public.is_admin()))
  );
create policy "fulfillments: admin write" on public.fulfillments
  for all using (public.is_admin());

-- 支付：客户可读自己订单的支付记录；写入仅 admin / service role（webhook）
create policy "payments: read own or admin" on public.payments
  for select using (
    exists (select 1 from public.orders o
            where o.id = order_id and (o.customer_id = auth.uid() or public.is_admin()))
  );
create policy "payments: admin write" on public.payments
  for all using (public.is_admin());

-- 订单事件：同订单可见性；写入由 RPC（security definer）完成
create policy "order_events: read own or admin" on public.order_events
  for select using (
    exists (select 1 from public.orders o
            where o.id = order_id and (o.customer_id = auth.uid() or public.is_admin()))
  );

-- order 域 metafield 的补充读策略（与 foundation 中的策略 OR 叠加）
create policy "metafields: order owner read" on public.metafields
  for select using (
    owner_type = 'order' and exists (
      select 1 from public.orders o
      where o.id = owner_id and o.customer_id = auth.uid()
    )
  );

-- 列级权限：内部字段不暴露给客户端
revoke select on public.orders from anon, authenticated;
grant select (id, order_number, customer_id, email, status, financial_status,
              fulfillment_status, currency, subtotal, discount_total, shipping_total,
              tax_total, total, shipping_address, billing_address,
              shipping_method_id, shipping_method_name, discount_code,
              customer_note, cancel_reason, cancelled_at, paid_at, completed_at,
              created_at, updated_at)
  on public.orders to anon, authenticated;

revoke select on public.payments from anon, authenticated;
grant select (id, order_id, provider, kind, status, amount, currency,
              provider_ref, created_at, updated_at)
  on public.payments to anon, authenticated;
