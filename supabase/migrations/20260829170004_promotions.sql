-- ============================================================
-- 5. 促销引擎：promotions / promotion_targets / order_promotions
--    + price_checkout（预览与下单共用的计价函数）
--    合并并替换旧 discounts 体系
-- ============================================================

-- ---------- 促销主表 ----------
-- code 为 null = 自动生效；有值 = 输码生效（半自动）
create table public.promotions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text unique,
  type text not null check (type in (
    'order_percentage',   -- 整单百分比：{"percent":10,"threshold":50}
    'order_fixed',        -- 满减：{"threshold":300,"amount":40}（threshold 按原始小计）
    'item_percentage',    -- 范围内打折：{"percent":20} 或满N件X折 {"percent":30,"min_quantity":3}
    'buy_x_get_y',        -- 买X送Y：{"buy":1,"get":1,"get_percent":100}（最便宜件优先免）
    'free_shipping'       -- 免运费：{}
  )),
  params jsonb not null default '{}',
  priority integer not null default 100,     -- 数字小先算（决定叠加顺序与互斥优先级）
  stackable boolean not null default false,  -- false = 独占：生效后阻止后续促销
  usage_limit integer,
  used_count integer not null default 0,
  per_customer_limit integer not null default 1,   -- 输码型每客限用次数
  starts_at timestamptz,
  ends_at timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger promotions_updated_at before update on public.promotions
  for each row execute function public.set_updated_at();

-- params 按类型校验
create or replace function public.validate_promotion_params()
returns trigger
language plpgsql
as $$
begin
  case new.type
    when 'order_percentage', 'item_percentage' then
      if coalesce((new.params ->> 'percent')::numeric, 0) <= 0
         or (new.params ->> 'percent')::numeric > 100 then
        raise exception 'params.percent must be in (0, 100]';
      end if;
      if (new.params ->> 'min_quantity') is not null
         and (new.params ->> 'min_quantity')::int <= 0 then
        raise exception 'params.min_quantity must be positive';
      end if;
    when 'order_fixed' then
      if coalesce((new.params ->> 'amount')::numeric, 0) <= 0 then
        raise exception 'params.amount must be positive';
      end if;
    when 'buy_x_get_y' then
      if coalesce((new.params ->> 'buy')::int, 0) <= 0
         or coalesce((new.params ->> 'get')::int, 0) <= 0 then
        raise exception 'params.buy and params.get must be positive';
      end if;
    when 'free_shipping' then
      null;
  end case;
  return new;
end;
$$;

create trigger promotions_validate before insert or update on public.promotions
  for each row execute function public.validate_promotion_params();

-- ---------- 作用范围 ----------
-- role='apply'：计入条件且被折扣；role='get'：仅 BOGO 赠品范围（不设则与 apply 相同）
-- 某 role 无任何行 = 全场
create table public.promotion_targets (
  id uuid primary key default gen_random_uuid(),
  promotion_id uuid not null references public.promotions (id) on delete cascade,
  role text not null default 'apply' check (role in ('apply', 'get')),
  product_id uuid references public.products (id) on delete cascade,
  category_id uuid references public.categories (id) on delete cascade,
  variant_id uuid references public.product_variants (id) on delete cascade,
  check (num_nonnulls(product_id, category_id, variant_id) = 1)
);

-- 复合唯一（nulls not distinct：同一促销不允许重复挂同一目标）
create unique index promotion_targets_unique on public.promotion_targets
  (promotion_id, role, product_id, category_id, variant_id) nulls not distinct;

create index promotion_targets_product_idx on public.promotion_targets (product_id);
create index promotion_targets_category_idx on public.promotion_targets (category_id);

-- ---------- 迁移旧 discounts 数据（保留 id，外键引用不断） ----------
insert into public.promotions (id, name, code, type, params, usage_limit, used_count,
                               starts_at, ends_at, is_active, created_at)
select
  d.id,
  d.code,
  d.code,
  case d.type
    when 'percentage'   then 'order_percentage'
    when 'fixed_amount' then 'order_fixed'
    when 'free_shipping' then 'free_shipping'
  end,
  case d.type
    when 'percentage'   then jsonb_build_object('percent', d.value, 'threshold', coalesce(d.min_subtotal, 0))
    when 'fixed_amount' then jsonb_build_object('amount', d.value, 'threshold', coalesce(d.min_subtotal, 0))
    else '{}'::jsonb
  end,
  d.usage_limit, d.used_count, d.starts_at, d.ends_at, d.is_active, d.created_at
from public.discounts d;

-- discount_redemptions 改指 promotions
alter table public.discount_redemptions
  drop constraint if exists discount_redemptions_discount_id_fkey;
alter table public.discount_redemptions rename column discount_id to promotion_id;
alter table public.discount_redemptions
  add constraint discount_redemptions_promotion_id_fkey
  foreign key (promotion_id) references public.promotions (id);

-- orders：一单可有多个促销，单一 discount_id 列废弃（快照见 order_promotions / discount_code）
alter table public.orders drop constraint if exists orders_discount_id_fkey;
alter table public.orders drop column if exists discount_id;

drop table public.discounts;

-- ---------- 订单促销落账（快照，退款/审计依据） ----------
create table public.order_promotions (
  order_id uuid not null references public.orders (id) on delete cascade,
  promotion_id uuid not null references public.promotions (id),
  name text not null,                  -- 快照
  code text,
  amount numeric(12, 2) not null,      -- 该促销实际优惠金额
  created_at timestamptz not null default now(),
  primary key (order_id, promotion_id)
);

-- 行级折扣分摊（部分退款时能精确计算每行可退金额）
alter table public.order_items
  add column discount_total numeric(12, 2) not null default 0,
  add column line_total numeric(12, 2)
    generated always as (round(unit_price * quantity - discount_total, 2)) stored;

-- ---------- 范围匹配辅助函数 ----------
create or replace function public._line_in_scope(
  p_promotion_id uuid,
  p_role text,
  p_variant_id uuid,
  p_product_id uuid,
  p_category_ids uuid[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when not exists (
      select 1 from public.promotion_targets t
      where t.promotion_id = p_promotion_id and t.role = p_role
    ) then true   -- 无范围限制 = 全场
    else exists (
      select 1 from public.promotion_targets t
      where t.promotion_id = p_promotion_id and t.role = p_role
        and (t.variant_id = p_variant_id
             or t.product_id = p_product_id
             or t.category_id = any (p_category_ids))
    )
  end;
$$;

-- ============================================================
-- 计价引擎：price_checkout
-- 预览（只读）与 create_order（锁库存后）共用同一函数，保证价格一致
-- ============================================================
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
declare
  v_item jsonb;
  v_variant record;
  v_options jsonb;
  v_variant_title text;
  v_cat_ids uuid[];
  v_country text;
  v_subtotal numeric(12, 2) := 0;
  v_discount_total numeric(12, 2) := 0;
  v_shipping_total numeric(12, 2) := 0;
  v_tax_total numeric(12, 2) := 0;
  v_tax_rate numeric(5, 4);
  v_ship_id uuid;
  v_ship_name text;
  v_promo record;
  v_code_found boolean := false;
  v_applied integer := 0;
  v_has_exclusive boolean := false;
  v_scope_qty integer;
  v_min_qty integer;
  v_pct numeric;
  v_amount numeric(12, 2);
  v_base numeric(12, 2);
  v_alloc numeric(12, 2);
  v_alloc_sum numeric(12, 2);
  v_last_idx integer;
  v_buy integer;
  v_get integer;
  v_get_pct numeric;
  v_free integer;
  v_get_role text;
  v_fs_id uuid;
  v_fs_name text;
  v_fs_code text;
  v_line record;
  v_take integer;
  v_disc numeric(12, 2);
  v_threshold numeric(12, 2);
  v_lines_json jsonb;
  v_promos_json jsonb;
begin
  if items is null or jsonb_typeof(items) <> 'array' or jsonb_array_length(items) = 0 then
    raise exception 'items must be a non-empty array';
  end if;
  v_country := coalesce(address ->> 'country', 'CN');

  drop table if exists _price_lines;
  create temporary table _price_lines (
    idx serial primary key,
    variant_id uuid,
    product_id uuid,
    sku text,
    name text,
    variant_title text,
    options jsonb,
    quantity integer,
    unit_price numeric(12, 2),
    category_ids uuid[],
    track_inventory boolean,
    discount_total numeric(12, 2) not null default 0
  ) on commit drop;

  drop table if exists _price_promos;
  create temporary table _price_promos (
    promotion_id uuid, name text, code text, amount numeric(12, 2), stackable boolean
  ) on commit drop;

  -- ===== 1. 展开购物车行（合并重复变体） =====
  for v_item in
    select jsonb_build_object(
      'variant_id', e.value ->> 'variant_id',
      'quantity', sum((e.value ->> 'quantity')::int)) as line
    from jsonb_array_elements(items) e
    group by e.value ->> 'variant_id'
  loop
    if coalesce((v_item ->> 'quantity')::int, 0) <= 0 then
      raise exception 'quantity must be positive';
    end if;

    select v.*, p.name as product_name, p.status as product_status
    into v_variant
    from public.product_variants v
    join public.products p on p.id = v.product_id
    where v.id = (v_item ->> 'variant_id')::uuid;

    if not found or not v_variant.is_active or v_variant.product_status <> 'active' then
      raise exception 'variant not available: %', v_item ->> 'variant_id';
    end if;

    -- 类目闭包（含所有祖先，用于"某分类促销"命中子分类商品）
    with recursive up as (
      select c.id, c.parent_id from public.categories c
      where c.id in (select pc.category_id from public.product_categories pc
                     where pc.product_id = v_variant.product_id)
      union
      select c.id, c.parent_id from public.categories c join up on c.id = up.parent_id
    )
    select coalesce(array_agg(distinct id), '{}') into v_cat_ids from up;

    select coalesce(jsonb_object_agg(po.name, pov.value order by po.position), '{}'),
           coalesce(string_agg(pov.value, ' / ' order by po.position), '')
    into v_options, v_variant_title
    from public.variant_option_values vov
    join public.product_option_values pov on pov.id = vov.option_value_id
    join public.product_options po on po.id = pov.option_id
    where vov.variant_id = v_variant.id;

    insert into _price_lines (variant_id, product_id, sku, name, variant_title, options,
                              quantity, unit_price, category_ids, track_inventory)
    values (v_variant.id, v_variant.product_id, v_variant.sku, v_variant.product_name,
            v_variant_title, v_options,
            (v_item ->> 'quantity')::int, v_variant.price, v_cat_ids, v_variant.track_inventory);
  end loop;

  select coalesce(sum(unit_price * quantity), 0) into v_subtotal from _price_lines;

  -- ===== 2. 促销求值（按 priority 顺序） =====
  for v_promo in
    select p.* from public.promotions p
    where p.is_active
      and (p.starts_at is null or now() >= p.starts_at)
      and (p.ends_at is null or now() <= p.ends_at)
      and (p.usage_limit is null or p.used_count < p.usage_limit)
      and (p.code is null or p.code = upper(coalesce(discount_code, '')))
    order by p.priority, p.created_at
  loop
    if v_promo.code is not null then
      v_code_found := true;
    end if;

    -- 叠加规则：已有独占促销生效，或本促销为独占且已有促销生效 → 跳过
    if v_applied > 0 and (v_has_exclusive or not v_promo.stackable) then
      continue;
    end if;

    -- 输码型校验（被互斥跳过的码不报错）
    if v_promo.code is not null then
      if auth.uid() is not null and (
        select count(*) from public.discount_redemptions dr
        join public.orders o on o.id = dr.order_id
        where dr.promotion_id = v_promo.id
          and dr.customer_id = auth.uid()
          and o.status <> 'cancelled'
      ) >= v_promo.per_customer_limit then
        raise exception 'discount code already used';
      end if;
      if v_promo.type in ('order_percentage', 'order_fixed') then
        if v_subtotal < coalesce((v_promo.params ->> 'threshold')::numeric, 0) then
          raise exception 'discount minimum subtotal not met';
        end if;
      end if;
    end if;

    v_amount := 0;

    case v_promo.type
    when 'item_percentage' then
      v_pct := (v_promo.params ->> 'percent')::numeric;
      v_min_qty := coalesce((v_promo.params ->> 'min_quantity')::int, 0);
      select coalesce(sum(l.quantity), 0) into v_scope_qty
      from _price_lines l
      where public._line_in_scope(v_promo.id, 'apply', l.variant_id, l.product_id, l.category_ids);

      if v_scope_qty > 0 and v_scope_qty >= v_min_qty then
        for v_line in
          select * from _price_lines l
          where public._line_in_scope(v_promo.id, 'apply', l.variant_id, l.product_id, l.category_ids)
        loop
          v_disc := round(v_line.unit_price * v_line.quantity * v_pct / 100, 2);
          update _price_lines set discount_total = discount_total + v_disc where idx = v_line.idx;
          v_amount := v_amount + v_disc;
        end loop;
      end if;

    when 'buy_x_get_y' then
      v_buy := (v_promo.params ->> 'buy')::int;
      v_get := (v_promo.params ->> 'get')::int;
      v_get_pct := coalesce((v_promo.params ->> 'get_percent')::numeric, 100);
      select coalesce(sum(l.quantity), 0) into v_scope_qty
      from _price_lines l
      where public._line_in_scope(v_promo.id, 'apply', l.variant_id, l.product_id, l.category_ids);
      v_get_role := case
        when exists (select 1 from public.promotion_targets t
                     where t.promotion_id = v_promo.id and t.role = 'get') then 'get'
        else 'apply' end;
      if v_get_role = 'get' then
        -- 跨范围（买A送B）：每买 buy 件 A 送 get 件 B，赠品数不超过购物车中 B 的数量
        v_free := least(
          (floor(v_scope_qty / v_buy))::int * v_get,
          (select coalesce(sum(l.quantity), 0) from _price_lines l
           where public._line_in_scope(v_promo.id, 'get', l.variant_id, l.product_id, l.category_ids))
        );
      else
        -- 同池（买1送1）：每 buy+get 件免 get 件
        v_free := (floor(v_scope_qty / (v_buy + v_get)))::int * v_get;
      end if;

      -- 最便宜的优先免（防"买便宜送贵"套利）
      for v_line in
        select * from _price_lines l
        where public._line_in_scope(v_promo.id, v_get_role, l.variant_id, l.product_id, l.category_ids)
        order by l.unit_price asc, l.idx
      loop
        exit when v_free <= 0;
        v_take := least(v_free, v_line.quantity);
        v_disc := round(v_take * v_line.unit_price * v_get_pct / 100, 2);
        update _price_lines set discount_total = discount_total + v_disc where idx = v_line.idx;
        v_amount := v_amount + v_disc;
        v_free := v_free - v_take;
      end loop;

    when 'order_percentage' then
      v_threshold := coalesce((v_promo.params ->> 'threshold')::numeric, 0);
      if v_subtotal >= v_threshold then
        v_pct := least((v_promo.params ->> 'percent')::numeric, 100);
        v_base := v_subtotal - (select coalesce(sum(discount_total), 0) from _price_lines);
        v_amount := round(v_base * v_pct / 100, 2);
      end if;

    when 'order_fixed' then
      v_threshold := coalesce((v_promo.params ->> 'threshold')::numeric, 0);
      if v_subtotal >= v_threshold then
        v_base := v_subtotal - (select coalesce(sum(discount_total), 0) from _price_lines);
        v_amount := least((v_promo.params ->> 'amount')::numeric, v_base);
      end if;

    when 'free_shipping' then
      if v_fs_id is null then
        v_fs_id := v_promo.id;
        v_fs_name := v_promo.name;
        v_fs_code := v_promo.code;
      end if;
    end case;

    if v_amount > 0 then
      -- 整单级折扣按行折后金额比例分摊（尾差归入最后一行）
      if v_promo.type in ('order_percentage', 'order_fixed') then
        v_base := v_subtotal - (select coalesce(sum(discount_total), 0) from _price_lines);
        v_alloc_sum := 0;
        select max(idx) into v_last_idx from _price_lines;
        for v_line in select * from _price_lines order by idx loop
          if v_line.idx = v_last_idx then
            v_alloc := v_amount - v_alloc_sum;
          else
            v_alloc := round(
              v_amount * (v_line.unit_price * v_line.quantity - v_line.discount_total) / v_base, 2);
            v_alloc_sum := v_alloc_sum + v_alloc;
          end if;
          update _price_lines set discount_total = discount_total + v_alloc where idx = v_line.idx;
        end loop;
      end if;

      insert into _price_promos values (v_promo.id, v_promo.name, v_promo.code, v_amount, v_promo.stackable);
      v_applied := v_applied + 1;
      if not v_promo.stackable then
        v_has_exclusive := true;
      end if;
    end if;
  end loop;

  if discount_code is not null and not v_code_found then
    raise exception 'invalid or expired discount code';
  end if;

  select coalesce(sum(discount_total), 0) into v_discount_total from _price_lines;

  -- ===== 3. 运费（基于折后金额判断满额包邮） =====
  if shipping_method_id is not null then
    select m.id, m.name, m.price into v_ship_id, v_ship_name, v_shipping_total
    from public.shipping_methods m
    where m.id = shipping_method_id and m.is_active;
    if not found then
      raise exception 'shipping method not available';
    end if;
    if exists (select 1 from public.shipping_methods m
               where m.id = v_ship_id
                 and array_length(m.countries, 1) is not null
                 and not (v_country = any (m.countries))) then
      raise exception 'shipping method not available for this country';
    end if;
    if exists (select 1 from public.shipping_methods m
               where m.id = v_ship_id and m.free_above is not null
                 and (v_subtotal - v_discount_total) >= m.free_above) then
      v_shipping_total := 0;
    end if;
  end if;

  -- 免运费促销
  if v_fs_id is not null and v_shipping_total > 0 then
    insert into _price_promos values (v_fs_id, v_fs_name, v_fs_code, v_shipping_total, true);
    v_shipping_total := 0;
  end if;

  -- ===== 4. 税（基于折后金额） =====
  select rate into v_tax_rate
  from public.tax_rates
  where is_active and (country = v_country or country = '*')
  order by (country = '*') asc
  limit 1;
  v_tax_total := round((v_subtotal - v_discount_total) * coalesce(v_tax_rate, 0), 2);

  -- ===== 5. 输出 =====
  select jsonb_agg(jsonb_build_object(
           'variant_id', variant_id, 'product_id', product_id, 'sku', sku, 'name', name,
           'variant_title', variant_title, 'options', options, 'quantity', quantity,
           'unit_price', unit_price, 'discount_total', discount_total,
           'track_inventory', track_inventory,
           'line_total', unit_price * quantity - discount_total
         ) order by idx)
  into v_lines_json
  from _price_lines;

  select coalesce(jsonb_agg(jsonb_build_object(
           'promotion_id', promotion_id, 'name', name, 'code', code, 'amount', amount
         )), '[]'::jsonb)
  into v_promos_json
  from _price_promos;

  return jsonb_build_object(
    'lines', v_lines_json,
    'subtotal', v_subtotal,
    'discount_total', v_discount_total,
    'promotions', v_promos_json,
    'shipping_method_id', v_ship_id,
    'shipping_method_name', v_ship_name,
    'shipping_total', v_shipping_total,
    'tax_total', v_tax_total,
    'total', v_subtotal - v_discount_total + v_shipping_total + v_tax_total,
    'currency', 'CNY'
  );
end;
$$;

-- ============================================================
-- create_order v3：锁库存 → 调 price_checkout 计价 → 落账
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
  v_variant record;
  v_qty integer;
  v_location_id uuid;
  v_on_hand integer;
  v_address jsonb;
  v_price jsonb;
  v_line jsonb;
  v_promo jsonb;
  v_code_used text;
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

  select id into v_location_id from public.locations where is_default and is_active limit 1;

  -- ----- 第 1 阶段：锁变体 + 库存行，校验可用性与库存（不计算价格） -----
  for v_item in
    select jsonb_build_object(
      'variant_id', e.value ->> 'variant_id',
      'quantity', sum((e.value ->> 'quantity')::int)) as line
    from jsonb_array_elements(items) e
    group by e.value ->> 'variant_id'
  loop
    v_qty := coalesce((v_item ->> 'quantity')::int, 0);
    if v_qty <= 0 then
      raise exception 'quantity must be positive';
    end if;

    select v.*, p.status as product_status
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
      insert into public.inventory_levels (variant_id, location_id, on_hand)
      values (v_variant.id, v_location_id, 0)
      on conflict on constraint inventory_levels_pkey do nothing;

      select il.on_hand into v_on_hand
      from public.inventory_levels il
      where il.variant_id = v_variant.id and il.location_id = v_location_id
      for update;

      if v_on_hand < v_qty then
        raise exception 'insufficient stock for "%" (have %, need %)',
          (select name from public.products where id = v_variant.product_id), v_on_hand, v_qty;
      end if;
    end if;
  end loop;

  -- ----- 第 2 阶段：计价（与预览完全同一引擎） -----
  v_price := public.price_checkout(items, v_address, shipping_method_id, discount_code);

  v_code_used := (select p ->> 'code'
                  from jsonb_array_elements(v_price -> 'promotions') p
                  where p ->> 'code' is not null
                  limit 1);

  -- ----- 第 3 阶段：落账 -----
  insert into public.orders (
    customer_id, email,
    subtotal, discount_total, shipping_total, tax_total, total,
    shipping_address, shipping_method_id, shipping_method_name,
    discount_code, customer_note
  ) values (
    v_uid,
    (select email from public.profiles where id = v_uid),
    (v_price ->> 'subtotal')::numeric,
    (v_price ->> 'discount_total')::numeric,
    (v_price ->> 'shipping_total')::numeric,
    (v_price ->> 'tax_total')::numeric,
    (v_price ->> 'total')::numeric,
    v_address,
    (v_price ->> 'shipping_method_id')::uuid,
    v_price ->> 'shipping_method_name',
    v_code_used, note
  )
  returning * into v_order;

  for v_line in select * from jsonb_array_elements(v_price -> 'lines') loop
    insert into public.order_items (
      order_id, variant_id, product_id, sku, name, variant_title,
      options, unit_price, quantity, discount_total, total
    ) values (
      v_order.id,
      (v_line ->> 'variant_id')::uuid,
      (v_line ->> 'product_id')::uuid,
      v_line ->> 'sku',
      v_line ->> 'name',
      v_line ->> 'variant_title',
      v_line -> 'options',
      (v_line ->> 'unit_price')::numeric,
      (v_line ->> 'quantity')::int,
      (v_line ->> 'discount_total')::numeric,
      round((v_line ->> 'unit_price')::numeric * (v_line ->> 'quantity')::int, 2)
    );

    if (v_line ->> 'track_inventory')::boolean then
      update public.inventory_levels
      set on_hand = on_hand - (v_line ->> 'quantity')::int
      where variant_id = (v_line ->> 'variant_id')::uuid
        and location_id = v_location_id
      returning on_hand into v_on_hand;

      insert into public.inventory_movements
        (variant_id, location_id, delta, on_hand_after, reason, order_id, actor_id)
      values (
        (v_line ->> 'variant_id')::uuid, v_location_id,
        -(v_line ->> 'quantity')::int, v_on_hand, 'order', v_order.id, v_uid
      );
    end if;
  end loop;

  -- 促销落账 + 用量 + 输码核销
  for v_promo in select * from jsonb_array_elements(v_price -> 'promotions') loop
    insert into public.order_promotions (order_id, promotion_id, name, code, amount)
    values (v_order.id, (v_promo ->> 'promotion_id')::uuid,
            v_promo ->> 'name', v_promo ->> 'code', (v_promo ->> 'amount')::numeric);

    update public.promotions set used_count = used_count + 1
    where id = (v_promo ->> 'promotion_id')::uuid;

    if v_promo ->> 'code' is not null then
      insert into public.discount_redemptions (promotion_id, customer_id, order_id)
      values ((v_promo ->> 'promotion_id')::uuid, v_uid, v_order.id);
    end if;
  end loop;

  insert into public.order_events (order_id, actor_id, type, data)
  values (v_order.id, v_uid, 'order_created',
          jsonb_build_object('total', v_order.total, 'promotions', v_price -> 'promotions'));

  return v_order;
end;
$$;

-- ============================================================
-- cancel_order v3：释放所有已用促销（含自动促销用量回落）
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
  v_line record;
  v_on_hand integer;
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

  -- 回补库存（仅追踪库存的变体）并记流水
  for v_line in
    select oi.variant_id, oi.quantity, v.track_inventory
    from public.order_items oi
    join public.product_variants v on v.id = oi.variant_id
    where oi.order_id = v_order.id
  loop
    if v_line.track_inventory and v_location_id is not null then
      update public.inventory_levels
      set on_hand = on_hand + v_line.quantity
      where variant_id = v_line.variant_id and location_id = v_location_id
      returning on_hand into v_on_hand;

      insert into public.inventory_movements
        (variant_id, location_id, delta, on_hand_after, reason, order_id, actor_id)
      values (v_line.variant_id, v_location_id, v_line.quantity, v_on_hand,
              'cancel', v_order.id, auth.uid());
    end if;
  end loop;

  -- 释放促销：核销记录删除 + 所有已用促销用量回落
  delete from public.discount_redemptions dr where dr.order_id = v_order.id;
  update public.promotions p
  set used_count = greatest(p.used_count - 1, 0)
  where p.id in (select op.promotion_id from public.order_promotions op
                 where op.order_id = v_order.id);

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
-- RLS
-- ============================================================
alter table public.promotions enable row level security;
alter table public.promotion_targets enable row level security;
alter table public.order_promotions enable row level security;

-- 自动促销公开可见（商品页打"促销中"标）；输码型不公开（防爬码）
create policy "promotions: public read auto" on public.promotions
  for select using (code is null or public.is_admin());
create policy "promotions: admin write" on public.promotions
  for all using (public.is_admin());

create policy "promotion_targets: public read" on public.promotion_targets
  for select using (true);
create policy "promotion_targets: admin write" on public.promotion_targets
  for all using (public.is_admin());

create policy "order_promotions: read own or admin" on public.order_promotions
  for select using (
    exists (select 1 from public.orders o
            where o.id = order_id and (o.customer_id = auth.uid() or public.is_admin()))
  );
