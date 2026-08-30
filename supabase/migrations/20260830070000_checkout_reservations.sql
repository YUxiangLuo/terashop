-- ============================================================
-- 9. Checkout Quote + Inventory Reservation
--
-- 新流程：
--   create_checkout_quote（锁库存并预占，不扣 on_hand）
--     -> create_order_from_quote（创建 pending 订单，继续持有预占）
--     -> capture_payment_intent / mark_order_paid（确认支付并转正式扣减）
--
-- V1/V2 create_order 继续兼容“下单即扣 on_hand”，但数据库会扣除活跃预占后
-- 再验证 available，不能穿透新流程已经保留的库存。
-- ============================================================

-- ============================================================
-- A. Quote Header / Lines
-- ============================================================
create table commerce.checkout_quotes (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.profiles (id) on delete restrict,
  status text not null default 'open'
    check (status in ('open', 'converted', 'completed', 'cancelled', 'expired')),
  idempotency_key text not null
    check (length(btrim(idempotency_key)) between 1 and 200),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  pricing_hash text not null check (pricing_hash ~ '^[0-9a-f]{64}$'),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  subtotal numeric(12, 2) not null check (subtotal >= 0),
  discount_total numeric(12, 2) not null default 0
    check (discount_total >= 0 and discount_total <= subtotal),
  shipping_total numeric(12, 2) not null default 0 check (shipping_total >= 0),
  tax_total numeric(12, 2) not null default 0 check (tax_total >= 0),
  total numeric(12, 2) not null check (total >= 0),
  shipping_address jsonb not null check (
    jsonb_typeof(shipping_address) = 'object' and pg_column_size(shipping_address) <= 16384
  ),
  shipping_method_id uuid references public.shipping_methods (id) on delete restrict,
  shipping_method_name text,
  requested_discount_code text
    check (requested_discount_code is null or char_length(requested_discount_code) <= 100),
  customer_note text check (customer_note is null or char_length(customer_note) <= 2000),
  promotions jsonb not null default '[]'::jsonb check (
    jsonb_typeof(promotions) = 'array' and pg_column_size(promotions) <= 65536
  ),
  order_id uuid unique references public.orders (id) on delete restrict,
  cancel_reason text check (cancel_reason is null or char_length(cancel_reason) <= 500),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (customer_id, idempotency_key),
  check (round(subtotal - discount_total + shipping_total + tax_total, 2) = total),
  check (expires_at >= created_at + interval '1 minute'),
  check (expires_at <= created_at + interval '30 minutes'),
  check (status not in ('converted', 'completed') or order_id is not null),
  check (status <> 'open' or order_id is null),
  check (cancel_reason is null or status in ('cancelled', 'expired'))
);

create index checkout_quotes_active_idx
  on commerce.checkout_quotes (expires_at, id)
  where status in ('open', 'converted');
create index checkout_quotes_customer_idx
  on commerce.checkout_quotes (customer_id, created_at desc);

create table commerce.checkout_quote_lines (
  quote_id uuid not null references commerce.checkout_quotes (id) on delete restrict,
  variant_id uuid not null references public.product_variants (id) on delete restrict,
  product_id uuid not null references public.products (id) on delete restrict,
  location_id uuid references public.locations (id) on delete restrict,
  sku text,
  name text not null,
  variant_title text not null default '',
  options jsonb not null default '{}'::jsonb check (jsonb_typeof(options) = 'object'),
  unit_price numeric(12, 2) not null check (unit_price >= 0),
  quantity integer not null check (quantity > 0),
  discount_total numeric(12, 2) not null default 0 check (discount_total >= 0),
  total numeric(12, 2) not null check (total >= 0),
  line_total numeric(12, 2) not null check (line_total >= 0),
  track_inventory boolean not null,
  created_at timestamptz not null default now(),
  primary key (quote_id, variant_id),
  check (round(unit_price * quantity, 2) = total),
  check (round(total - discount_total, 2) = line_total),
  check (discount_total <= total),
  check ((track_inventory and location_id is not null)
      or (not track_inventory and location_id is null))
);

create index checkout_quote_lines_inventory_idx
  on commerce.checkout_quote_lines (variant_id, location_id, quote_id)
  where track_inventory;

-- ============================================================
-- B. Quote State / Immutability
-- ============================================================
create or replace function private.validate_checkout_quote()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'checkout quotes cannot be deleted';
  end if;

  if (new.customer_id, new.idempotency_key, new.request_hash, new.pricing_hash,
      new.currency, new.subtotal, new.discount_total, new.shipping_total,
      new.tax_total, new.total, new.shipping_address, new.shipping_method_id,
      new.shipping_method_name, new.requested_discount_code, new.customer_note,
      new.promotions, new.expires_at, new.created_at)
     is distinct from
     (old.customer_id, old.idempotency_key, old.request_hash, old.pricing_hash,
      old.currency, old.subtotal, old.discount_total, old.shipping_total,
      old.tax_total, old.total, old.shipping_address, old.shipping_method_id,
      old.shipping_method_name, old.requested_discount_code, old.customer_note,
      old.promotions, old.expires_at, old.created_at) then
    raise exception 'checkout quote commercial fields are immutable';
  end if;
  if old.order_id is not null and new.order_id is distinct from old.order_id then
    raise exception 'checkout quote order link is immutable';
  end if;
  if new.status <> old.status and not (
    (old.status = 'open' and new.status in ('converted', 'cancelled', 'expired'))
    or (old.status = 'converted' and new.status in ('completed', 'cancelled', 'expired'))
  ) then
    raise exception 'invalid checkout quote transition: % -> %', old.status, new.status;
  end if;
  if old.order_id is null and new.order_id is not null
     and not (old.status = 'open' and new.status = 'converted') then
    raise exception 'checkout quote can link an order only during conversion';
  end if;
  if new.status in ('converted', 'completed') and new.order_id is null then
    raise exception 'converted checkout quote requires an order';
  end if;
  if old.cancel_reason is not null
     and new.cancel_reason is distinct from old.cancel_reason then
    raise exception 'checkout quote cancel reason is immutable';
  end if;
  if new.cancel_reason is distinct from old.cancel_reason
     and not (old.status <> new.status and new.status in ('cancelled', 'expired')) then
    raise exception 'cancel reason is valid only during cancellation or expiry';
  end if;
  -- 终态不再需要临时地址/备注；订单自身保留依法需要的交易快照。
  if new.status <> old.status and new.status in ('completed', 'cancelled', 'expired') then
    new.shipping_address := '{}'::jsonb;
    new.customer_note := null;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger checkout_quotes_validate
  before update or delete on commerce.checkout_quotes
  for each row execute function private.validate_checkout_quote();
create trigger checkout_quotes_no_truncate
  before truncate on commerce.checkout_quotes
  for each statement execute function private.protect_immutable_row();

create trigger checkout_quote_lines_immutable
  before update or delete on commerce.checkout_quote_lines
  for each row execute function private.protect_immutable_row();
create trigger checkout_quote_lines_no_truncate
  before truncate on commerce.checkout_quote_lines
  for each statement execute function private.protect_immutable_row();

create or replace function private.assert_checkout_quote_totals()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_quote_id uuid;
  v_quote commerce.checkout_quotes;
  v_count integer;
  v_total numeric(12, 2);
  v_discount numeric(12, 2);
begin
  if tg_table_name = 'checkout_quotes' then
    v_quote_id := new.id;
  else
    v_quote_id := coalesce(new.quote_id, old.quote_id);
  end if;
  select * into v_quote from commerce.checkout_quotes q where q.id = v_quote_id;
  if not found then return coalesce(new, old); end if;
  select count(*), coalesce(sum(ql.total), 0), coalesce(sum(ql.discount_total), 0)
  into v_count, v_total, v_discount
  from commerce.checkout_quote_lines ql where ql.quote_id = v_quote_id;
  if v_count = 0 or v_total <> v_quote.subtotal or v_discount <> v_quote.discount_total then
    raise exception 'checkout quote line totals do not match header %', v_quote_id;
  end if;
  return coalesce(new, old);
end;
$$;

create constraint trigger checkout_quotes_require_lines
  after insert on commerce.checkout_quotes
  deferrable initially deferred
  for each row execute function private.assert_checkout_quote_totals();
create constraint trigger checkout_quote_lines_match_header
  after insert or update or delete on commerce.checkout_quote_lines
  deferrable initially deferred
  for each row execute function private.assert_checkout_quote_totals();

-- ============================================================
-- C. Available = on_hand - active reserved
-- ============================================================
create or replace function private.active_reserved_quantity(
  p_variant_id uuid,
  p_location_id uuid,
  p_exclude_quote_id uuid default null
)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(ql.quantity), 0)::integer
  from commerce.checkout_quote_lines ql
  join commerce.checkout_quotes q on q.id = ql.quote_id
  where ql.variant_id = p_variant_id
    and ql.location_id = p_location_id
    and ql.track_inventory
    and q.status in ('open', 'converted')
    and q.expires_at > now()
    and (p_exclude_quote_id is null or q.id <> p_exclude_quote_id);
$$;

create or replace function private.validate_checkout_quote_line_reservation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_quote commerce.checkout_quotes;
  v_variant_product_id uuid;
  v_variant_active boolean;
  v_variant_track_inventory boolean;
  v_product_status text;
  v_on_hand integer;
  v_reserved integer;
begin
  select * into v_quote from commerce.checkout_quotes q
  where q.id = new.quote_id;
  if not found or v_quote.status <> 'open' or v_quote.expires_at <= now() then
    raise exception 'reservation line requires an active open quote';
  end if;
  select v.product_id, v.is_active, v.track_inventory, p.status
  into v_variant_product_id, v_variant_active, v_variant_track_inventory, v_product_status
  from public.product_variants v join public.products p on p.id = v.product_id
  where v.id = new.variant_id;
  if not found or v_variant_product_id <> new.product_id
     or not v_variant_active or v_product_status <> 'active'
     or v_variant_track_inventory <> new.track_inventory then
    raise exception 'reservation line does not match an active variant';
  end if;
  if new.track_inventory then
    select il.on_hand into v_on_hand from public.inventory_levels il
    where il.variant_id = new.variant_id and il.location_id = new.location_id
    for update;
    if not found then raise exception 'inventory level not found for reservation'; end if;
    v_reserved := private.active_reserved_quantity(
      new.variant_id, new.location_id, null
    );
    if v_on_hand - v_reserved < new.quantity then
      raise exception 'reservation line exceeds available stock';
    end if;
  end if;
  return new;
end;
$$;

create trigger checkout_quote_lines_reservation_validate
  before insert on commerce.checkout_quote_lines
  for each row execute function private.validate_checkout_quote_line_reservation();

create or replace function private.protect_reserved_inventory()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reserved integer;
begin
  if tg_op = 'UPDATE'
     and (new.variant_id, new.location_id)
         is distinct from (old.variant_id, old.location_id) then
    raise exception 'inventory level identity is immutable';
  end if;

  v_reserved := private.active_reserved_quantity(old.variant_id, old.location_id, null);
  if tg_op = 'DELETE' then
    if v_reserved > 0 then
      raise exception 'cannot delete inventory with % units reserved', v_reserved;
    end if;
    return old;
  end if;
  -- 负库存仍交给既有 CHECK 约束抛出 23514，保持 API 错误合同。
  if new.on_hand >= 0 and new.on_hand < v_reserved then
    raise exception 'inventory adjustment would consume reserved stock (on_hand %, reserved %)',
      new.on_hand, v_reserved;
  end if;
  return new;
end;
$$;

create trigger inventory_levels_reservation_guard
  before update or delete on public.inventory_levels
  for each row execute function private.protect_reserved_inventory();

-- product_listing 继续只暴露布尔值；一次聚合 active reservation，避免逐变体函数调用。
create or replace view public.product_listing as
with active_reservations as materialized (
  select ql.variant_id, ql.location_id, sum(ql.quantity)::integer as reserved
  from commerce.checkout_quote_lines ql
  join commerce.checkout_quotes q on q.id = ql.quote_id
  where ql.track_inventory
    and q.status in ('open', 'converted')
    and q.expires_at > now()
  group by ql.variant_id, ql.location_id
), default_location as materialized (
  select l.id from public.locations l
  where l.is_default and l.is_active
  order by l.id limit 1
)
select
  p.id, p.slug, p.name, p.description, p.vendor, p.product_type, p.tags, p.created_at,
  (select min(v.price) from public.product_variants v
   where v.product_id = p.id and v.is_active) as price_from,
  ((select v.compare_at_price from public.product_variants v
    where v.product_id = p.id and v.is_active
    order by v.price, v.id limit 1))::numeric as compare_at_from,
  (select i.url from public.product_images i where i.product_id = p.id
   order by i.position, i.id limit 1) as primary_image,
  (select array_agg(c.slug) from public.product_categories pc
   join public.categories c on c.id = pc.category_id
   where pc.product_id = p.id) as categories,
  coalesce((
    select bool_or(
      not v.track_inventory
      or coalesce(il.on_hand, 0) - coalesce(ar.reserved, 0) > 0
    )
    from public.product_variants v
    left join default_location dl on true
    left join public.inventory_levels il
      on il.variant_id = v.id and il.location_id = dl.id
    left join active_reservations ar
      on ar.variant_id = v.id and ar.location_id = dl.id
    where v.product_id = p.id and v.is_active
  ), false) as in_stock
from public.products p
where p.status = 'active';
revoke all on public.product_listing from public, anon, authenticated, service_role;
grant select on public.product_listing to anon, authenticated, service_role;

-- ============================================================
-- D. Safe Quote DTO / Address Resolution
-- ============================================================
create or replace function private.resolve_checkout_address(
  p_customer_id uuid,
  p_address jsonb,
  p_address_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_address jsonb;
begin
  if p_address_id is not null then
    select jsonb_build_object(
      'receiver', a.receiver, 'phone', a.phone, 'country', a.country,
      'province', a.province, 'city', a.city, 'detail', a.detail,
      'postal_code', a.postal_code)
    into v_address
    from public.addresses a
    where a.id = p_address_id and a.customer_id = p_customer_id;
    if not found then raise exception 'address not found'; end if;
  else
    v_address := private.normalize_checkout_address(p_address);
  end if;
  if v_address is null
     or nullif(v_address ->> 'receiver', '') is null
     or nullif(v_address ->> 'detail', '') is null then
    raise exception 'address requires at least receiver and detail';
  end if;
  return v_address || jsonb_build_object(
    'country', private.normalize_country_code(coalesce(v_address ->> 'country', 'CN'))
  );
end;
$$;

create or replace function private.checkout_pricing_hash(p_price jsonb)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select private.command_request_hash(jsonb_build_object(
    'currency', p_price -> 'currency',
    'subtotal', p_price -> 'subtotal',
    'discount_total', p_price -> 'discount_total',
    'shipping_total', p_price -> 'shipping_total',
    'tax_total', p_price -> 'tax_total',
    'total', p_price -> 'total',
    'shipping_method_id', p_price -> 'shipping_method_id',
    'shipping_method_name', p_price -> 'shipping_method_name',
    'lines', (
      select coalesce(jsonb_agg(e.value order by e.value ->> 'variant_id'), '[]'::jsonb)
      from jsonb_array_elements(p_price -> 'lines') e
    ),
    'promotions', (
      select coalesce(jsonb_agg(e.value order by e.value ->> 'promotion_id'), '[]'::jsonb)
      from jsonb_array_elements(p_price -> 'promotions') e
    )
  ));
$$;

create or replace function private.checkout_quote_json(p_quote commerce.checkout_quotes)
returns jsonb
language sql
stable
strict
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_quote.id,
    'status', case
      when p_quote.status in ('open', 'converted') and p_quote.expires_at <= now()
        then 'expired'
      else p_quote.status end,
    'is_reserved', p_quote.status in ('open', 'converted') and p_quote.expires_at > now(),
    'order_id', p_quote.order_id,
    'currency', p_quote.currency,
    'subtotal', p_quote.subtotal,
    'discount_total', p_quote.discount_total,
    'shipping_total', p_quote.shipping_total,
    'tax_total', p_quote.tax_total,
    'total', p_quote.total,
    'shipping_address', p_quote.shipping_address,
    'shipping_method_id', p_quote.shipping_method_id,
    'shipping_method_name', p_quote.shipping_method_name,
    'discount_code', p_quote.requested_discount_code,
    'customer_note', p_quote.customer_note,
    'promotions', p_quote.promotions,
    'cancel_reason', p_quote.cancel_reason,
    'expires_at', p_quote.expires_at,
    'created_at', p_quote.created_at,
    'updated_at', p_quote.updated_at,
    'lines', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'variant_id', ql.variant_id,
        'product_id', ql.product_id,
        'sku', ql.sku,
        'name', ql.name,
        'variant_title', ql.variant_title,
        'options', ql.options,
        'unit_price', ql.unit_price,
        'quantity', ql.quantity,
        'discount_total', ql.discount_total,
        'total', ql.total,
        'line_total', ql.line_total,
        'track_inventory', ql.track_inventory
      ) order by ql.variant_id), '[]'::jsonb)
      from commerce.checkout_quote_lines ql where ql.quote_id = p_quote.id
    )
  );
$$;

-- ============================================================
-- E. Quote Creation / Read / Conversion / Cancellation
-- ============================================================
create or replace function public.create_checkout_quote(
  items jsonb,
  idempotency_key text,
  address jsonb default null,
  address_id uuid default null,
  shipping_method_id uuid default null,
  discount_code text default null,
  note text default null,
  ttl_seconds integer default 900
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_key text := btrim(idempotency_key);
  v_items jsonb;
  v_address_input jsonb;
  v_address jsonb;
  v_code text := upper(nullif(btrim(discount_code), ''));
  v_request_hash text;
  v_location_id uuid;
  v_item jsonb;
  v_variant record;
  v_on_hand integer;
  v_reserved integer;
  v_price jsonb;
  v_line jsonb;
  v_quote commerce.checkout_quotes;
begin
  if v_uid is null then raise exception 'authentication required'; end if;
  if coalesce(v_key, '') = '' or length(v_key) > 200 then
    raise exception 'idempotency_key is required and must be at most 200 characters';
  end if;
  if ttl_seconds is null or ttl_seconds not between 60 and 1800 then
    raise exception 'ttl_seconds must be between 60 and 1800';
  end if;

  v_items := private.canonical_variant_quantities(items);
  if jsonb_array_length(v_items) > 50
     or (select sum((e.value ->> 'quantity')::integer)
         from jsonb_array_elements(v_items) e) > 100 then
    raise exception 'checkout quote is limited to 50 lines and 100 units';
  end if;
  v_address_input := case when address_id is null
                          then private.normalize_checkout_address(address)
                          else null end;
  v_request_hash := private.command_request_hash(jsonb_build_object(
    'items', v_items, 'address', v_address_input, 'address_id', address_id,
    'shipping_method_id', shipping_method_id, 'discount_code', v_code,
    'note', note, 'ttl_seconds', ttl_seconds
  ));

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'checkout.quote:' || v_uid || ':' || v_key, 0));
  -- 不同幂等键也串行执行客户级配额检查。
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'checkout.customer:' || v_uid, 0));
  select * into v_quote from commerce.checkout_quotes q
  where q.customer_id = v_uid and q.idempotency_key = v_key;
  if found then
    if v_quote.request_hash <> v_request_hash then
      raise exception 'idempotency key was used with different quote parameters';
    end if;
    return private.checkout_quote_json(v_quote);
  end if;

  if (select count(*) from commerce.checkout_quotes q
      where q.customer_id = v_uid
        and q.status in ('open', 'converted') and q.expires_at > now()) >= 5 then
    raise exception 'too many active checkout quotes';
  end if;

  v_address := private.resolve_checkout_address(v_uid, v_address_input, address_id);
  select l.id into v_location_id from public.locations l
  where l.is_default and l.is_active order by l.id limit 1;

  -- 固定 variant 顺序，并锁 inventory level；所有库存写路径共用这把行锁。
  for v_item in select value from jsonb_array_elements(v_items)
  loop
    select v.*, p.name product_name, p.status product_status
    into v_variant
    from public.product_variants v
    join public.products p on p.id = v.product_id
    where v.id = (v_item ->> 'variant_id')::uuid
    for update of v;
    if not found or not v_variant.is_active or v_variant.product_status <> 'active' then
      raise exception 'variant not available: %', v_item ->> 'variant_id';
    end if;

    if v_variant.track_inventory then
      if v_location_id is null then raise exception 'no default location configured'; end if;
      insert into public.inventory_levels (variant_id, location_id, on_hand)
      values (v_variant.id, v_location_id, 0)
      on conflict on constraint inventory_levels_pkey do nothing;
      select il.on_hand into v_on_hand from public.inventory_levels il
      where il.variant_id = v_variant.id and il.location_id = v_location_id
      for update;
      v_reserved := private.active_reserved_quantity(v_variant.id, v_location_id, null);
      if v_on_hand - v_reserved < (v_item ->> 'quantity')::integer then
        raise exception 'insufficient available stock for "%" (on_hand %, reserved %, need %)',
          v_variant.product_name, v_on_hand, v_reserved,
          (v_item ->> 'quantity')::integer;
      end if;
    end if;
  end loop;

  v_price := public.price_checkout(v_items, v_address, shipping_method_id, v_code);
  insert into commerce.checkout_quotes (
    customer_id, idempotency_key, request_hash, pricing_hash,
    currency, subtotal, discount_total, shipping_total, tax_total, total,
    shipping_address, shipping_method_id, shipping_method_name,
    requested_discount_code, customer_note, promotions, expires_at
  ) values (
    v_uid, v_key, v_request_hash, private.checkout_pricing_hash(v_price),
    v_price ->> 'currency', (v_price ->> 'subtotal')::numeric,
    (v_price ->> 'discount_total')::numeric,
    (v_price ->> 'shipping_total')::numeric,
    (v_price ->> 'tax_total')::numeric, (v_price ->> 'total')::numeric,
    v_address, (v_price ->> 'shipping_method_id')::uuid,
    v_price ->> 'shipping_method_name', v_code, note,
    coalesce(v_price -> 'promotions', '[]'::jsonb),
    now() + make_interval(secs => ttl_seconds)
  ) returning * into v_quote;

  for v_line in select value from jsonb_array_elements(v_price -> 'lines')
  loop
    insert into commerce.checkout_quote_lines (
      quote_id, variant_id, product_id, location_id, sku, name, variant_title,
      options, unit_price, quantity, discount_total, total, line_total,
      track_inventory
    ) values (
      v_quote.id, (v_line ->> 'variant_id')::uuid,
      (v_line ->> 'product_id')::uuid,
      case when (v_line ->> 'track_inventory')::boolean then v_location_id end,
      v_line ->> 'sku', v_line ->> 'name', v_line ->> 'variant_title',
      v_line -> 'options', (v_line ->> 'unit_price')::numeric,
      (v_line ->> 'quantity')::integer,
      (v_line ->> 'discount_total')::numeric,
      round((v_line ->> 'unit_price')::numeric * (v_line ->> 'quantity')::integer, 2),
      (v_line ->> 'line_total')::numeric,
      (v_line ->> 'track_inventory')::boolean
    );
  end loop;
  return private.checkout_quote_json(v_quote);
end;
$$;

create or replace function public.get_checkout_quote(quote_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_quote commerce.checkout_quotes;
begin
  select * into v_quote from commerce.checkout_quotes q
  where q.id = get_checkout_quote.quote_id
    and (q.customer_id = auth.uid() or public.is_admin());
  if not found then raise exception 'checkout quote not found'; end if;
  return private.checkout_quote_json(v_quote);
end;
$$;

create or replace function public.get_order_checkout_quote(order_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_quote commerce.checkout_quotes;
begin
  select q.* into v_quote
  from commerce.checkout_quotes q
  join public.orders o on o.id = q.order_id
  where q.order_id = get_order_checkout_quote.order_id
    and (o.customer_id = auth.uid() or public.is_admin());
  if not found then raise exception 'checkout quote not found'; end if;
  return private.checkout_quote_json(v_quote);
end;
$$;

create or replace function public.create_order_from_quote(quote_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_quote commerce.checkout_quotes;
  v_order public.orders;
  v_item jsonb;
  v_line jsonb;
  v_promo jsonb;
  v_items jsonb;
  v_price jsonb;
  v_code_used text;
  v_on_hand integer;
  v_reserved integer;
begin
  if v_uid is null then raise exception 'authentication required'; end if;
  select * into v_quote from commerce.checkout_quotes q
  where q.id = create_order_from_quote.quote_id for update;
  if not found or v_quote.customer_id <> v_uid then
    raise exception 'checkout quote not found';
  end if;
  if v_quote.status in ('converted', 'completed') and v_quote.order_id is not null then
    select * into v_order from public.orders o where o.id = v_quote.order_id;
    return private.storefront_order_json(v_order);
  end if;
  if v_quote.status <> 'open' then
    raise exception 'checkout quote is not open (current: %)', v_quote.status;
  end if;
  if v_quote.expires_at <= clock_timestamp() then
    raise exception 'checkout quote has expired';
  end if;

  -- 锁定商品快照，避免转单双算与后台改价交错。
  perform 1
  from public.product_variants v
  where v.id in (
    select ql.variant_id from commerce.checkout_quote_lines ql
    where ql.quote_id = v_quote.id
  )
  order by v.id
  for update of v;

  -- 验证本 quote 的预占仍被 on_hand 完整覆盖。
  for v_item in
    select jsonb_build_object(
      'variant_id', ql.variant_id, 'location_id', ql.location_id,
      'quantity', ql.quantity)
    from commerce.checkout_quote_lines ql
    where ql.quote_id = v_quote.id and ql.track_inventory
    order by ql.variant_id
  loop
    select il.on_hand into v_on_hand from public.inventory_levels il
    where il.variant_id = (v_item ->> 'variant_id')::uuid
      and il.location_id = (v_item ->> 'location_id')::uuid
    for update;
    v_reserved := private.active_reserved_quantity(
      (v_item ->> 'variant_id')::uuid,
      (v_item ->> 'location_id')::uuid,
      null
    );
    if not found or v_on_hand < v_reserved then
      raise exception 'inventory reservation is no longer satisfiable';
    end if;
  end loop;

  -- 转单时重新锁促销并双算；价格或规则变化时要求客户端重新报价。
  perform 1 from public.promotions p
  where p.is_active
    and (p.starts_at is null or now() >= p.starts_at)
    and (p.ends_at is null or now() <= p.ends_at)
    and (
      (v_quote.requested_discount_code is not null
       and p.code = v_quote.requested_discount_code)
      or (p.code is null and p.usage_limit is not null)
    )
  order by p.id for update of p;

  select jsonb_agg(jsonb_build_object(
           'variant_id', ql.variant_id, 'quantity', ql.quantity)
           order by ql.variant_id)
  into v_items
  from commerce.checkout_quote_lines ql where ql.quote_id = v_quote.id;
  v_price := public.price_checkout(
    v_items, v_quote.shipping_address, v_quote.shipping_method_id,
    v_quote.requested_discount_code
  );
  if private.checkout_pricing_hash(v_price) <> v_quote.pricing_hash then
    raise exception 'checkout quote pricing changed; create a new quote';
  end if;
  if v_quote.expires_at <= clock_timestamp() then
    raise exception 'checkout quote expired during conversion';
  end if;

  v_code_used := (
    select p.value ->> 'code' from jsonb_array_elements(v_price -> 'promotions') p
    where p.value ->> 'code' is not null limit 1
  );
  insert into public.orders (
    customer_id, email, currency, subtotal, discount_total, shipping_total, tax_total, total,
    shipping_address, shipping_method_id, shipping_method_name,
    discount_code, customer_note
  ) values (
    v_uid, (select pr.email from public.profiles pr where pr.id = v_uid),
    v_price ->> 'currency', (v_price ->> 'subtotal')::numeric,
    (v_price ->> 'discount_total')::numeric,
    (v_price ->> 'shipping_total')::numeric,
    (v_price ->> 'tax_total')::numeric,
    (v_price ->> 'total')::numeric,
    v_quote.shipping_address, (v_price ->> 'shipping_method_id')::uuid,
    v_price ->> 'shipping_method_name', v_code_used, v_quote.customer_note
  ) returning * into v_order;

  for v_line in select value from jsonb_array_elements(v_price -> 'lines')
  loop
    insert into public.order_items (
      order_id, variant_id, product_id, sku, name, variant_title,
      options, unit_price, quantity, discount_total, total
    ) values (
      v_order.id, (v_line ->> 'variant_id')::uuid,
      (v_line ->> 'product_id')::uuid, v_line ->> 'sku', v_line ->> 'name',
      v_line ->> 'variant_title', v_line -> 'options',
      (v_line ->> 'unit_price')::numeric, (v_line ->> 'quantity')::integer,
      (v_line ->> 'discount_total')::numeric,
      round((v_line ->> 'unit_price')::numeric * (v_line ->> 'quantity')::integer, 2)
    );
  end loop;

  for v_promo in select value from jsonb_array_elements(v_price -> 'promotions')
  loop
    insert into public.order_promotions (order_id, promotion_id, name, code, amount)
    values (v_order.id, (v_promo ->> 'promotion_id')::uuid,
            v_promo ->> 'name', v_promo ->> 'code',
            (v_promo ->> 'amount')::numeric);
    update public.promotions set used_count = used_count + 1
    where id = (v_promo ->> 'promotion_id')::uuid;
    if v_promo ->> 'code' is not null then
      insert into public.discount_redemptions (promotion_id, customer_id, order_id)
      values ((v_promo ->> 'promotion_id')::uuid, v_uid, v_order.id);
    end if;
  end loop;

  update commerce.checkout_quotes
  set status = 'converted', order_id = v_order.id
  where id = v_quote.id
  returning * into v_quote;

  insert into public.order_events (order_id, actor_id, type, data)
  values (v_order.id, v_uid, 'order_created',
          jsonb_build_object('total', v_order.total,
                             'promotions', v_price -> 'promotions',
                             'checkout_quote_id', v_quote.id,
                             'inventory_reserved', true));
  return private.storefront_order_json(v_order);
end;
$$;

-- ============================================================
-- F. Reservation Consumption / Order Guards
-- ============================================================
create or replace function private.consume_order_reservation(p_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_quote commerce.checkout_quotes;
  v_order public.orders;
  v_line record;
  v_on_hand integer;
  v_other_reserved integer;
begin
  select * into v_quote from commerce.checkout_quotes q
  where q.order_id = p_order_id for update;
  if not found then return false; end if;
  if v_quote.status = 'completed' then return true; end if;
  if v_quote.status <> 'converted' then
    raise exception 'checkout reservation is not consumable (current: %)', v_quote.status;
  end if;
  if v_quote.expires_at <= clock_timestamp() then
    raise exception 'checkout reservation has expired';
  end if;
  select * into v_order from public.orders o where o.id = p_order_id;
  if not found
     or (v_order.currency, v_order.subtotal, v_order.discount_total,
         v_order.shipping_total, v_order.tax_total, v_order.total)
        is distinct from
        (v_quote.currency, v_quote.subtotal, v_quote.discount_total,
         v_quote.shipping_total, v_quote.tax_total, v_quote.total) then
    raise exception 'quoted order amounts do not match reservation';
  end if;
  if exists (
    with quoted as (
      select ql.variant_id, sum(ql.quantity)::integer quantity
      from commerce.checkout_quote_lines ql where ql.quote_id = v_quote.id
      group by ql.variant_id
    ), ordered as (
      select oi.variant_id, sum(oi.quantity)::integer quantity
      from public.order_items oi where oi.order_id = p_order_id
      group by oi.variant_id
    )
    select 1 from quoted q full join ordered o using (variant_id)
    where q.variant_id is null or o.variant_id is null or q.quantity <> o.quantity
  ) then
    raise exception 'quoted order items do not match reservation';
  end if;

  -- 先在本事务内移出 active 集合；后续失败会整体回滚。
  update commerce.checkout_quotes set status = 'completed'
  where id = v_quote.id returning * into v_quote;

  for v_line in
    select ql.* from commerce.checkout_quote_lines ql
    where ql.quote_id = v_quote.id and ql.track_inventory
    order by ql.variant_id
  loop
    select il.on_hand into v_on_hand from public.inventory_levels il
    where il.variant_id = v_line.variant_id and il.location_id = v_line.location_id
    for update;
    v_other_reserved := private.active_reserved_quantity(
      v_line.variant_id, v_line.location_id, null
    );
    if not found or v_on_hand - v_other_reserved < v_line.quantity then
      raise exception 'reserved inventory cannot be consumed safely for variant %',
        v_line.variant_id;
    end if;

    update public.inventory_levels il
    set on_hand = il.on_hand - v_line.quantity
    where il.variant_id = v_line.variant_id and il.location_id = v_line.location_id
    returning il.on_hand into v_on_hand;
    insert into public.inventory_movements
      (variant_id, location_id, delta, on_hand_after, reason, order_id, actor_id,
       note)
    values (v_line.variant_id, v_line.location_id, -v_line.quantity, v_on_hand,
            'order', p_order_id, auth.uid(),
            'checkout reservation ' || v_quote.id || ' consumed');
  end loop;

  insert into public.order_events (order_id, actor_id, type, data)
  values (p_order_id, auth.uid(), 'inventory_reservation_consumed',
          jsonb_build_object('checkout_quote_id', v_quote.id));
  return true;
end;
$$;

create or replace function private.protect_quoted_order_snapshot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from commerce.checkout_quotes q
    where q.order_id = old.id and q.status = 'converted'
  ) and (new.customer_id, new.email, new.currency, new.subtotal,
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
    raise exception 'quoted order snapshot is immutable; create a new checkout quote';
  end if;
  return new;
end;
$$;

create trigger orders_quoted_snapshot_immutable
  before update on public.orders
  for each row execute function private.protect_quoted_order_snapshot();

create or replace function private.protect_quoted_order_items()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order_id uuid := coalesce(new.order_id, old.order_id);
begin
  if exists (
    select 1 from commerce.checkout_quotes q
    where q.order_id = v_order_id and q.status = 'converted'
  ) then
    raise exception 'quoted order items are immutable until payment';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger order_items_quoted_order_immutable
  before insert or update or delete on public.order_items
  for each row execute function private.protect_quoted_order_items();

create or replace function private.require_consumed_quote_before_payment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.financial_status = 'pending' and new.financial_status = 'paid'
     and exists (
       select 1 from commerce.checkout_quotes q
       where q.order_id = new.id and q.status <> 'completed'
     ) then
    raise exception 'inventory reservation must be consumed before payment';
  end if;
  return new;
end;
$$;

create trigger orders_quote_payment_guard
  before update of financial_status on public.orders
  for each row execute function private.require_consumed_quote_before_payment();

create or replace function private.prevent_unpaid_quoted_fulfillment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from commerce.checkout_quotes q
    join public.orders o on o.id = q.order_id
    where q.order_id = new.order_id
      and q.status = 'converted' and o.financial_status = 'pending'
  ) then
    raise exception 'quoted order must be paid before fulfillment';
  end if;
  return new;
end;
$$;

create trigger fulfillments_quoted_order_paid
  before insert on public.fulfillments
  for each row execute function private.prevent_unpaid_quoted_fulfillment();

create or replace function private.sync_cancelled_order_quote()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'cancelled' and old.status <> 'cancelled' then
    update commerce.checkout_quotes q
    set status = 'cancelled', cancel_reason = coalesce(new.cancel_reason, 'order cancelled')
    where q.order_id = new.id and q.status = 'converted';
  end if;
  return new;
end;
$$;

create trigger orders_sync_cancelled_quote
  after update of status on public.orders
  for each row execute function private.sync_cancelled_order_quote();

-- V1/V2 订单扣库存时，inventory level trigger 会自动保护 active reservation。
-- 这里保持既有签名，仅在取消前按 quote -> order 顺序预锁，避免与过期 worker 死锁。
create or replace function public.cancel_order(order_id uuid, reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
begin
  perform 1 from commerce.checkout_quotes q
  where q.order_id = cancel_order.order_id for update;
  v_order := private.cancel_order(cancel_order.order_id, cancel_order.reason);
  return private.storefront_order_json(v_order);
end;
$$;

create or replace function public.cancel_checkout_quote(
  quote_id uuid,
  reason text default 'checkout cancelled'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_quote commerce.checkout_quotes;
begin
  select * into v_quote from commerce.checkout_quotes q
  where q.id = cancel_checkout_quote.quote_id for update;
  if not found or (v_quote.customer_id <> auth.uid() and not public.is_admin()) then
    raise exception 'checkout quote not found';
  end if;
  if v_quote.status in ('cancelled', 'expired') then
    return private.checkout_quote_json(v_quote);
  end if;
  if v_quote.status = 'completed' then
    raise exception 'completed checkout quote cannot be cancelled';
  end if;
  if v_quote.status = 'converted' then
    perform public.cancel_order(v_quote.order_id, reason);
  else
    update commerce.checkout_quotes
    set status = 'cancelled', cancel_reason = reason
    where id = v_quote.id returning * into v_quote;
  end if;
  select * into v_quote from commerce.checkout_quotes q where q.id = v_quote.id;
  return private.checkout_quote_json(v_quote);
end;
$$;

-- ============================================================
-- G. Payment Confirmation Converts Reservation
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
  if not public.is_admin() then raise exception 'admin only'; end if;
  -- 与 Webhook 捕获保持 intent -> quote -> order 锁顺序。
  perform 1 from commerce.payment_intents i
  where i.order_id = mark_order_paid.order_id
  order by i.id for update;
  perform 1 from commerce.checkout_quotes q
  where q.order_id = mark_order_paid.order_id for update;
  select * into v_order from public.orders o
  where o.id = mark_order_paid.order_id for update;
  if not found then raise exception 'order not found'; end if;
  if v_order.financial_status <> 'pending' then
    raise exception 'order is not pending payment (current: %)', v_order.financial_status;
  end if;
  if v_order.status <> 'open' then
    raise exception 'order is not open (current: %)', v_order.status;
  end if;

  perform private.consume_order_reservation(v_order.id);
  update commerce.payment_intents i
  set status = 'cancelled'
  where i.order_id = v_order.id and i.status in ('requires_payment_method', 'requires_action', 'processing');
  if v_order.total > 0 then
    return private.mark_order_paid(v_order.id, provider, provider_ref);
  end if;

  update public.orders
  set financial_status = 'paid', paid_at = now(),
      status = case when fulfillment_status = 'fulfilled' then 'completed' else status end,
      completed_at = case when fulfillment_status = 'fulfilled' then now() else completed_at end
  where id = v_order.id returning * into v_order;
  insert into public.order_events (order_id, actor_id, type, data)
  values (v_order.id, auth.uid(), 'payment_received',
          jsonb_build_object('provider', provider, 'amount', 0, 'free_order', true));
  return v_order;
end;
$$;

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
  v_quote commerce.checkout_quotes;
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

  select * into v_quote from commerce.checkout_quotes q
  where q.order_id = create_payment_intent.order_id for update;
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
    if v_quote.id is not null
       and (v_quote.status <> 'converted' or v_quote.expires_at <= clock_timestamp()) then
      raise exception 'checkout reservation is not active';
    end if;
    insert into commerce.payment_intents
      (order_id, provider, amount, currency, idempotency_key, metadata, expires_at)
    values (v_order.id, v_provider, v_order.total, v_order.currency, v_key, metadata,
            case when v_quote.id is not null then v_quote.expires_at end)
    returning * into v_intent;
  end if;

  return jsonb_build_object(
    'id', v_intent.id, 'order_id', v_intent.order_id,
    'provider', v_intent.provider, 'status', v_intent.status,
    'amount', v_intent.amount, 'currency', v_intent.currency,
    'provider_reference', v_intent.provider_reference,
    'expires_at', v_intent.expires_at,
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

  -- 全流程统一 intent -> quote -> order 锁顺序。
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
  if v_intent.status not in ('requires_action', 'processing') then
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
-- H. Expiry Worker / Availability DTO
-- ============================================================
create or replace function public.expire_checkout_quotes(
  max_quotes integer default 100,
  as_of timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_quote commerce.checkout_quotes;
  v_order public.orders;
  v_ids uuid[] := '{}'::uuid[];
  v_count integer := 0;
begin
  if max_quotes is null or max_quotes not between 1 and 500 then
    raise exception 'max_quotes must be between 1 and 500';
  end if;
  if as_of is null then raise exception 'as_of is required'; end if;
  if as_of is null then raise exception 'as_of is required'; end if;

  for v_quote in
    select q.* from commerce.checkout_quotes q
    where q.status in ('open', 'converted') and q.expires_at <= as_of
    order by q.expires_at, q.id
    for update skip locked limit max_quotes
  loop
    if v_quote.status = 'open' then
      update commerce.checkout_quotes
      set status = 'expired', cancel_reason = 'checkout quote expired'
      where id = v_quote.id;
    else
      select * into v_order from public.orders o where o.id = v_quote.order_id for update;
      if v_order.financial_status = 'paid' then
        update commerce.checkout_quotes set status = 'completed'
        where id = v_quote.id;
      elsif v_order.status = 'cancelled' then
        update commerce.checkout_quotes
        set status = 'cancelled', cancel_reason = coalesce(v_order.cancel_reason, 'order cancelled')
        where id = v_quote.id;
      elsif v_order.status = 'open' and v_order.financial_status = 'pending'
            and v_order.fulfillment_status = 'unfulfilled' then
        if exists (
          select 1 from public.inventory_movements im
          where im.order_id = v_order.id and im.reason = 'order' and im.delta < 0
        ) then
          raise exception 'pending quoted order % already consumed inventory', v_order.id;
        end if;
        update commerce.checkout_quotes
        set status = 'expired', cancel_reason = 'checkout reservation expired'
        where id = v_quote.id;
        delete from public.discount_redemptions dr where dr.order_id = v_order.id;
        update public.promotions p
        set used_count = greatest(p.used_count - 1, 0)
        where p.id in (
          select op.promotion_id from public.order_promotions op
          where op.order_id = v_order.id
        );
        update public.orders
        set status = 'cancelled', cancel_reason = 'checkout reservation expired',
            cancelled_at = now()
        where id = v_order.id;
        insert into public.order_events (order_id, actor_id, type, data)
        values (v_order.id, null, 'order_cancelled',
                jsonb_build_object('reason', 'checkout reservation expired',
                                   'checkout_quote_id', v_quote.id));
      else
        raise exception 'cannot expire checkout quote % for order state %/%/%',
          v_quote.id, v_order.status, v_order.financial_status,
          v_order.fulfillment_status;
      end if;
    end if;
    v_ids := array_append(v_ids, v_quote.id);
    v_count := v_count + 1;
  end loop;
  return jsonb_build_object('expired_count', v_count, 'quote_ids', to_jsonb(v_ids));
end;
$$;

create or replace function public.get_inventory_availability(
  variant_id uuid,
  location_id uuid default null
)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_location_id uuid;
  v_on_hand integer;
  v_reserved integer;
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  v_location_id := coalesce(
    get_inventory_availability.location_id,
    (select l.id from public.locations l
     where l.is_default and l.is_active order by l.id limit 1)
  );
  if v_location_id is null then raise exception 'no location available'; end if;
  select il.on_hand into v_on_hand from public.inventory_levels il
  where il.variant_id = get_inventory_availability.variant_id
    and il.location_id = v_location_id;
  v_on_hand := coalesce(v_on_hand, 0);
  v_reserved := private.active_reserved_quantity(
    get_inventory_availability.variant_id, v_location_id, null
  );
  return jsonb_build_object(
    'variant_id', get_inventory_availability.variant_id,
    'location_id', v_location_id,
    'on_hand', v_on_hand,
    'reserved', v_reserved,
    'available', v_on_hand - v_reserved
  );
end;
$$;

-- ============================================================
-- I. Quote Outbox
-- ============================================================
create or replace function private.checkout_quote_to_outbox()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.status <> old.status then
    perform private.enqueue_outbox_event(
      'checkout_quote', new.id, 'checkout_quote.' || new.status,
      jsonb_build_object(
        'checkout_quote_id', new.id, 'order_id', new.order_id,
        'status', new.status, 'amount', new.total, 'currency', new.currency,
        'expires_at', new.expires_at, 'cancel_reason', new.cancel_reason
      ),
      'checkout-quote:' || new.id || ':status:' || new.status
    );
  end if;
  return new;
end;
$$;

create trigger checkout_quotes_enqueue_outbox
  after insert or update of status on commerce.checkout_quotes
  for each row execute function private.checkout_quote_to_outbox();

-- ============================================================
-- J. RLS / ACL
-- ============================================================
alter table commerce.checkout_quotes enable row level security;
alter table commerce.checkout_quote_lines enable row level security;
revoke all on commerce.checkout_quotes from public, anon, authenticated, service_role;
revoke all on commerce.checkout_quote_lines from public, anon, authenticated, service_role;
revoke all on all functions in schema private from public, anon, authenticated;
-- 物理 private schema 仍无 USAGE；此 OID 仅供既有地址 CHECK 执行。
grant execute on function private.valid_country_codes(text[]) to authenticated, service_role;

revoke all on function public.create_checkout_quote(jsonb, text, jsonb, uuid, uuid, text, text, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.get_checkout_quote(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.create_order_from_quote(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.get_order_checkout_quote(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.cancel_checkout_quote(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_checkout_quote(jsonb, text, jsonb, uuid, uuid, text, text, integer)
  to authenticated;
grant execute on function public.get_checkout_quote(uuid) to authenticated;
grant execute on function public.create_order_from_quote(uuid) to authenticated;
grant execute on function public.get_order_checkout_quote(uuid) to authenticated;
grant execute on function public.cancel_checkout_quote(uuid, text) to authenticated;

revoke all on function public.expire_checkout_quotes(integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.expire_checkout_quotes(integer, timestamptz)
  to service_role;

revoke all on function public.get_inventory_availability(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_inventory_availability(uuid, uuid)
  to authenticated;

-- 支付/Outbox service RPC 的既有 allowlist 在 CREATE OR REPLACE 后保持不变；再次显式声明。
revoke all on function public.create_payment_intent(uuid, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.capture_payment_intent(uuid, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.create_payment_intent(uuid, text, text, jsonb) to service_role;
grant execute on function public.capture_payment_intent(uuid, text, text, jsonb) to service_role;
