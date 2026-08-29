-- ============================================================
-- 1. 基础层：用户、通用函数、Metafield / Metaobject 扩展体系
-- ============================================================

-- ---------- 通用：自动维护 updated_at ----------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------- 用户资料 ----------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null default '',
  full_name text not null default '',
  phone text,
  role text not null default 'customer' check (role in ('customer', 'admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- 注册时自动创建 profile
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'full_name', '')
  );
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

-- ============================================================
-- Metafields（Shopify 风格）：给任意资源挂类型化自定义字段
-- ============================================================

-- 字段定义（可选但推荐）：声明某个资源类型允许哪些 metafield
create table public.metafield_definitions (
  id uuid primary key default gen_random_uuid(),
  owner_type text not null check (owner_type in
    ('product', 'variant', 'category', 'customer', 'order', 'shop')),
  namespace text not null default 'custom',
  key text not null,
  name text not null,           -- 展示名，如 "洗护说明"
  type text not null check (type in (
    'text', 'rich_text', 'number', 'boolean', 'date', 'datetime',
    'url', 'color', 'json',
    'list_text', 'list_number',
    'metaobject_reference', 'list_metaobject_reference'
  )),
  description text not null default '',
  validations jsonb not null default '{}',   -- {"min":0,"max":100,"choices":[...]}
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_type, namespace, key)
);

create trigger metafield_definitions_updated_at before update on public.metafield_definitions
  for each row execute function public.set_updated_at();

-- 字段值
create table public.metafields (
  id uuid primary key default gen_random_uuid(),
  owner_type text not null check (owner_type in
    ('product', 'variant', 'category', 'customer', 'order', 'shop')),
  owner_id uuid not null,
  namespace text not null default 'custom',
  key text not null,
  type text not null,           -- 与 definition 一致；也允许无定义的自由 metafield
  value jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_type, owner_id, namespace, key)
);

create index metafields_owner_idx on public.metafields (owner_type, owner_id);
-- 支持"按 metafield 筛选商品"类查询：where owner_type='product' and namespace='x' and key='y' and value=...
create index metafields_filter_idx on public.metafields (owner_type, namespace, key);

create trigger metafields_updated_at before update on public.metafields
  for each row execute function public.set_updated_at();

-- 值类型校验：防止写入与声明类型不符的数据
create or replace function public.validate_metafield_value()
returns trigger
language plpgsql
as $$
begin
  case new.type
    when 'text', 'rich_text', 'url', 'color', 'date', 'datetime', 'metaobject_reference' then
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
    when 'list_text', 'list_number', 'list_metaobject_reference' then
      if jsonb_typeof(new.value) <> 'array' then
        raise exception 'metafield "%" (%) must be an array', new.key, new.type;
      end if;
    when 'json' then
      null;  -- 任意结构
    else
      null;
  end case;
  return new;
end;
$$;

create trigger metafields_validate before insert or update on public.metafields
  for each row execute function public.validate_metafield_value();

-- ============================================================
-- Metaobjects（Shopify 风格）：自定义内容类型
-- 例：定义"尺码表"类型（字段：尺码/胸围/衣长），然后创建多条条目，
--     商品通过 metafield(type=list_metaobject_reference) 引用它们
-- ============================================================

create table public.metaobject_definitions (
  id uuid primary key default gen_random_uuid(),
  type text not null unique,    -- 机器名，如 "size_guide"、"designer"
  name text not null,           -- 展示名，如 "尺码表"
  description text not null default '',
  -- 字段结构定义：[{"key":"bust_cm","name":"胸围","type":"number","required":true}, ...]
  fields jsonb not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger metaobject_definitions_updated_at before update on public.metaobject_definitions
  for each row execute function public.set_updated_at();

create table public.metaobjects (
  id uuid primary key default gen_random_uuid(),
  definition_id uuid not null references public.metaobject_definitions (id) on delete cascade,
  handle text not null,         -- 条目标识，如 "m" / "s" / "yohji-yamamoto"
  values jsonb not null default '{}',   -- 按 definition.fields 的 key 存放
  status text not null default 'active' check (status in ('draft', 'active')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (definition_id, handle)
);

create index metaobjects_definition_idx on public.metaobjects (definition_id);

create trigger metaobjects_updated_at before update on public.metaobjects
  for each row execute function public.set_updated_at();

-- ============================================================
-- RLS
-- ============================================================
alter table public.profiles enable row level security;
alter table public.metafield_definitions enable row level security;
alter table public.metafields enable row level security;
alter table public.metaobject_definitions enable row level security;
alter table public.metaobjects enable row level security;

-- profiles：本人可读；admin 可读全部
create policy "profiles: read own or admin" on public.profiles
  for select using (auth.uid() = id or public.is_admin());
create policy "profiles: update own" on public.profiles
  for update using (auth.uid() = id);
-- 客户不能自己改 role / email：列级权限收紧
revoke update on public.profiles from authenticated;
grant update (full_name, phone) on public.profiles to authenticated;

-- metafield / metaobject 定义：公开可读（前端渲染需要），admin 可写
create policy "metafield_definitions: public read" on public.metafield_definitions
  for select using (true);
create policy "metafield_definitions: admin write" on public.metafield_definitions
  for all using (public.is_admin());

create policy "metaobject_definitions: public read" on public.metaobject_definitions
  for select using (is_active or public.is_admin());
create policy "metaobject_definitions: admin write" on public.metaobject_definitions
  for all using (public.is_admin());

create policy "metaobjects: public read active" on public.metaobjects
  for select using (status = 'active' or public.is_admin());
create policy "metaobjects: admin write" on public.metaobjects
  for all using (public.is_admin());

-- metafields：商品域公开读；customer 域仅本人或 admin 可读（可能含隐私）；
-- 写入一律只允许 admin（或 security definer 函数 / service role）。
-- order 域的读取策略在 checkout 迁移中追加（RLS 策略是 OR 关系）。
create policy "metafields: scoped read" on public.metafields
  for select using (
    owner_type in ('product', 'variant', 'category', 'shop')
    or public.is_admin()
    or (owner_type = 'customer' and owner_id = auth.uid())
  );
create policy "metafields: admin write" on public.metafields
  for all using (public.is_admin());
