-- ============================================================
-- Headless 电商核心 schema
-- 原则：最少表、无冗余；事务性操作（下单/取消）一律走 RPC
-- ============================================================

-- ---------------- 用户资料（auth.users 的扩展） ----------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null default '',
  role text not null default 'customer' check (role in ('customer', 'admin')),
  created_at timestamptz not null default now()
);

-- 注册时自动创建 profile
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', ''));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 管理员判定（security definer，避免 RLS 策略里查 profiles 造成递归）
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

-- ---------------- 商品 ----------------
create table public.products (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  description text not null default '',
  category text not null default 'uncategorized',
  price numeric(10, 2) not null check (price >= 0),
  stock integer not null default 0 check (stock >= 0),
  images text[] not null default '{}',
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create index products_category_idx on public.products (category);

-- ---------------- 订单 ----------------
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id),
  status text not null default 'pending' check (
    status in ('pending', 'paid', 'shipped', 'completed', 'cancelled', 'refunded')
  ),
  total numeric(10, 2) not null check (total >= 0),
  -- 收货地址快照：{"receiver": "", "phone": "", "detail": ""}
  shipping_address jsonb not null,
  -- ===== 支付扩展位（接入 Stripe/PayPal 时由 webhook 填写） =====
  payment_provider text check (payment_provider in ('stripe', 'paypal')),
  payment_ref text,        -- 第三方支付单号 (payment_intent / order id)
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

create index orders_user_idx on public.orders (user_id);

create table public.order_items (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders (id) on delete cascade,
  -- 有订单引用的商品禁止物理删除（FK 默认 NO ACTION），下架用 is_active = false
  product_id uuid not null references public.products (id),
  -- 快照字段：下单时的商品名与单价，之后商品改价/改名不影响历史订单
  product_name text not null,
  unit_price numeric(10, 2) not null,
  quantity integer not null check (quantity > 0)
);

create index order_items_order_idx on public.order_items (order_id);

-- ---------------- 下单 RPC ----------------
-- items:   [{"product_id": "uuid", "quantity": 2}, ...]
-- address: {"receiver": "...", "phone": "...", "detail": "..."}
-- 价格完全以服务端为准，客户端传价无效；单事务，任何失败整体回滚
create or replace function public.create_order(items jsonb, address jsonb)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item jsonb;
  v_product public.products;
  v_total numeric(10, 2) := 0;
  v_order public.orders;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if items is null or jsonb_typeof(items) <> 'array' or jsonb_array_length(items) = 0 then
    raise exception 'items must be a non-empty array';
  end if;
  if address is null or address ->> 'receiver' is null or address ->> 'detail' is null then
    raise exception 'address requires at least receiver and detail';
  end if;

  -- 第 1 遍：逐行锁库存（FOR UPDATE 防并发超卖）并计价
  for v_item in select * from jsonb_array_elements(items) loop
    select * into v_product
    from public.products
    where id = (v_item ->> 'product_id')::uuid and is_active
    for update;

    if not found then
      raise exception 'product not found or inactive: %', v_item ->> 'product_id';
    end if;
    if (v_item ->> 'quantity')::int <= 0 then
      raise exception 'quantity must be positive';
    end if;
    if v_product.stock < (v_item ->> 'quantity')::int then
      raise exception 'insufficient stock for "%" (have %, need %)',
        v_product.name, v_product.stock, (v_item ->> 'quantity')::int;
    end if;

    v_total := v_total + v_product.price * (v_item ->> 'quantity')::int;
  end loop;

  insert into public.orders (user_id, total, shipping_address)
  values (auth.uid(), v_total, address)
  returning * into v_order;

  -- 第 2 遍：扣库存 + 写订单明细（行锁仍持有，安全）
  for v_item in select * from jsonb_array_elements(items) loop
    update public.products
    set stock = stock - (v_item ->> 'quantity')::int
    where id = (v_item ->> 'product_id')::uuid
    returning * into v_product;

    insert into public.order_items (order_id, product_id, product_name, unit_price, quantity)
    values (v_order.id, v_product.id, v_product.name, v_product.price,
            (v_item ->> 'quantity')::int);
  end loop;

  return v_order;
end;
$$;

-- ---------------- 取消订单 RPC ----------------
-- 仅允许取消待支付订单；自动回补库存
create or replace function public.cancel_order(order_id uuid)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
begin
  select * into v_order from public.orders where id = cancel_order.order_id for update;

  if not found then
    raise exception 'order not found';
  end if;
  if v_order.user_id <> auth.uid() and not public.is_admin() then
    raise exception 'not allowed';
  end if;
  if v_order.status <> 'pending' then
    raise exception 'only pending orders can be cancelled (current: %)', v_order.status;
  end if;

  -- 回补库存
  update public.products p
  set stock = p.stock + oi.quantity
  from public.order_items oi
  where oi.order_id = v_order.id and oi.product_id = p.id;

  update public.orders set status = 'cancelled' where id = v_order.id
  returning * into v_order;

  return v_order;
end;
$$;

-- ---------------- RLS ----------------
alter table public.profiles enable row level security;
alter table public.products enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;

-- profiles：本人读写；admin 可读全部
create policy "profiles: read own or admin" on public.profiles
  for select using (auth.uid() = id or public.is_admin());
create policy "profiles: update own" on public.profiles
  for update using (auth.uid() = id);

-- products：所有人（含游客）可看在售商品；admin 全权管理
create policy "products: public read active" on public.products
  for select using (is_active or public.is_admin());
create policy "products: admin write" on public.products
  for all using (public.is_admin());

-- orders：本人可读；admin 可读写（发货、退款等状态流转）
-- 注意：没有 insert 策略 → 客户端不能直接建单，必须走 create_order RPC
create policy "orders: read own or admin" on public.orders
  for select using (auth.uid() = user_id or public.is_admin());
create policy "orders: admin update" on public.orders
  for update using (public.is_admin());

-- order_items：跟随订单的可见性
create policy "order_items: read own or admin" on public.order_items
  for select using (
    exists (
      select 1 from public.orders o
      where o.id = order_id and (o.user_id = auth.uid() or public.is_admin())
    )
  );
