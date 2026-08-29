-- ============================================================
-- 4. 加固与完善：库存流水、发货校验、地址管理、商品评价
-- ============================================================

-- ---------- 库存流水（审计） ----------
create table public.inventory_movements (
  id bigint generated always as identity primary key,
  variant_id uuid not null references public.product_variants (id),
  location_id uuid not null references public.locations (id),
  delta integer not null,               -- 正 = 入库，负 = 出库
  on_hand_after integer not null,       -- 变动后的结存
  reason text not null check (reason in ('order', 'cancel', 'restock', 'adjust')),
  order_id uuid references public.orders (id),
  actor_id uuid references public.profiles (id),   -- null = 系统
  note text,
  created_at timestamptz not null default now()
);

create index inventory_movements_variant_idx on public.inventory_movements (variant_id, created_at desc);
create index inventory_movements_order_idx on public.inventory_movements (order_id);

alter table public.inventory_movements enable row level security;

create policy "inventory_movements: admin all" on public.inventory_movements
  for all using (public.is_admin());

-- ============================================================
-- create_order v2：合并重复变体行（防拆分绕过库存校验）+ 记库存流水
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

  -- ----- 第 1 遍：合并重复变体行 → 锁变体+库存行（FOR UPDATE）→ 计价并组装快照 -----
  for v_item in
    select jsonb_build_object(
      'variant_id', e.value ->> 'variant_id',
      'quantity', sum((e.value ->> 'quantity')::int)
    ) as line
    from jsonb_array_elements(items) e
    group by e.value ->> 'variant_id'
  loop
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

  -- ----- 第 2 遍：写明细 + 扣库存 + 记流水（行锁仍持有） -----
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
        and location_id = v_location_id
      returning on_hand into v_on_hand;

      insert into public.inventory_movements
        (variant_id, location_id, delta, on_hand_after, reason, order_id, actor_id)
      values (
        (v_item ->> 'variant_id')::uuid, v_location_id,
        -(v_item ->> 'quantity')::int, v_on_hand, 'order', v_order.id, v_uid
      );
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
-- cancel_order v2：回补库存记流水
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

  -- 释放折扣（列名与参数同名，必须加表别名消歧）
  if v_order.discount_id is not null then
    delete from public.discount_redemptions dr where dr.order_id = v_order.id;
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
-- create_fulfillment v2：校验发货数量不超过订购剩余量
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

  select * into v_order from public.orders where id = create_fulfillment.order_id for update;
  if not found then
    raise exception 'order not found';
  end if;
  if v_order.status <> 'open' then
    raise exception 'order is not open (current: %)', v_order.status;
  end if;

  -- ----- 校验：item 属于本订单、数量为正、累计发货不超订购量 -----
  for v_item in select * from jsonb_array_elements(items) loop
    v_qty := coalesce((v_item ->> 'quantity')::int, 0);
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

    select coalesce(sum((it ->> 'quantity')::int), 0) into v_fulfilled
    from public.fulfillments fu, jsonb_array_elements(fu.items) it
    where fu.order_id = v_order.id
      and fu.status <> 'cancelled'
      and (it ->> 'order_item_id')::uuid = (v_item ->> 'order_item_id')::uuid;

    if v_fulfilled + v_qty > v_ordered then
      raise exception 'fulfillment quantity exceeds remaining (ordered %, fulfilled %, requested %)',
        v_ordered, v_fulfilled, v_qty;
    end if;
  end loop;

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
-- RPC：库存调整（admin），记流水
-- ============================================================
create or replace function public.adjust_inventory(
  variant_id uuid,
  delta integer,
  reason text default 'adjust',      -- restock / adjust
  note text default null,
  location_id uuid default null
)
returns public.inventory_levels
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_location_id uuid;
  v_level public.inventory_levels;
begin
  if not public.is_admin() then
    raise exception 'admin only';
  end if;
  if delta is null or delta = 0 then
    raise exception 'delta must be a non-zero integer';
  end if;
  if reason not in ('restock', 'adjust') then
    raise exception 'reason must be restock or adjust';
  end if;

  v_location_id := coalesce(
    adjust_inventory.location_id,
    (select id from public.locations where is_default and is_active limit 1)
  );
  if v_location_id is null then
    raise exception 'no location available';
  end if;

  -- 注意：ON CONFLICT 目标列也会被 plpgsql 当变量解析（参数同名时报歧义），
  -- 所以这里用主键约束名而不是列名
  insert into public.inventory_levels (variant_id, location_id, on_hand)
  values (adjust_inventory.variant_id, v_location_id, 0)
  on conflict on constraint inventory_levels_pkey do nothing;

  -- on_hand >= 0 约束兜底：扣成负数会整体回滚
  update public.inventory_levels il
  set on_hand = il.on_hand + delta
  where il.variant_id = adjust_inventory.variant_id
    and il.location_id = v_location_id
  returning * into v_level;

  insert into public.inventory_movements
    (variant_id, location_id, delta, on_hand_after, reason, actor_id, note)
  values (adjust_inventory.variant_id, v_location_id, adjust_inventory.delta,
          v_level.on_hand, adjust_inventory.reason, auth.uid(), note);

  return v_level;
end;
$$;

-- ============================================================
-- RPC：买家修改订单收货地址（仅未发货前）
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

  update public.orders
  set shipping_address = v_address
  where id = v_order.id
  returning * into v_order;

  insert into public.order_events (order_id, actor_id, type, data)
  values (v_order.id, auth.uid(), 'address_updated',
          jsonb_build_object('shipping_address', v_address));

  return v_order;
end;
$$;

-- ============================================================
-- 地址簿：同一客户只允许一个默认地址
-- ============================================================
create or replace function public.enforce_single_default_address()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  update public.addresses
  set is_default = false
  where customer_id = new.customer_id
    and id <> new.id
    and is_default;
  return new;
end;
$$;

create trigger addresses_single_default
  after insert or update of is_default on public.addresses
  for each row
  when (new.is_default)
  execute function public.enforce_single_default_address();

-- ============================================================
-- 商品评价：每客每商品一条；需审核后公开
-- ============================================================
create table public.product_reviews (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete cascade,
  customer_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  rating integer not null check (rating between 1 and 5),
  title text not null default '',
  body text not null default '',
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_id, customer_id)
);

create index product_reviews_product_idx on public.product_reviews (product_id, status);

create trigger product_reviews_updated_at before update on public.product_reviews
  for each row execute function public.set_updated_at();

alter table public.product_reviews enable row level security;

-- 公开可读已审核的；作者可读自己的；admin 全可见
create policy "product_reviews: public read approved" on public.product_reviews
  for select using (
    status = 'approved' or auth.uid() = customer_id or public.is_admin()
  );
create policy "product_reviews: customer insert own" on public.product_reviews
  for insert with check (auth.uid() = customer_id);
create policy "product_reviews: customer update own" on public.product_reviews
  for update using (auth.uid() = customer_id);
create policy "product_reviews: admin all" on public.product_reviews
  for all using (public.is_admin());

-- 客户不能自己审核自己的评价：列级权限收紧（只能改内容，改了之后回落为待审）
revoke update on public.product_reviews from authenticated;
grant update (rating, title, body) on public.product_reviews to authenticated;

create or replace function public.review_edit_requires_moderation()
returns trigger
language plpgsql
as $$
begin
  -- 非 admin（security definer / service role 除外）修改内容后重新待审
  if new.status = old.status and not public.is_admin() then
    new.status := 'pending';
  end if;
  return new;
end;
$$;

create trigger product_reviews_remoderate before update on public.product_reviews
  for each row execute function public.review_edit_requires_moderation();

-- ============================================================
-- RPC：审核评价（admin）
-- 注：列级权限对 admin JWT 同样生效（同一 authenticated 角色），
--     所以状态变更必须走 security definer RPC
-- ============================================================
create or replace function public.moderate_review(review_id uuid, status text)
returns public.product_reviews
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_review public.product_reviews;
begin
  if not public.is_admin() then
    raise exception 'admin only';
  end if;
  if status not in ('pending', 'approved', 'rejected') then
    raise exception 'invalid status';
  end if;

  update public.product_reviews r
  set status = moderate_review.status
  where r.id = moderate_review.review_id
  returning * into v_review;

  if not found then
    raise exception 'review not found';
  end if;
  return v_review;
end;
$$;

-- ---------- RPC：设置用户角色（admin） ----------
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

-- ============================================================
-- Metafield 引用校验增强：metaobject_reference 必须指向存在的条目
-- ============================================================
create or replace function public.assert_metaobject_exists(p_ref text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if not exists (select 1 from public.metaobjects where id = p_ref::uuid) then
    raise exception 'referenced metaobject not found: %', p_ref;
  end if;
exception
  when invalid_text_representation then
    raise exception 'invalid metaobject reference: %', p_ref;
end;
$$;

create or replace function public.validate_metafield_value()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_ref text;
begin
  case new.type
    when 'text', 'rich_text', 'url', 'color', 'date', 'datetime' then
      if jsonb_typeof(new.value) <> 'string' then
        raise exception 'metafield "%" (%) must be a string', new.key, new.type;
      end if;
    when 'number' then
      if jsonb_typeof(new.value) <> 'number' then
        raise exception 'metafield "%" (number) must be a number', new.key;
      end if;
    when 'boolean' then
      if jsonb_typeof(new.value) <> 'boolean' then
        raise exception 'metafield "%" (boolean) must be a boolean', new.key;
      end if;
    when 'list_text', 'list_number' then
      if jsonb_typeof(new.value) <> 'array' then
        raise exception 'metafield "%" (%) must be an array', new.key, new.type;
      end if;
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
  return new;
end;
$$;
