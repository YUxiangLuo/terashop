-- Pricing, order commands and inventory reservations
-- Cross-domain function references are resolved after all definitions are installed.
begin;
set local check_function_bodies = false;

CREATE FUNCTION private.assert_checkout_capacity(p_customer_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('checkout.customer:' || p_customer_id, 0));
  if (select count(*) from commerce.checkout_quotes q where q.customer_id = p_customer_id
      and q.status = 'open' and q.expires_at > clock_timestamp())
     + (select count(*) from public.orders o where o.customer_id = p_customer_id
        and o.status = 'open' and o.financial_status = 'pending' and o.payment_expires_at > clock_timestamp()) >= 5 then
    raise exception 'too many active checkouts (quotes and unpaid orders)';
  end if;
end;
$$;

CREATE FUNCTION private.protect_order_payment_window() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
begin
  if (new.payment_expires_at, new.created_at) is distinct from (old.payment_expires_at, old.created_at) then
    raise exception 'order payment window is immutable';
  end if;
  return new;
end;
$$;

CREATE FUNCTION private.active_reserved_quantity(p_variant_id uuid, p_location_id uuid, p_exclude_quote_id uuid DEFAULT NULL::uuid) RETURNS integer
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
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

CREATE FUNCTION private.assert_checkout_quote_totals() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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

CREATE FUNCTION private.cancel_order(order_id uuid, reason text DEFAULT NULL::text) RETURNS public.orders
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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
  if v_order.customer_id is distinct from auth.uid() and not public.is_admin()
     and auth.role() is distinct from 'service_role' then
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

  perform private.lock_order_inventory(array[v_order.id]);
  for v_stock in
    select im.variant_id, im.location_id, (-sum(im.delta))::integer as quantity
    from public.inventory_movements im
    where im.order_id = v_order.id
      and im.reason = 'order'
      and im.delta < 0
    group by im.variant_id, im.location_id order by im.variant_id, im.location_id
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

-- Generic JSON builders/aggregates are catalog-STABLE, but these UUID/integer-only
-- inputs are deterministic. Keep IMMUTABLE; the lint exception pins this SQL and
-- tests cover canonical output/hash across input permutations and session settings.
CREATE FUNCTION private.canonical_variant_quantities(p_items jsonb) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO ''
    AS $_$
declare
  v_item jsonb;
  v_result jsonb;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'items must be a non-empty array';
  end if;
  for v_item in select value from jsonb_array_elements(p_items)
  loop
    if jsonb_typeof(v_item) <> 'object' or coalesce(v_item ->> 'variant_id', '') = '' then
      raise exception 'each item requires variant_id';
    end if;
    perform (v_item ->> 'variant_id')::uuid;
    if coalesce(v_item ->> 'quantity', '') !~ '^[1-9][0-9]*$' then
      raise exception 'item quantity must be a positive integer';
    end if;
  end loop;
  select jsonb_agg(jsonb_build_object(
           'variant_id', x.variant_id, 'quantity', x.quantity)
           order by x.variant_id)
  into v_result
  from (
    select (e.value ->> 'variant_id')::uuid variant_id,
           sum((e.value ->> 'quantity')::integer)::integer quantity
    from jsonb_array_elements(p_items) e
    group by (e.value ->> 'variant_id')::uuid
  ) x;
  return v_result;
end;
$_$;

CREATE FUNCTION private.checkout_pricing_hash(p_price jsonb) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT
    SET search_path TO ''
    AS $$
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

CREATE FUNCTION private.checkout_quote_json(p_quote commerce.checkout_quotes) RETURNS jsonb
    LANGUAGE sql STABLE STRICT SECURITY DEFINER
    SET search_path TO ''
    AS $$
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

CREATE FUNCTION private.checkout_quote_to_outbox() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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

CREATE FUNCTION private.consume_order_reservation(p_order_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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

CREATE FUNCTION private.create_order(items jsonb, address jsonb DEFAULT NULL::jsonb, address_id uuid DEFAULT NULL::uuid, shipping_method_id uuid DEFAULT NULL::uuid, discount_code text DEFAULT NULL::text, note text DEFAULT NULL::text) RETURNS public.orders
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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

  items := private.canonical_variant_quantities(items);
  if jsonb_array_length(items) > 50 or (select sum((e->>'quantity')::integer) from jsonb_array_elements(items) e) > 100 then
    raise exception 'checkout is limited to 50 lines and 100 units';
  end if;
  perform private.assert_checkout_capacity(v_uid);
  v_address := private.resolve_checkout_address(v_uid, address, address_id);

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
    -- Stabilize pricing without conflicting with inventory-movement FK KEY SHARE locks.
    for no key update of v;

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

CREATE FUNCTION private.prevent_unpaid_fulfillment() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if exists (
    select 1 from public.orders o where o.id = new.order_id and o.financial_status = 'pending'
  ) then
    raise exception 'order must be paid before fulfillment';
  end if;
  return new;
end;
$$;

CREATE FUNCTION private.price_checkout(items jsonb, address jsonb DEFAULT NULL::jsonb, shipping_method_id uuid DEFAULT NULL::uuid, discount_code text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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
  v_country := private.normalize_checkout_address(address) ->> 'country';
  if shipping_method_id is not null and v_country is null then
    raise exception 'shipping requires an explicit destination country';
  end if;

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
  where v_country is not null and t.is_active and (t.country = v_country or t.country = '*')
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
    'total', v_subtotal - v_discount_total + v_shipping_total + v_tax_total, 'currency', 'USD'
  );
end;
$$;

CREATE FUNCTION private.protect_quoted_order_items() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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

CREATE FUNCTION private.protect_quoted_order_snapshot() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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

CREATE FUNCTION private.protect_reserved_inventory() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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

CREATE FUNCTION private.require_consumed_quote_before_payment() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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

CREATE FUNCTION private.resolve_checkout_address(p_customer_id uuid, p_address jsonb, p_address_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_address jsonb;
begin
  if p_address_id is not null then
    select jsonb_build_object(
      'recipient_name', a.recipient_name, 'phone', a.phone, 'country', a.country,
      'region', a.region, 'city', a.city, 'line1', a.line1,
      'line2', a.line2, 'postal_code', a.postal_code)
    into v_address
    from public.addresses a
    where a.id = p_address_id and a.customer_id = p_customer_id;
    if not found then raise exception 'address not found'; end if;
  else
    v_address := private.normalize_checkout_address(p_address);
  end if;
  if v_address is null
     or nullif(btrim(v_address ->> 'recipient_name'), '') is null
     or nullif(btrim(v_address ->> 'line1'), '') is null then
    raise exception 'address requires recipient_name, line1 and country';
  end if;
  return private.normalize_checkout_address(v_address);
end;
$$;

CREATE FUNCTION private.storefront_order_json(p_order public.orders) RETURNS jsonb
    LANGUAGE sql IMMUTABLE STRICT
    SET search_path TO ''
    AS $$
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
    'payment_expires_at', p_order.payment_expires_at,
    'cancelled_at', p_order.cancelled_at,
    'completed_at', p_order.completed_at,
    'created_at', p_order.created_at,
    'updated_at', p_order.updated_at
  );
$$;

CREATE FUNCTION private.sync_cancelled_order_quote() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if new.status = 'cancelled' and old.status <> 'cancelled' then
    update commerce.checkout_quotes q
    set status = 'cancelled', cancel_reason = coalesce(new.cancel_reason, 'order cancelled')
    where q.order_id = new.id and q.status = 'converted';
  end if;
  return new;
end;
$$;

CREATE FUNCTION private.update_order_address(order_id uuid, address jsonb DEFAULT NULL::jsonb, address_id uuid DEFAULT NULL::uuid) RETURNS public.orders
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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

  v_address := private.resolve_checkout_address(v_order.customer_id, address, address_id);

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

CREATE FUNCTION private.validate_checkout_quote() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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

CREATE FUNCTION private.validate_checkout_quote_line_reservation() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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

CREATE FUNCTION public._line_in_scope(p_promotion_id uuid, p_role text, p_variant_id uuid, p_product_id uuid, p_category_ids uuid[]) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
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

CREATE FUNCTION public.cancel_checkout_quote(quote_id uuid, reason text DEFAULT 'checkout cancelled'::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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

CREATE FUNCTION public.cancel_order(order_id uuid, reason text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_order public.orders;
begin
  perform 1 from commerce.checkout_quotes q
  where q.order_id = cancel_order.order_id for update;
  v_order := private.cancel_order(cancel_order.order_id, cancel_order.reason);
  return private.storefront_order_json(v_order);
end;
$$;

CREATE FUNCTION public.create_checkout_quote(items jsonb, idempotency_key text, address jsonb DEFAULT NULL::jsonb, address_id uuid DEFAULT NULL::uuid, shipping_method_id uuid DEFAULT NULL::uuid, discount_code text DEFAULT NULL::text, note text DEFAULT NULL::text, ttl_seconds integer DEFAULT 900) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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

  perform private.assert_checkout_capacity(v_uid);

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
    -- Stabilize pricing without conflicting with inventory-movement FK KEY SHARE locks.
    for no key update of v;
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

CREATE FUNCTION public.create_order(items jsonb, address jsonb DEFAULT NULL::jsonb, address_id uuid DEFAULT NULL::uuid, shipping_method_id uuid DEFAULT NULL::uuid, discount_code text DEFAULT NULL::text, note text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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

CREATE FUNCTION public.create_order_from_quote(quote_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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
  for no key update of v;

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
    discount_code, customer_note, payment_expires_at
  ) values (
    v_uid, (select pr.email from public.profiles pr where pr.id = v_uid),
    v_price ->> 'currency', (v_price ->> 'subtotal')::numeric,
    (v_price ->> 'discount_total')::numeric,
    (v_price ->> 'shipping_total')::numeric,
    (v_price ->> 'tax_total')::numeric,
    (v_price ->> 'total')::numeric,
    v_quote.shipping_address, (v_price ->> 'shipping_method_id')::uuid,
    v_price ->> 'shipping_method_name', v_code_used, v_quote.customer_note, v_quote.expires_at
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

CREATE FUNCTION public.create_order_v2(items jsonb, idempotency_key text, address jsonb DEFAULT NULL::jsonb, address_id uuid DEFAULT NULL::uuid, shipping_method_id uuid DEFAULT NULL::uuid, discount_code text DEFAULT NULL::text, note text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_subject_id uuid := auth.uid();
  v_key text := btrim(idempotency_key);
  v_items jsonb;
  v_address jsonb;
  v_request_hash text;
  v_response jsonb;
  v_record commerce.command_idempotency;
  v_order public.orders;
begin
  if v_subject_id is null then raise exception 'authentication required'; end if;
  if coalesce(v_key, '') = '' or length(v_key) > 200 then
    raise exception 'idempotency_key is required and must be at most 200 characters';
  end if;
  v_items := private.canonical_variant_quantities(items);
  v_address := private.normalize_checkout_address(address);
  v_request_hash := private.command_request_hash(jsonb_build_object(
    'items', v_items, 'address', v_address, 'address_id', address_id,
    'shipping_method_id', shipping_method_id,
    'discount_code', upper(nullif(btrim(discount_code), '')), 'note', note
  ));

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'order.create:' || v_subject_id || ':' || v_key, 0));
  select * into v_record from commerce.command_idempotency c
  where c.scope = 'order.create' and c.subject_id = v_subject_id
    and c.idempotency_key = v_key;
  if found then
    if v_record.request_hash <> v_request_hash then
      raise exception 'idempotency key was used with different order parameters';
    end if;
    select * into v_order from public.orders o
    where o.id = v_record.resource_id and o.customer_id = v_subject_id;
    if not found then raise exception 'idempotency record points to a missing order'; end if;
    return private.storefront_order_json(v_order);
  end if;

  v_response := public.create_order(
    v_items, v_address, address_id, shipping_method_id,
    upper(nullif(btrim(discount_code), '')), note
  );
  insert into commerce.command_idempotency
    (scope, subject_id, idempotency_key, request_hash, resource_type, resource_id)
  values ('order.create', v_subject_id, v_key, v_request_hash,
          'order', (v_response ->> 'id')::uuid);
  return v_response;
end;
$$;

CREATE FUNCTION public.expire_checkout_quotes(max_quotes integer DEFAULT 100, as_of timestamp with time zone DEFAULT now()) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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

-- Separate transaction from Quote expiry: never acquire Quote locks after inventory.
CREATE FUNCTION public.expire_unpaid_orders(max_orders integer DEFAULT 100, as_of timestamptz DEFAULT now()) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare
  v_id uuid;
  v_ids uuid[];
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service role only'; end if;
  if max_orders is null or max_orders not between 1 and 500 then raise exception 'max_orders must be between 1 and 500'; end if;
  if as_of is null then raise exception 'as_of is required'; end if;
  select coalesce(array_agg(locked.id order by locked.payment_expires_at, locked.id), '{}'::uuid[]) into v_ids
  from (select o.id, o.payment_expires_at from public.orders o
    where o.status = 'open' and o.financial_status = 'pending' and o.payment_expires_at <= as_of
      and not exists (select 1 from commerce.checkout_quotes q where q.order_id = o.id)
    order by o.payment_expires_at, o.id for update skip locked limit max_orders) locked;
  -- Prelock the ENTIRE batch, not each order separately (which can reverse variant order).
  perform private.lock_order_inventory(v_ids);
  foreach v_id in array v_ids loop
    -- Late provider success is retained for reconciliation, never settled on a cancelled order.
    perform set_config('commerce.expiring_order', v_id::text, true);
    perform private.cancel_order(v_id, 'order payment window expired');
    perform set_config('commerce.expiring_order', '', true);
  end loop;
  return jsonb_build_object('expired_count', cardinality(v_ids), 'order_ids', to_jsonb(v_ids));
end;
$$;

CREATE FUNCTION public.get_checkout_quote(quote_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
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

CREATE FUNCTION public.get_inventory_availability(variant_id uuid, location_id uuid DEFAULT NULL::uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
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

CREATE FUNCTION public.get_order_checkout_quote(order_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
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

CREATE FUNCTION public.normalize_promotion_code() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.code is not null then
    new.code := upper(new.code);
  end if;
  return new;
end;
$$;

CREATE FUNCTION public.price_checkout(items jsonb, address jsonb DEFAULT NULL::jsonb, shipping_method_id uuid DEFAULT NULL::uuid, discount_code text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  return private.price_checkout(
    price_checkout.items,
    private.normalize_checkout_address(price_checkout.address),
    price_checkout.shipping_method_id,
    price_checkout.discount_code
  );
end;
$$;

CREATE FUNCTION public.update_order_address(order_id uuid, address jsonb DEFAULT NULL::jsonb, address_id uuid DEFAULT NULL::uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_order public.orders;
  v_updated public.orders;
begin
  -- Intent creation takes quote -> order. Do not acquire intent locks after
  -- taking the order lock; settlement takes intent -> quote -> order.
  perform 1 from commerce.checkout_quotes q
  where q.order_id = update_order_address.order_id for update;
  select * into v_order from public.orders o
  where o.id = update_order_address.order_id for update;
  if not found then raise exception 'order not found'; end if;
  if v_order.customer_id is distinct from auth.uid() and not public.is_admin() then
    raise exception 'not allowed';
  end if;
  if v_order.financial_status <> 'pending' then
    raise exception 'paid orders require an order edit adjustment';
  end if;
  if private.order_snapshot_has_payment_intent(v_order.id) then
    raise exception 'payment intent must be cancelled at the provider before editing order';
  end if;
  v_updated := private.update_order_address(
    update_order_address.order_id,
    private.normalize_checkout_address(update_order_address.address),
    update_order_address.address_id
  );
  return private.storefront_order_json(v_updated);
end;
$$;

CREATE FUNCTION public.validate_promotion_params() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare v_key text;
begin
  foreach v_key in array array['percent', 'amount', 'get_percent', 'threshold'] loop
    if (new.params->>v_key)::numeric in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) then
      raise exception 'promotion amount and percentage must be finite';
    end if;
  end loop;
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

commit;
