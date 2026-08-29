-- ============================================================
-- 6. 深度审查修复
--    A. 促销引擎：行级折扣钳制、get_percent 校验、code 归一化、
--       free_shipping 独占语义、并发用量穿透修复、死锁规避
--    B. 交易闭环：改地址重算税/校验运法、退款 RPC、按原仓回补库存
--    C. 权限收拢：orders/payments/fulfillments/inventory_levels 写操作只走 RPC
--    D. 完整性：唯一默认仓、FK 补齐、金额/折扣 CHECK、分类自环
--    E. 扩展体系：metafield 元素类型 + validations 执行、email 同步、
--       最后 admin 保护、GDPR 匿名化
--    F. 视图与索引：in_stock 口径对齐默认仓、compare_at 同源、常用索引
-- ============================================================

-- ---------- D4. 促销 params 校验增强：get_percent ∈ (0,100] ----------
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
      if (new.params ->> 'get_percent') is not null
         and ((new.params ->> 'get_percent')::numeric <= 0
              or (new.params ->> 'get_percent')::numeric > 100) then
        raise exception 'params.get_percent must be in (0, 100]';
      end if;
    when 'free_shipping' then
      null;
  end case;
  return new;
end;
$$;

-- ---------- A3. 促销码统一大写（trigger 归一化 + CHECK 兜底） ----------
create or replace function public.normalize_promotion_code()
returns trigger
language plpgsql
as $$
begin
  if new.code is not null then
    new.code := upper(new.code);
  end if;
  return new;
end;
$$;

create trigger promotions_normalize_code before insert or update of code on public.promotions
  for each row execute function public.normalize_promotion_code();

alter table public.promotions
  add constraint promotions_code_upper_chk check (code is null or code = upper(code));

-- ---------- D1. 默认仓唯一（同一时刻只有一个启用中的默认仓） ----------
create unique index locations_single_default_idx
  on public.locations (is_default) where is_default and is_active;

-- ---------- D2. discount_redemptions.order_id 补外键 ----------
alter table public.discount_redemptions
  add constraint discount_redemptions_order_id_fkey
  foreign key (order_id) references public.orders (id);

-- ---------- D3. payments.amount 恒正（方向由 kind 表达：charge/refund） ----------
alter table public.payments
  add constraint payments_amount_nonneg check (amount >= 0);

-- ---------- D5. 分类禁止自环 ----------
alter table public.categories
  add constraint categories_no_self_parent check (parent_id is null or parent_id <> id);

-- ---------- D6. order_items：折扣钳制约束 + 退款跟踪列 ----------
alter table public.order_items
  add constraint order_items_discount_within_line
    check (discount_total >= 0 and discount_total <= unit_price * quantity),
  add constraint order_items_line_total_nonneg check (line_total >= 0),
  add column refunded_quantity integer not null default 0
    check (refunded_quantity >= 0 and refunded_quantity <= quantity),
  add column refunded_amount numeric(12, 2) not null default 0
    check (refunded_amount >= 0 and refunded_amount <= unit_price * quantity);

-- ---------- B4. 库存流水 reason 增加 return（退货入库） ----------
alter table public.inventory_movements drop constraint inventory_movements_reason_check;
alter table public.inventory_movements
  add constraint inventory_movements_reason_check
  check (reason in ('order', 'cancel', 'restock', 'adjust', 'return'));

-- ---------- B5. 税率：是否对运费计税（辖区差异，默认否） ----------
alter table public.tax_rates
  add column include_shipping boolean not null default false;

-- ---------- F1. 常用索引 ----------
create index orders_created_at_idx on public.orders (created_at desc);
create index order_items_variant_idx on public.order_items (variant_id);
create index inventory_movements_location_idx on public.inventory_movements (location_id);
create index metafields_value_gin_idx on public.metafields using gin (value jsonb_path_ops);

-- ---------- E4. 审计 actor 与用户解耦（匿名化/删除不留 FK 障碍） ----------
alter table public.order_events
  drop constraint order_events_actor_id_fkey,
  add constraint order_events_actor_id_fkey
  foreign key (actor_id) references public.profiles (id) on delete set null;
alter table public.inventory_movements
  drop constraint inventory_movements_actor_id_fkey,
  add constraint inventory_movements_actor_id_fkey
  foreign key (actor_id) references public.profiles (id) on delete set null;

-- ---------- F2. 范围匹配辅助：无需 security definer（targets 本就公开读） ----------
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
-- A. price_checkout v2
--    - 行级折扣钳制：任何促销叠加后单行折扣不超过行金额（杜绝负行/负税）
--    - 订单级分摊以"各行剩余可折金额"为权重，尾差入最后一行，
--      促销落账金额以实际分摊合计为准
--    - free_shipping 参与独占记账：stackable=false 的免邮会阻止后续促销
--    - 税基支持 include_shipping（对运费计税的辖区）
--    - 消除 temp table 的 NOTICE 噪音
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
  v_tax_inc_ship boolean;
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
  v_room numeric(12, 2);
  v_unit_disc numeric(12, 2);
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

  -- 条件式 drop，避免首次调用的 NOTICE 噪音
  if exists (select 1 from pg_catalog.pg_class
             where relname = '_price_lines' and relpersistence = 't'
               and pg_catalog.pg_table_is_visible(oid)) then
    drop table _price_lines;
  end if;
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

  if exists (select 1 from pg_catalog.pg_class
             where relname = '_price_promos' and relpersistence = 't'
               and pg_catalog.pg_table_is_visible(oid)) then
    drop table _price_promos;
  end if;
  create temporary table _price_promos (
    promotion_id uuid, name text, code text, amount numeric(12, 2), stackable boolean
  ) on commit drop;

  -- ===== 1. 展开购物车行（合并重复变体，固定顺序保证输出稳定） =====
  for v_item in
    select jsonb_build_object(
      'variant_id', e.value ->> 'variant_id',
      'quantity', sum((e.value ->> 'quantity')::int)) as line
    from jsonb_array_elements(items) e
    group by e.value ->> 'variant_id'
    order by e.value ->> 'variant_id'
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
          -- 行级钳制：累计折扣不超过行金额
          v_room := v_line.unit_price * v_line.quantity - v_line.discount_total;
          v_disc := least(round(v_line.unit_price * v_line.quantity * v_pct / 100, 2), v_room);
          if v_disc > 0 then
            update _price_lines set discount_total = discount_total + v_disc where idx = v_line.idx;
            v_amount := v_amount + v_disc;
          end if;
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

      -- 最便宜的优先免（防"买便宜送贵"套利）；行级钳制：
      -- 该行剩余可折额度不足时，只免实际承担得起的件数，额度留给下一行
      for v_line in
        select * from _price_lines l
        where public._line_in_scope(v_promo.id, v_get_role, l.variant_id, l.product_id, l.category_ids)
        order by l.unit_price asc, l.idx
      loop
        exit when v_free <= 0;
        v_room := v_line.unit_price * v_line.quantity - v_line.discount_total;
        v_unit_disc := round(v_line.unit_price * v_get_pct / 100, 2);
        if v_unit_disc > 0 and v_room > 0 then
          v_take := least(v_free, v_line.quantity, floor(v_room / v_unit_disc)::int);
          if v_take > 0 then
            v_disc := v_take * v_unit_disc;
            update _price_lines set discount_total = discount_total + v_disc where idx = v_line.idx;
            v_amount := v_amount + v_disc;
            v_free := v_free - v_take;
          end if;
        end if;
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
      -- 免邮促销参与独占记账：stackable=false 时阻止后续促销
      v_applied := v_applied + 1;
      if not v_promo.stackable then
        v_has_exclusive := true;
      end if;
    end case;

    if v_amount > 0 then
      -- 整单级折扣按"各行剩余可折金额"比例分摊（尾差归入最后一行；逐行钳制）
      if v_promo.type in ('order_percentage', 'order_fixed') then
        v_base := v_subtotal - (select coalesce(sum(discount_total), 0) from _price_lines);
        v_alloc_sum := 0;
        select max(idx) into v_last_idx from _price_lines;
        for v_line in select * from _price_lines order by idx loop
          v_room := v_line.unit_price * v_line.quantity - v_line.discount_total;
          if v_line.idx = v_last_idx then
            v_alloc := v_amount - v_alloc_sum;
          else
            v_alloc := round(v_amount * v_room / v_base, 2);
          end if;
          v_alloc := greatest(least(v_alloc, v_room), 0);
          update _price_lines set discount_total = discount_total + v_alloc where idx = v_line.idx;
          v_alloc_sum := v_alloc_sum + v_alloc;
        end loop;
        v_amount := v_alloc_sum;  -- 落账金额以实际分摊合计为准
      end if;

      if v_amount > 0 then
        insert into _price_promos values (v_promo.id, v_promo.name, v_promo.code, v_amount, v_promo.stackable);
        v_applied := v_applied + 1;
        if not v_promo.stackable then
          v_has_exclusive := true;
        end if;
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

  -- 免运费促销（只有真正免到钱才落账、计用量）
  if v_fs_id is not null and v_shipping_total > 0 then
    insert into _price_promos values (v_fs_id, v_fs_name, v_fs_code, v_shipping_total, true);
    v_shipping_total := 0;
  end if;

  -- ===== 4. 税（基于折后金额；税率可配置是否含运费） =====
  select t.rate, t.include_shipping into v_tax_rate, v_tax_inc_ship
  from public.tax_rates t
  where t.is_active and (t.country = v_country or t.country = '*')
  order by (t.country = '*') asc
  limit 1;
  v_tax_total := round(
    (v_subtotal - v_discount_total
     + case when coalesce(v_tax_inc_ship, false) then v_shipping_total else 0 end)
    * coalesce(v_tax_rate, 0), 2);

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
-- A5/A6. create_order v4
--    - 固定变体加锁顺序（order by variant_id），防并发 ABBA 死锁
--    - 计价前锁定涉及的促销行：usage_limit / 每客限次的校验与计数
--      在行锁内串行，修复并发穿透（预览路径只读不加锁）
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

  -- ----- 第 1 阶段：按 variant_id 排序后锁变体 + 库存行（固定顺序防死锁） -----
  for v_item in
    select jsonb_build_object(
      'variant_id', e.value ->> 'variant_id',
      'quantity', sum((e.value ->> 'quantity')::int)) as line
    from jsonb_array_elements(items) e
    group by e.value ->> 'variant_id'
    order by e.value ->> 'variant_id'
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

  -- ----- 第 1.5 阶段：锁定本次涉及的促销行，串行化用量校验与计数 -----
  -- 输码促销按码锁；自动促销只锁有 usage_limit 的（无上限的自动促销无需串行）
  perform 1
  from public.promotions p
  where p.is_active
    and (p.starts_at is null or now() >= p.starts_at)
    and (p.ends_at is null or now() <= p.ends_at)
    and (
      (discount_code is not null and p.code = upper(discount_code))
      or (p.code is null and p.usage_limit is not null)
    )
  order by p.id
  for update of p;

  -- ----- 第 2 阶段：计价（与预览完全同一引擎；此时已在锁内，用量校验可靠） -----
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
-- B3. cancel_order v4：按原始扣减仓回补库存（从流水反查），
--     不再跟随"当前默认仓"（默认仓切换后取消不再回错仓）
-- ============================================================
create or replace function public.cancel_order(order_id uuid, reason text default null)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_default_location uuid;
  v_src_location uuid;
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

  select id into v_default_location from public.locations where is_default and is_active limit 1;

  -- 回补库存（仅追踪库存的变体）并记流水；仓位的权威来源是下单时的扣减流水
  for v_line in
    select oi.variant_id, oi.quantity, v.track_inventory
    from public.order_items oi
    join public.product_variants v on v.id = oi.variant_id
    where oi.order_id = v_order.id
  loop
    if v_line.track_inventory then
      select im.location_id into v_src_location
      from public.inventory_movements im
      where im.order_id = v_order.id
        and im.variant_id = v_line.variant_id
        and im.reason = 'order'
      order by im.id
      limit 1;
      v_src_location := coalesce(v_src_location, v_default_location);  -- 无流水（历史数据）回落默认仓

      if v_src_location is not null then
        insert into public.inventory_levels (variant_id, location_id, on_hand)
        values (v_line.variant_id, v_src_location, 0)
        on conflict on constraint inventory_levels_pkey do nothing;

        update public.inventory_levels il
        set on_hand = il.on_hand + v_line.quantity
        where il.variant_id = v_line.variant_id and il.location_id = v_src_location
        returning il.on_hand into v_on_hand;

        insert into public.inventory_movements
          (variant_id, location_id, delta, on_hand_after, reason, order_id, actor_id)
        values (v_line.variant_id, v_src_location, v_line.quantity, v_on_hand,
                'cancel', v_order.id, auth.uid());
      end if;
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
-- B1. update_order_address v2
--     改地址后：重校验运费方式的国家限制 + 按新国家重新计税并同步 total
-- ============================================================
create or replace function public.update_order_address(
  order_id uuid,
  address jsonb default null,
  address_id uuid default null
)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_address jsonb;
  v_tax_rate numeric(5, 4);
  v_tax_inc_ship boolean;
  v_tax_total numeric(12, 2);
begin
  select * into v_order from public.orders where id = update_order_address.order_id for update;

  if not found then
    raise exception 'order not found';
  end if;
  if v_order.customer_id <> auth.uid() and not public.is_admin() then
    raise exception 'not allowed';
  end if;
  if v_order.status <> 'open' then
    raise exception 'order is not open (current: %)', v_order.status;
  end if;
  if v_order.fulfillment_status <> 'unfulfilled' then
    raise exception 'order already has fulfillments, address is locked';
  end if;

  if address_id is not null then
    select jsonb_build_object(
      'receiver', a.receiver, 'phone', a.phone, 'country', a.country,
      'province', a.province, 'city', a.city, 'detail', a.detail,
      'postal_code', a.postal_code)
    into v_address
    from public.addresses a
    where a.id = address_id and a.customer_id = v_order.customer_id;
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
  -- 国家归一化（与 create_order 一致）
  v_address := coalesce(v_address, '{}') || jsonb_build_object('country', coalesce(v_address ->> 'country', 'CN'));

  -- 运费方式的国家限制重校验：地址变了，原运法可能不再可用
  if v_order.shipping_method_id is not null and exists (
    select 1 from public.shipping_methods m
    where m.id = v_order.shipping_method_id
      and array_length(m.countries, 1) is not null
      and not (v_address ->> 'country' = any (m.countries))
  ) then
    raise exception 'shipping method not available for this country';
  end if;

  -- 重新计税（按新收货国家匹配，'*' 兜底；遵循 include_shipping 开关）并同步 total
  select t.rate, t.include_shipping into v_tax_rate, v_tax_inc_ship
  from public.tax_rates t
  where t.is_active and (t.country = v_address ->> 'country' or t.country = '*')
  order by (t.country = '*') asc
  limit 1;
  v_tax_total := round(
    (v_order.subtotal - v_order.discount_total
     + case when coalesce(v_tax_inc_ship, false) then v_order.shipping_total else 0 end)
    * coalesce(v_tax_rate, 0), 2);

  update public.orders
  set shipping_address = v_address,
      tax_total = v_tax_total,
      total = v_order.subtotal - v_order.discount_total + v_order.shipping_total + v_tax_total
  where id = v_order.id
  returning * into v_order;

  insert into public.order_events (order_id, actor_id, type, data)
  values (v_order.id, auth.uid(), 'address_updated',
          jsonb_build_object('shipping_address', v_address, 'tax_total', v_tax_total));

  return v_order;
end;
$$;

-- ============================================================
-- B2. refund_order（新）：admin 退款（全额 / 按行部分 / 自定义金额）
--     - 行退款按 line_total（折后净额）比例；退完该行取剩余全部，消除舍入误差
--     - 写 payments(kind=refund, amount 恒正)、推进 financial_status、记事件
--     - restock=true 时按原扣减仓回补库存（流水 reason='return'）
-- ============================================================
create or replace function public.refund_order(
  order_id uuid,
  items jsonb default null,          -- [{"order_item_id":"...","quantity":1}]；与 amount 二选一
  amount numeric default null,       -- 自定义退款额（不挂钩行，如退运费/补偿）
  reason text default null,
  restock boolean default false,
  provider text default 'manual'
)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_refunded numeric(12, 2);
  v_refundable numeric(12, 2);
  v_amount numeric(12, 2) := 0;
  v_item jsonb;
  v_line record;
  v_qty integer;
  v_line_refund numeric(12, 2);
  v_default_location uuid;
  v_src_location uuid;
  v_on_hand integer;
begin
  if not public.is_admin() then
    raise exception 'admin only';
  end if;
  if items is not null and amount is not null then
    raise exception 'pass either items or amount, not both';
  end if;

  select * into v_order from public.orders where id = refund_order.order_id for update;
  if not found then
    raise exception 'order not found';
  end if;
  if v_order.financial_status not in ('paid', 'partially_refunded') then
    raise exception 'order is not refundable (current: %)', v_order.financial_status;
  end if;

  -- 已退合计（以成功的 refund 支付记录为准）
  select coalesce(sum(p.amount), 0) into v_refunded
  from public.payments p
  where p.order_id = v_order.id and p.kind = 'refund' and p.status = 'succeeded';
  v_refundable := v_order.total - v_refunded;
  if v_refundable <= 0 then
    raise exception 'order already fully refunded';
  end if;

  select id into v_default_location from public.locations where is_default and is_active limit 1;

  if items is not null then
    if jsonb_typeof(items) <> 'array' or jsonb_array_length(items) = 0 then
      raise exception 'items must be a non-empty array';
    end if;

    for v_item in select * from jsonb_array_elements(items) loop
      v_qty := coalesce((v_item ->> 'quantity')::int, 0);
      if v_qty <= 0 then
        raise exception 'refund quantity must be positive';
      end if;

      select oi.*, pv.track_inventory into v_line
      from public.order_items oi
      left join public.product_variants pv on pv.id = oi.variant_id
      where oi.id = (v_item ->> 'order_item_id')::uuid
        and oi.order_id = v_order.id
      for update of oi;
      if not found then
        raise exception 'order item % does not belong to this order', v_item ->> 'order_item_id';
      end if;
      if v_line.refunded_quantity + v_qty > v_line.quantity then
        raise exception 'refund quantity exceeds refundable (ordered %, refunded %, requested %)',
          v_line.quantity, v_line.refunded_quantity, v_qty;
      end if;

      -- 行退款额：退完该行时取剩余全部（消除多次部分退款的舍入误差），否则按数量比例
      if v_line.refunded_quantity + v_qty = v_line.quantity then
        v_line_refund := v_line.line_total - v_line.refunded_amount;
      else
        v_line_refund := round(v_line.line_total * v_qty / v_line.quantity, 2);
      end if;

      update public.order_items oi
      set refunded_quantity = oi.refunded_quantity + v_qty,
          refunded_amount = oi.refunded_amount + v_line_refund
      where oi.id = v_line.id;

      v_amount := v_amount + v_line_refund;

      -- 退货入库：按原扣减仓回补（无流水记录时回落默认仓）
      if restock and v_line.track_inventory then
        select im.location_id into v_src_location
        from public.inventory_movements im
        where im.order_id = v_order.id
          and im.variant_id = v_line.variant_id
          and im.reason = 'order'
        order by im.id
        limit 1;
        v_src_location := coalesce(v_src_location, v_default_location);

        if v_src_location is not null then
          insert into public.inventory_levels (variant_id, location_id, on_hand)
          values (v_line.variant_id, v_src_location, 0)
          on conflict on constraint inventory_levels_pkey do nothing;

          update public.inventory_levels il
          set on_hand = il.on_hand + v_qty
          where il.variant_id = v_line.variant_id and il.location_id = v_src_location
          returning il.on_hand into v_on_hand;

          insert into public.inventory_movements
            (variant_id, location_id, delta, on_hand_after, reason, order_id, actor_id, note)
          values (v_line.variant_id, v_src_location, v_qty, v_on_hand,
                  'return', v_order.id, auth.uid(), reason);
        end if;
      end if;
    end loop;
  elsif amount is not null then
    if amount <= 0 then
      raise exception 'refund amount must be positive';
    end if;
    if amount > v_refundable then
      raise exception 'refund amount exceeds refundable (requested %, refundable %)', amount, v_refundable;
    end if;
    v_amount := amount;
  else
    v_amount := v_refundable;   -- 全额退剩余
  end if;

  insert into public.payments (order_id, provider, kind, status, amount, currency)
  values (v_order.id, provider, 'refund', 'succeeded', v_amount, v_order.currency);

  update public.orders
  set financial_status = case
        when v_refunded + v_amount >= v_order.total then 'refunded'
        else 'partially_refunded' end
  where id = v_order.id
  returning * into v_order;

  insert into public.order_events (order_id, actor_id, type, data)
  values (v_order.id, auth.uid(), 'refund_created',
          jsonb_build_object('amount', v_amount, 'reason', reason,
                             'restock', restock, 'items', items));

  return v_order;
end;
$$;

-- ============================================================
-- C. 权限收拢：状态类写操作只能走 security definer RPC / service role
--    （RLS 控制行可见性，列级权限控制可写列；admin JWT 同样受限）
-- ============================================================

-- orders：admin 只能直改 admin_note（备注），金额/状态字段必须走 RPC
revoke update on public.orders from anon, authenticated;
grant update (admin_note) on public.orders to authenticated;

-- payments：写入只走 mark_order_paid / refund_order / service role（webhook）
revoke insert, update, delete on public.payments from anon, authenticated;
drop policy if exists "payments: admin write" on public.payments;

-- fulfillments：写入只走 create_fulfillment RPC（保证数量校验与状态联动）
revoke insert, update, delete on public.fulfillments from anon, authenticated;
drop policy if exists "fulfillments: admin write" on public.fulfillments;

-- inventory_levels：写入只走 adjust_inventory / create_order / cancel / refund（保证流水完整）
revoke insert, update, delete on public.inventory_levels from anon, authenticated;

-- ---------- E1. set_user_role：保护最后一个 admin ----------
create or replace function public.set_user_role(user_id uuid, role text)
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles;
begin
  if not public.is_admin() then
    raise exception 'admin only';
  end if;
  if role not in ('customer', 'admin') then
    raise exception 'invalid role';
  end if;
  -- 防止把最后一个 admin 降级（否则后台永久失管）
  if role <> 'admin'
     and exists (select 1 from public.profiles p where p.id = set_user_role.user_id and p.role = 'admin')
     and (select count(*) from public.profiles p where p.role = 'admin') <= 1 then
    raise exception 'cannot demote the last admin';
  end if;

  update public.profiles p
  set role = set_user_role.role
  where p.id = set_user_role.user_id
  returning * into v_profile;

  if not found then
    raise exception 'user not found';
  end if;
  return v_profile;
end;
$$;

-- ---------- E2. auth 邮箱变更同步到 profiles（订单邮箱取自 profiles） ----------
create or replace function public.handle_user_email_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles set email = coalesce(new.email, '') where id = new.id;
  return new;
end;
$$;

create trigger on_auth_user_email_updated
  after update of email on auth.users
  for each row execute function public.handle_user_email_change();

-- ---------- E3. anonymize_user：GDPR 匿名化（admin） ----------
-- 财务记录（orders/payments/order_events）依法保留，actor 已 set null 解耦；
-- auth.users 的硬删除会被 orders.customer_id 的 NO ACTION 阻止（刻意为之）。
create or replace function public.anonymize_user(p_user_id uuid)
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles;
begin
  if not public.is_admin() then
    raise exception 'admin only';
  end if;

  update public.profiles p
  set email = '', full_name = '', phone = null
  where p.id = p_user_id
  returning * into v_profile;
  if not found then
    raise exception 'user not found';
  end if;

  delete from public.addresses a where a.customer_id = p_user_id;
  delete from public.metafields m where m.owner_type = 'customer' and m.owner_id = p_user_id;

  return v_profile;
end;
$$;

-- ---------- E5. metafield 校验增强：list 元素类型 + date 格式 + definition.validations ----------
create or replace function public.validate_metafield_value()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_ref text;
  v_elem jsonb;
  v_validations jsonb;
begin
  case new.type
    when 'text', 'rich_text', 'url', 'color' then
      if jsonb_typeof(new.value) <> 'string' then
        raise exception 'metafield "%" (%) must be a string', new.key, new.type;
      end if;
    when 'date', 'datetime' then
      if jsonb_typeof(new.value) <> 'string' then
        raise exception 'metafield "%" (%) must be a string', new.key, new.type;
      end if;
      begin
        if new.type = 'date' then
          perform (new.value #>> '{}')::date;
        else
          perform (new.value #>> '{}')::timestamptz;
        end if;
      exception when others then
        raise exception 'metafield "%" (%) has invalid value: %', new.key, new.type, new.value #>> '{}';
      end;
    when 'number' then
      if jsonb_typeof(new.value) <> 'number' then
        raise exception 'metafield "%" (number) must be a number', new.key;
      end if;
    when 'boolean' then
      if jsonb_typeof(new.value) <> 'boolean' then
        raise exception 'metafield "%" (boolean) must be a boolean', new.key;
      end if;
    when 'list_text' then
      if jsonb_typeof(new.value) <> 'array' then
        raise exception 'metafield "%" (%) must be an array', new.key, new.type;
      end if;
      for v_elem in select jsonb_array_elements(new.value) loop
        if jsonb_typeof(v_elem) <> 'string' then
          raise exception 'metafield "%" (list_text) elements must be strings', new.key;
        end if;
      end loop;
    when 'list_number' then
      if jsonb_typeof(new.value) <> 'array' then
        raise exception 'metafield "%" (%) must be an array', new.key, new.type;
      end if;
      for v_elem in select jsonb_array_elements(new.value) loop
        if jsonb_typeof(v_elem) <> 'number' then
          raise exception 'metafield "%" (list_number) elements must be numbers', new.key;
        end if;
      end loop;
    when 'metaobject_reference' then
      if jsonb_typeof(new.value) <> 'string' then
        raise exception 'metafield "%" (%) must be a string', new.key, new.type;
      end if;
      perform public.assert_metaobject_exists(new.value #>> '{}');
    when 'list_metaobject_reference' then
      if jsonb_typeof(new.value) <> 'array' then
        raise exception 'metafield "%" (%) must be an array', new.key, new.type;
      end if;
      for v_ref in select jsonb_array_elements_text(new.value) loop
        perform public.assert_metaobject_exists(v_ref);
      end loop;
    when 'json' then
      null;  -- 任意结构
    else
      null;
  end case;

  -- definition.validations 执行：min/max（number）、choices（标量白名单）
  select d.validations into v_validations
  from public.metafield_definitions d
  where d.owner_type = new.owner_type
    and d.namespace = new.namespace
    and d.key = new.key;

  if found then
    if new.type = 'number' then
      if v_validations ? 'min'
         and (new.value #>> '{}')::numeric < (v_validations ->> 'min')::numeric then
        raise exception 'metafield "%" must be >= %', new.key, v_validations ->> 'min';
      end if;
      if v_validations ? 'max'
         and (new.value #>> '{}')::numeric > (v_validations ->> 'max')::numeric then
        raise exception 'metafield "%" must be <= %', new.key, v_validations ->> 'max';
      end if;
    end if;
    if v_validations ? 'choices' and jsonb_typeof(new.value) <> 'array' then
      if not (v_validations -> 'choices' @> new.value) then
        raise exception 'metafield "%" must be one of %', new.key, v_validations -> 'choices';
      end if;
    end if;
  end if;

  return new;
end;
$$;

-- ---------- F3. product_listing：in_stock 口径对齐下单（只看默认仓）、
--                compare_at_from 取最低价比 variant 的划线价（同源不误导） ----------
create or replace view public.product_listing as
select
  p.id,
  p.slug,
  p.name,
  p.description,
  p.vendor,
  p.product_type,
  p.tags,
  p.created_at,
  (select min(v.price) from public.product_variants v
    where v.product_id = p.id and v.is_active) as price_from,
  (select v.compare_at_price from public.product_variants v
    where v.product_id = p.id and v.is_active
    order by v.price, v.id limit 1)::numeric as compare_at_from,
  (select i.url from public.product_images i
    where i.product_id = p.id order by i.position, i.id limit 1) as primary_image,
  (select array_agg(c.slug) from public.product_categories pc
    join public.categories c on c.id = pc.category_id
    where pc.product_id = p.id) as categories,
  coalesce((
    select bool_or(not v.track_inventory or il.on_hand > 0)
    from public.product_variants v
    left join public.inventory_levels il
      on il.variant_id = v.id
     and il.location_id = (select l.id from public.locations l
                           where l.is_default and l.is_active
                           order by l.id limit 1)
    where v.product_id = p.id and v.is_active
  ), false) as in_stock
from public.products p
where p.status = 'active';
