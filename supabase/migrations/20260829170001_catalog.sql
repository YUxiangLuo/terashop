-- ============================================================
-- 2. 商品目录：分类 / 商品 / 选项 / 变体 / 图片 / 多仓库存
-- ============================================================

-- ---------- 分类（支持嵌套） ----------
create table public.categories (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  description text not null default '',
  parent_id uuid references public.categories (id) on delete set null,
  image_url text,
  position integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger categories_updated_at before update on public.categories
  for each row execute function public.set_updated_at();

-- ---------- 商品 ----------
-- 注意：商品上没有 price/stock 列 —— 它们属于变体（Shopify 模型：
-- 即使无选项的商品也有 1 个"默认变体"），列表展示用 product_listing 视图
create table public.products (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  description text not null default '',     -- 支持 markdown/html
  status text not null default 'draft' check (status in ('draft', 'active', 'archived')),
  vendor text not null default '',          -- 品牌/供应商
  product_type text not null default '',    -- 自由分类，如 "T恤"、"键盘"
  tags text[] not null default '{}',
  seo_title text,
  seo_description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index products_status_idx on public.products (status);
create index products_type_idx on public.products (product_type);

create trigger products_updated_at before update on public.products
  for each row execute function public.set_updated_at();

create table public.product_categories (
  product_id uuid not null references public.products (id) on delete cascade,
  category_id uuid not null references public.categories (id) on delete cascade,
  primary key (product_id, category_id)
);

create index product_categories_category_idx on public.product_categories (category_id);

-- ---------- 选项与变体 ----------
-- 例：颜色[黑/白] × 尺寸[S/M/L] → 最多 6 个 variant
create table public.product_options (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete cascade,
  name text not null,               -- 颜色 / 尺寸
  position integer not null default 0,
  unique (product_id, name)
);

create table public.product_option_values (
  id uuid primary key default gen_random_uuid(),
  option_id uuid not null references public.product_options (id) on delete cascade,
  value text not null,              -- 黑 / S
  position integer not null default 0,
  unique (option_id, value)
);

create table public.product_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete cascade,
  sku text unique,
  barcode text,
  price numeric(12, 2) not null check (price >= 0),
  compare_at_price numeric(12, 2)   -- 划线价/原价，用于展示折扣
    check (compare_at_price is null or compare_at_price >= price),
  cost numeric(12, 2),              -- 成本价（列级权限：不暴露给客户端）
  track_inventory boolean not null default true,   -- false = 不追踪库存（虚拟商品等）
  position integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index product_variants_product_idx on public.product_variants (product_id);

create trigger product_variants_updated_at before update on public.product_variants
  for each row execute function public.set_updated_at();

-- 变体 ↔ 选项值（多对多；一个变体每个 option 应只挂一个 value，由应用层保证）
create table public.variant_option_values (
  variant_id uuid not null references public.product_variants (id) on delete cascade,
  option_value_id uuid not null references public.product_option_values (id) on delete cascade,
  primary key (variant_id, option_value_id)
);

create index variant_option_values_value_idx on public.variant_option_values (option_value_id);

-- ---------- 商品图片 ----------
create table public.product_images (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete cascade,
  variant_id uuid references public.product_variants (id) on delete set null,  -- 变体专属图
  url text not null,
  alt text not null default '',
  position integer not null default 0
);

create index product_images_product_idx on public.product_images (product_id);

-- ---------- 多仓库存 ----------
create table public.locations (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,        -- WH-SH
  name text not null,
  address jsonb,
  is_default boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- 库存按 (变体, 仓库) 存放；下单扣默认仓。以后多仓履约只改 create_order 的选仓逻辑
create table public.inventory_levels (
  variant_id uuid not null references public.product_variants (id) on delete cascade,
  location_id uuid not null references public.locations (id) on delete cascade,
  on_hand integer not null default 0 check (on_hand >= 0),
  primary key (variant_id, location_id)
);

create index inventory_levels_location_idx on public.inventory_levels (location_id);

-- ---------- 店铺列表视图 ----------
-- 以 owner 身份执行（默认 security_invoker=false），可安全聚合库存；
-- 只暴露"是否有货"布尔与价格区间，不泄露具体库存数和成本价
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
  (select max(v.compare_at_price) from public.product_variants v
    where v.product_id = p.id and v.is_active) as compare_at_from,
  (select i.url from public.product_images i
    where i.product_id = p.id order by i.position, i.id limit 1) as primary_image,
  (select array_agg(c.slug) from public.product_categories pc
    join public.categories c on c.id = pc.category_id
    where pc.product_id = p.id) as categories,
  coalesce((
    select bool_or(not v.track_inventory or il.on_hand > 0)
    from public.product_variants v
    left join public.inventory_levels il on il.variant_id = v.id
    where v.product_id = p.id and v.is_active
  ), false) as in_stock
from public.products p
where p.status = 'active';

-- ============================================================
-- RLS + 列级权限
-- ============================================================
alter table public.categories enable row level security;
alter table public.products enable row level security;
alter table public.product_categories enable row level security;
alter table public.product_options enable row level security;
alter table public.product_option_values enable row level security;
alter table public.product_variants enable row level security;
alter table public.variant_option_values enable row level security;
alter table public.product_images enable row level security;
alter table public.locations enable row level security;
alter table public.inventory_levels enable row level security;

-- 公开读（在售商品及其关联数据）
create policy "categories: public read" on public.categories
  for select using (is_active or public.is_admin());
create policy "products: public read active" on public.products
  for select using (status = 'active' or public.is_admin());
create policy "product_categories: public read" on public.product_categories
  for select using (true);
create policy "product_options: public read" on public.product_options
  for select using (true);
create policy "product_option_values: public read" on public.product_option_values
  for select using (true);
create policy "product_variants: public read active" on public.product_variants
  for select using (is_active or public.is_admin());
create policy "variant_option_values: public read" on public.variant_option_values
  for select using (true);
create policy "product_images: public read" on public.product_images
  for select using (true);
create policy "locations: public read active" on public.locations
  for select using (is_active or public.is_admin());

-- admin 写
create policy "categories: admin write" on public.categories
  for all using (public.is_admin());
create policy "products: admin write" on public.products
  for all using (public.is_admin());
create policy "product_categories: admin write" on public.product_categories
  for all using (public.is_admin());
create policy "product_options: admin write" on public.product_options
  for all using (public.is_admin());
create policy "product_option_values: admin write" on public.product_option_values
  for all using (public.is_admin());
create policy "product_variants: admin write" on public.product_variants
  for all using (public.is_admin());
create policy "variant_option_values: admin write" on public.variant_option_values
  for all using (public.is_admin());
create policy "product_images: admin write" on public.product_images
  for all using (public.is_admin());
create policy "locations: admin write" on public.locations
  for all using (public.is_admin());

-- 库存：精确数字不对外（前端用 product_listing.in_stock），仅 admin 可见可管
create policy "inventory_levels: admin all" on public.inventory_levels
  for all using (public.is_admin());

-- 成本价不对客户端暴露（列级权限，与 RLS 叠加生效）
revoke select on public.product_variants from anon, authenticated;
grant select (id, product_id, sku, barcode, price, compare_at_price,
              track_inventory, position, is_active, created_at, updated_at)
  on public.product_variants to anon, authenticated;
