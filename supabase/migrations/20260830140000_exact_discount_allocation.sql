begin;

-- Current V1 definition, explicitly versioned rather than patched through
-- pg_get_functiondef/string replacement. Keep the existing pricing contract,
-- scopes, BOGO policy and tax calculation; fix allocation and shipping benefit.
create or replace function private.price_checkout(
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
  v_shipping public.shipping_methods;
  v_promo record;
  v_code_found boolean := false;
  v_applied integer := 0;
  v_has_exclusive boolean := false;
  v_scope_qty integer;
  v_min_qty integer;
  v_pct numeric;
  v_amount numeric(12, 2);
  v_base numeric(12, 2);
  v_alloc_sum numeric(12, 2);
  v_room numeric(12, 2);
  v_unit_disc numeric(12, 2);
  v_buy integer;
  v_get integer;
  v_get_pct numeric;
  v_free integer;
  v_get_role text;
  v_fs public.promotions;
  v_deferred_fs public.promotions;
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
    discount_total numeric(12, 2) not null default 0,
    check (discount_total between 0 and unit_price * quantity)
  ) on commit drop;
  if exists (select 1 from pg_catalog.pg_class
             where relname = '_price_promos' and relpersistence = 't'
               and pg_catalog.pg_table_is_visible(oid)) then
    drop table _price_promos;
  end if;
  create temporary table _price_promos (
    promotion_id uuid, name text, code text, amount numeric(12, 2), stackable boolean
  ) on commit drop;

  -- Canonical UUID order also determines equal-remainder tie breaks. UUID case,
  -- cart permutation and splitting a variant across rows cannot change them.
  for v_item in
    select jsonb_build_object(
      'variant_id', (e.value ->> 'variant_id')::uuid,
      'quantity', sum((e.value ->> 'quantity')::int)) as line
    from jsonb_array_elements(items) e
    group by (e.value ->> 'variant_id')::uuid
    order by (e.value ->> 'variant_id')::uuid
  loop
    if coalesce((v_item ->> 'quantity')::int, 0) <= 0 then
      raise exception 'quantity must be positive';
    end if;
    select v.*, p.name as product_name, p.status as product_status into v_variant
    from public.product_variants v join public.products p on p.id = v.product_id
    where v.id = (v_item ->> 'variant_id')::uuid;
    if not found or not v_variant.is_active or v_variant.product_status <> 'active' then
      raise exception 'variant not available: %', v_item ->> 'variant_id';
    end if;
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
            v_variant_title, v_options, (v_item ->> 'quantity')::int, v_variant.price,
            v_cat_ids, v_variant.track_inventory);
  end loop;
  select coalesce(sum(unit_price * quantity), 0) into v_subtotal from _price_lines;

  -- Read one shipping snapshot before choosing promotions. Checking only its
  -- list price mistakes an already-free shipment for a positive-benefit offer.
  if shipping_method_id is not null then
    select * into v_shipping from public.shipping_methods m
    where m.id = shipping_method_id and m.is_active;
    if not found then raise exception 'shipping method not available'; end if;
    if array_length(v_shipping.countries, 1) is not null
       and not (v_country = any(v_shipping.countries)) then
      raise exception 'shipping method not available for this country';
    end if;
  end if;

  for v_promo in
    select p.* from public.promotions p
    where p.is_active
      and (p.type <> 'free_shipping' or v_shipping.price > 0)
      and (p.starts_at is null or now() >= p.starts_at)
      and (p.ends_at is null or now() <= p.ends_at)
      and (p.usage_limit is null or p.used_count < p.usage_limit)
      and (p.code is null or p.code = upper(coalesce(discount_code, '')))
    order by p.priority, p.created_at, (p.code is null), p.code, p.name, p.id
  loop
    if v_promo.code is not null then v_code_found := true; end if;
    if v_applied > 0 and (v_has_exclusive or not v_promo.stackable) then continue; end if;
    if v_promo.code is not null then
      if auth.uid() is not null and (
        select count(*) from public.discount_redemptions dr
        join public.orders o on o.id = dr.order_id
        where dr.promotion_id = v_promo.id and dr.customer_id = auth.uid() and o.status <> 'cancelled'
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
      select coalesce(sum(l.quantity), 0) into v_scope_qty from _price_lines l
      where public._line_in_scope(v_promo.id, 'apply', l.variant_id, l.product_id, l.category_ids);
      if v_scope_qty > 0 and v_scope_qty >= v_min_qty then
        for v_line in
          select * from _price_lines l
          where public._line_in_scope(v_promo.id, 'apply', l.variant_id, l.product_id, l.category_ids)
        loop
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
      select coalesce(sum(l.quantity), 0) into v_scope_qty from _price_lines l
      where public._line_in_scope(v_promo.id, 'apply', l.variant_id, l.product_id, l.category_ids);
      v_get_role := case when exists (
        select 1 from public.promotion_targets t where t.promotion_id = v_promo.id and t.role = 'get'
      ) then 'get' else 'apply' end;
      if v_get_role = 'get' then
        v_free := least(
          (floor(v_scope_qty / v_buy))::int * v_get,
          (select coalesce(sum(l.quantity), 0) from _price_lines l
           where public._line_in_scope(v_promo.id, 'get', l.variant_id, l.product_id, l.category_ids))
        );
      else
        v_free := (floor(v_scope_qty / (v_buy + v_get)))::int * v_get;
      end if;
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
      if v_fs.id is null then
        v_base := v_subtotal - (select coalesce(sum(discount_total), 0) from _price_lines);
        if v_shipping.free_above is null or v_base < v_shipping.free_above then
          -- Prefer the earlier stackable candidate if it became useful after
          -- an intervening goods discount crossed the free-shipping threshold.
          if v_deferred_fs.id is not null then v_fs := v_deferred_fs;
          else v_fs := v_promo; end if;
          v_applied := v_applied + 1;
          if not v_fs.stackable then v_has_exclusive := true; end if;
        elsif v_promo.stackable and v_deferred_fs.id is null then
          v_deferred_fs := v_promo;
        end if;
        -- Zero-benefit exclusive shipping never acquires the exclusivity flag.
      end if;
    end case;

    if v_amount > 0 then
      if v_promo.type in ('order_percentage', 'order_fixed') then
        v_base := v_subtotal - (select coalesce(sum(discount_total), 0) from _price_lines);
        -- Largest remainder in integer minor units. NUMERIC div/mod are exact
        -- even when the product exceeds bigint or a rounded quotient is close
        -- to the next integer. Ties use the canonical line/UUID order above.
        with weights as (
          select idx, (unit_price * quantity - discount_total) * 100 as capacity
          from _price_lines
        ), shares as (
          select idx,
                 div(v_amount * 100 * capacity, v_base * 100) as floor_share,
                 mod(v_amount * 100 * capacity, v_base * 100) as remainder
          from weights
        ), allocation as (
          select idx, floor_share + case
            when row_number() over (order by remainder desc, idx)
                 <= v_amount * 100 - sum(floor_share) over () then 1 else 0 end as minor_share
          from shares
        ), applied as (
          update _price_lines l set discount_total = l.discount_total + a.minor_share / 100
          from allocation a where a.idx = l.idx returning a.minor_share
        )
        select coalesce(sum(minor_share), 0) / 100 into v_alloc_sum from applied;
        if v_alloc_sum is distinct from v_amount then
          raise exception 'discount allocation does not match its target';
        end if;
      end if;
      insert into _price_promos values (v_promo.id, v_promo.name, v_promo.code, v_amount, v_promo.stackable);
      v_applied := v_applied + 1;
      if not v_promo.stackable then v_has_exclusive := true; end if;
    end if;
  end loop;
  if discount_code is not null and not v_code_found then
    raise exception 'invalid or expired discount code';
  end if;
  select coalesce(sum(discount_total), 0) into v_discount_total from _price_lines;

  v_shipping_total := coalesce(v_shipping.price, 0);
  if v_shipping.free_above is not null and v_subtotal - v_discount_total >= v_shipping.free_above then
    v_shipping_total := 0;
  end if;
  if v_fs.id is null and v_shipping_total > 0 and not v_has_exclusive and v_deferred_fs.id is not null then
    v_fs := v_deferred_fs;
  end if;
  if v_fs.id is not null and v_shipping_total > 0 then
    insert into _price_promos values (v_fs.id, v_fs.name, v_fs.code, v_shipping_total, v_fs.stackable);
    v_shipping_total := 0;
  end if;

  select t.rate, t.include_shipping into v_tax_rate, v_tax_inc_ship from public.tax_rates t
  where t.is_active and (t.country = v_country or t.country = '*')
  order by (t.country = '*') asc limit 1;
  v_tax_total := round(
    (v_subtotal - v_discount_total + case when coalesce(v_tax_inc_ship, false) then v_shipping_total else 0 end)
    * coalesce(v_tax_rate, 0), 2);
  select jsonb_agg(jsonb_build_object(
           'variant_id', variant_id, 'product_id', product_id, 'sku', sku, 'name', name,
           'variant_title', variant_title, 'options', options, 'quantity', quantity,
           'unit_price', unit_price, 'discount_total', discount_total, 'track_inventory', track_inventory,
           'line_total', unit_price * quantity - discount_total
         ) order by idx) into v_lines_json from _price_lines;
  select coalesce(jsonb_agg(jsonb_build_object(
           'promotion_id', promotion_id, 'name', name, 'code', code, 'amount', amount
         )), '[]'::jsonb) into v_promos_json from _price_promos;
  return jsonb_build_object(
    'lines', v_lines_json, 'subtotal', v_subtotal, 'discount_total', v_discount_total,
    'promotions', v_promos_json, 'shipping_method_id', v_shipping.id, 'shipping_method_name', v_shipping.name,
    'shipping_total', v_shipping_total, 'tax_total', v_tax_total,
    'total', v_subtotal - v_discount_total + v_shipping_total + v_tax_total, 'currency', 'CNY'
  );
end;
$$;

revoke all on function private.price_checkout(jsonb, jsonb, uuid, text) from public, anon, authenticated;

commit;
