-- Pricing, order commands and inventory reservations
-- Cross-domain function references are resolved after all definitions are installed.
begin;
set local check_function_bodies = false;

CREATE FUNCTION private.checkout_contact_email(p_customer_id uuid) RETURNS text
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
declare v_email text;
begin
  -- Callers already hold the active Customer lock. Contact is not an Auth
  -- credential; validate shape only and snapshot it when the order is created.
  select btrim(email) into v_email from public.customers where id = p_customer_id and anonymized_at is null;
  if v_email is null or length(v_email) > 320
    or v_email !~ '^[^[:space:]@[:cntrl:]]+@[^[:space:]@[:cntrl:]]+\.[^[:space:]@[:cntrl:]]+$' then
    raise exception using errcode = '22023', message = 'valid customer contact email required for checkout';
  end if;
  return v_email;
end;
$$;

CREATE FUNCTION private.cart_json(p_cart commerce.carts) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $$
  select jsonb_build_object('id', p_cart.id, 'customer_id', p_cart.customer_id, 'status', p_cart.status,
    'version', p_cart.version, 'address', p_cart.address, 'shipping_method_id', p_cart.shipping_method_id,
    'discount_code', p_cart.discount_code, 'note', p_cart.note, 'quote_id', p_cart.quote_id,
    'created_at', p_cart.created_at, 'updated_at', p_cart.updated_at, 'expires_at', p_cart.expires_at,
    'lines', (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'variant_id', l.variant_id,
      'quantity', l.quantity, 'attributes', l.attributes, 'line_key', l.line_key) order by l.variant_id, l.line_key), '[]')
      from commerce.cart_lines l where l.cart_id = p_cart.id));
$$;

CREATE FUNCTION private.access_cart(p_id uuid, p_token text) RETURNS commerce.carts
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare v_cart commerce.carts; v_customer uuid;
begin
  -- All authenticated cart commands serialize customer -> cart, including claim,
  -- quotas and erasure. Guest capabilities never confer customer/order access.
  if auth.uid() is not null then v_customer := private.require_customer(); end if;
  select * into v_cart from commerce.carts where id = p_id for update;
  if not found or v_cart.expires_at <= clock_timestamp() then raise exception 'cart not found'; end if;
  if v_cart.customer_id is not null then
    if v_cart.customer_id is distinct from v_customer then raise exception 'cart not found'; end if;
  else
    if p_token is null or p_token !~ '^[0-9a-f]{64}$' then raise exception 'cart not found'; end if;
    if encode(extensions.digest(p_token, 'sha256'), 'hex') is distinct from v_cart.guest_token_hash then
      raise exception 'cart not found';
    end if;
  end if;
  return v_cart;
end;
$$;

CREATE FUNCTION private.assert_cart_capacity(p_customer uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
begin
  perform private.lock_customer_content(p_customer);
  if (select count(*) from commerce.carts where customer_id = p_customer and status = 'active' and expires_at > clock_timestamp()) >= 5 then
    raise exception 'too many active carts';
  end if;
end;
$$;

CREATE FUNCTION private.guard_cart_write() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare
  v_row jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_cart_id uuid := (v_row ->> case when tg_table_name = 'carts' then 'id' else 'cart_id' end)::uuid;
  v_cart commerce.carts;
begin
  select * into v_cart from commerce.carts where id = v_cart_id for update nowait;
  if not found and tg_op = 'DELETE' then return old; end if; -- parent erasure/expiry cascade
  if current_setting('commerce.cart_write', true) is distinct from v_cart_id::text then
    raise exception 'use cart commands to change cart contents';
  end if;
  if v_cart.status <> 'active' or v_cart.expires_at <= clock_timestamp() then raise exception 'cart is not editable'; end if;
  if tg_op = 'UPDATE' then
    if tg_table_name = 'carts' then
      if (v_row -> 'id', v_row -> 'created_at', v_row -> 'expires_at', v_row -> 'idempotency_key') is distinct from
         (to_jsonb(old) -> 'id', to_jsonb(old) -> 'created_at', to_jsonb(old) -> 'expires_at', to_jsonb(old) -> 'idempotency_key')
        or (v_row ->> 'version')::integer <> (to_jsonb(old) ->> 'version')::integer + 1 then
        raise exception 'cart identity, expiry and version are protected';
      end if;
      if (v_row -> 'customer_id', v_row -> 'guest_token_hash') is distinct from
         (to_jsonb(old) -> 'customer_id', to_jsonb(old) -> 'guest_token_hash') and (
        v_cart.customer_id is null and (v_row ->> 'customer_id')::uuid = public.current_customer_id()
        and v_row -> 'guest_token_hash' = 'null'::jsonb
      ) is not true then raise exception 'cart ownership is immutable except explicit guest claim'; end if;
    elsif (v_row - 'quantity' - 'line_key') is distinct from (to_jsonb(old) - 'quantity' - 'line_key') then
      raise exception 'cart line identity is immutable';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

CREATE FUNCTION private.assert_cart_lines() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare
  v_row jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_id uuid := (v_row ->> case when tg_table_name = 'carts' then 'id' else 'cart_id' end)::uuid;
  v_cart commerce.carts;
  v_count integer;
  v_quantity integer;
begin
  select * into v_cart from commerce.carts where id = v_id;
  if not found then return null; end if;
  select count(*), coalesce(sum(quantity), 0) into v_count, v_quantity from commerce.cart_lines where cart_id = v_id;
  if v_count > 50 or v_quantity > 100 or (v_cart.status = 'abandoned' and v_count <> 0) then
    raise exception 'cart lines exceed limits or do not match cart state';
  end if;
  if v_cart.status = 'converted' and exists (
    select 1 from (select * from commerce.cart_lines where cart_id = v_id) c
    full join (select * from commerce.checkout_quote_lines where quote_id = v_cart.quote_id) q using (line_key)
    where (c.variant_id, c.quantity, c.attributes) is distinct from (q.variant_id, q.quantity, q.attributes)
  ) then raise exception 'cart does not match its checkout quote'; end if;
  return null;
end;
$$;

CREATE FUNCTION public.create_cart(idempotency_key text DEFAULT NULL, ttl_seconds integer DEFAULT 604800) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare v_customer uuid; v_cart commerce.carts; v_token text; v_key text := btrim(idempotency_key);
begin
  if ttl_seconds is null or ttl_seconds not between 60 and 2592000 then raise exception 'cart ttl_seconds must be between 60 and 2592000'; end if;
  if auth.uid() is not null then
    v_customer := private.require_customer();
    if coalesce(v_key, '') = '' or length(v_key) > 200 then raise exception 'idempotency_key is required for a customer cart'; end if;
    select * into v_cart from commerce.carts c where c.customer_id = v_customer and c.idempotency_key = v_key;
    if found then
      if v_cart.expires_at <= clock_timestamp() or v_cart.expires_at - v_cart.created_at <> make_interval(secs => ttl_seconds) then
        raise exception 'cart creation key is expired or was used with different parameters';
      end if;
      return private.cart_json(v_cart);
    end if;
    perform private.assert_cart_capacity(v_customer);
  else
    if idempotency_key is not null then raise exception 'guest cart creation does not accept an idempotency key'; end if;
    v_token := encode(extensions.gen_random_bytes(32), 'hex');
  end if;
  insert into commerce.carts(customer_id, guest_token_hash, idempotency_key, expires_at)
  values (v_customer, case when v_token is not null then encode(extensions.digest(v_token, 'sha256'), 'hex') end,
    v_key, now() + make_interval(secs => ttl_seconds)) returning * into v_cart;
  -- Never persist the plaintext capability or return it from subsequent reads.
  return private.cart_json(v_cart) || case when v_token is not null then jsonb_build_object('guest_token', v_token) else '{}'::jsonb end;
end;
$$;

CREATE FUNCTION public.get_cart(cart_id uuid, guest_token text DEFAULT NULL) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
begin return private.cart_json(private.access_cart(cart_id, guest_token)); end;
$$;

CREATE FUNCTION public.list_carts() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare v_customer uuid := private.require_customer(); v_result jsonb;
begin
  select coalesce(jsonb_agg(private.cart_json(c) order by c.updated_at desc, c.id), '[]') into v_result
  from commerce.carts c where c.customer_id = v_customer and c.status = 'active' and c.expires_at > clock_timestamp();
  return v_result;
end;
$$;

CREATE FUNCTION public.update_cart(cart_id uuid, expected_version integer, items jsonb, address jsonb DEFAULT NULL,
    shipping_method_id uuid DEFAULT NULL, discount_code text DEFAULT NULL, note text DEFAULT NULL, guest_token text DEFAULT NULL) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare
  v_cart commerce.carts := private.access_cart(cart_id, guest_token);
  v_items jsonb;
  v_address jsonb;
  v_hash text;
  v_previous text := current_setting('commerce.cart_write', true);
  v_code text := upper(nullif(btrim(discount_code), ''));
begin
  if items is null or jsonb_typeof(items) <> 'array' then raise exception 'items must be an array'; end if;
  v_items := case when jsonb_array_length(items) = 0 then '[]'::jsonb else private.canonical_checkout_lines(items) end;
  if jsonb_array_length(v_items) > 50 or (select coalesce(sum((e ->> 'quantity')::integer), 0) from jsonb_array_elements(v_items) e) > 100 then
    raise exception 'cart is limited to 50 commercial lines and 100 units';
  end if;
  v_address := private.normalize_checkout_address(address);
  v_hash := private.command_request_hash(jsonb_build_object('operation','update','version',expected_version,
    'items',v_items,'address',v_address,'shipping_method_id',shipping_method_id,'discount_code',v_code,'note',note));
  if v_cart.last_mutation_hash = v_hash then return private.cart_json(v_cart); end if;
  if expected_version is distinct from v_cart.version then raise exception using errcode = 'PT409', message = 'cart version conflict'; end if;
  if v_cart.status <> 'active' then raise exception 'cart is not editable'; end if;
  if exists (select 1 from jsonb_array_elements(v_items) e where not exists (
    select 1 from public.product_variants v join public.products p on p.id = v.product_id
    where v.id = (e ->> 'variant_id')::uuid and v.is_active and p.status = 'active'
  )) then raise exception 'cart variant is not available'; end if;
  if shipping_method_id is not null and not exists (select 1 from public.shipping_methods s where s.id = update_cart.shipping_method_id and s.is_active) then
    raise exception 'shipping method is not available';
  end if;
  perform set_config('commerce.cart_write', v_cart.id::text, true);
  delete from commerce.cart_lines l where l.cart_id = v_cart.id and not exists (
    select 1 from jsonb_array_elements(v_items) e where e ->> 'line_key' = l.line_key);
  insert into commerce.cart_lines(cart_id, variant_id, quantity, attributes)
    select v_cart.id, (e ->> 'variant_id')::uuid, (e ->> 'quantity')::integer, e -> 'attributes' from jsonb_array_elements(v_items) e
    on conflict on constraint cart_lines_cart_id_line_key_key do update set quantity = excluded.quantity;
  update commerce.carts c set address = v_address, shipping_method_id = update_cart.shipping_method_id,
    discount_code = v_code, note = update_cart.note, version = c.version + 1, last_mutation_hash = v_hash, updated_at = now()
    where c.id = v_cart.id returning * into v_cart;
  perform set_config('commerce.cart_write', coalesce(v_previous, ''), true);
  return private.cart_json(v_cart);
end;
$$;

CREATE FUNCTION public.claim_cart(cart_id uuid, expected_version integer, guest_token text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare
  v_customer uuid := private.require_customer();
  v_cart commerce.carts := private.access_cart(cart_id, guest_token);
  v_hash text := private.command_request_hash(jsonb_build_object('operation','claim','version',expected_version,
    'proof', encode(extensions.digest(guest_token, 'sha256'), 'hex')));
  v_previous text := current_setting('commerce.cart_write', true);
begin
  if v_cart.customer_id = v_customer and v_cart.last_mutation_hash = v_hash then return private.cart_json(v_cart); end if;
  if v_cart.customer_id is not null or v_cart.status <> 'active' then raise exception 'cart cannot be claimed'; end if;
  if expected_version is distinct from v_cart.version then raise exception using errcode = 'PT409', message = 'cart version conflict'; end if;
  perform private.assert_cart_capacity(v_customer);
  perform set_config('commerce.cart_write', v_cart.id::text, true);
  update commerce.carts c set customer_id = v_customer, guest_token_hash = null, version = c.version + 1,
    last_mutation_hash = v_hash, updated_at = now() where c.id = v_cart.id returning * into v_cart;
  perform set_config('commerce.cart_write', coalesce(v_previous, ''), true);
  return private.cart_json(v_cart);
end;
$$;

CREATE FUNCTION public.abandon_cart(cart_id uuid, expected_version integer, guest_token text DEFAULT NULL) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare
  v_cart commerce.carts := private.access_cart(cart_id, guest_token);
  v_hash text := private.command_request_hash(jsonb_build_object('operation','abandon','version',expected_version));
  v_previous text := current_setting('commerce.cart_write', true);
begin
  if v_cart.last_mutation_hash = v_hash then return private.cart_json(v_cart); end if;
  if expected_version is distinct from v_cart.version then raise exception using errcode = 'PT409', message = 'cart version conflict'; end if;
  if v_cart.status <> 'active' then raise exception 'cart is not editable'; end if;
  perform set_config('commerce.cart_write', v_cart.id::text, true);
  delete from commerce.cart_lines l where l.cart_id = v_cart.id;
  update commerce.carts c set status = 'abandoned', address = null, note = null, version = c.version + 1,
    last_mutation_hash = v_hash, updated_at = now() where c.id = v_cart.id returning * into v_cart;
  perform set_config('commerce.cart_write', coalesce(v_previous, ''), true);
  return private.cart_json(v_cart);
end;
$$;

CREATE FUNCTION public.preview_cart(cart_id uuid, guest_token text DEFAULT NULL) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare v_cart commerce.carts := private.access_cart(cart_id, guest_token); v_items jsonb; v_price jsonb;
begin
  if v_cart.status <> 'active' then raise exception 'cart is not editable'; end if;
  select jsonb_agg(jsonb_build_object('variant_id',variant_id,'quantity',quantity,'attributes',attributes)) into v_items
    from commerce.cart_lines l where l.cart_id = v_cart.id;
  if v_items is not null then v_price := public.price_checkout(v_items, v_cart.address, v_cart.shipping_method_id, v_cart.discount_code); end if;
  return jsonb_build_object('cart_id', v_cart.id, 'version', v_cart.version, 'pricing', v_price);
end;
$$;

CREATE FUNCTION public.checkout_cart(cart_id uuid, expected_version integer) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare
  v_customer uuid := private.require_customer();
  v_cart commerce.carts := private.access_cart(cart_id, null);
  v_items jsonb;
  v_quote jsonb;
  v_hash text := private.command_request_hash(jsonb_build_object('operation','checkout','version',expected_version));
  v_previous text := current_setting('commerce.cart_write', true);
begin
  if v_cart.last_mutation_hash = v_hash and v_cart.status = 'converted' then return public.get_checkout_quote(v_cart.quote_id); end if;
  if expected_version is distinct from v_cart.version then raise exception using errcode = 'PT409', message = 'cart version conflict'; end if;
  if v_cart.customer_id is distinct from v_customer or v_cart.status <> 'active' then raise exception 'cart is not editable'; end if;
  select jsonb_agg(jsonb_build_object('variant_id',variant_id,'quantity',quantity,'attributes',attributes)) into v_items
    from commerce.cart_lines l where l.cart_id = v_cart.id;
  v_quote := public.create_checkout_quote(v_items, 'cart:' || v_cart.id || ':' || v_cart.version,
    address => v_cart.address, shipping_method_id => v_cart.shipping_method_id, discount_code => v_cart.discount_code, note => v_cart.note);
  perform set_config('commerce.cart_write', v_cart.id::text, true);
  update commerce.carts c set status = 'converted', quote_id = (v_quote ->> 'id')::uuid, address = null, note = null,
    version = c.version + 1, last_mutation_hash = v_hash, updated_at = now() where c.id = v_cart.id;
  perform set_config('commerce.cart_write', coalesce(v_previous, ''), true);
  return v_quote;
end;
$$;

CREATE FUNCTION public.purge_expired_carts(max_carts integer DEFAULT 100, as_of timestamptz DEFAULT now()) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare v_count integer;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service role only'; end if;
  if max_carts is null or max_carts not between 1 and 500 or as_of is null then raise exception 'invalid cart cleanup bounds'; end if;
  delete from commerce.carts c where c.id in (select id from commerce.carts where expires_at <= as_of order by expires_at, id for update skip locked limit max_carts);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

CREATE FUNCTION private.assert_checkout_capacity(p_customer_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
begin
  perform private.lock_customer_content(p_customer_id);
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
  if (new.id, new.order_number) is distinct from (old.id, old.order_number) then
    raise exception 'order identity and number are immutable';
  end if;
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
  select coalesce(sum(r.quantity), 0)::integer
  from commerce.inventory_reservations r
  where r.variant_id = p_variant_id
    and r.location_id = p_location_id
    and r.expires_at > now()
    and (p_exclude_quote_id is null or r.quote_id <> p_exclude_quote_id);
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
  perform private.assert_pricing_breakdown(private.checkout_quote_json(v_quote));
  return coalesce(new, old);
end;
$$;

CREATE FUNCTION private.cancel_order(order_id uuid, reason text DEFAULT NULL::text) RETURNS public.orders
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_order public.orders;
begin
  select * into v_order
  from public.orders o
  where o.id = cancel_order.order_id
  for update;

  if not found then
    raise exception 'order not found';
  end if;
  if v_order.customer_id is distinct from public.current_customer_id() and not public.is_admin()
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

  -- Unpaid orders have only a Quote reservation; the status trigger releases it.
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

CREATE FUNCTION private.canonical_checkout_lines(p_items jsonb) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $$
declare
  v_item jsonb;
  v_attributes jsonb;
  v_key text;
  v_result jsonb;
begin
  -- Keep the inventory quantity validator separate from commercial line identity.
  perform private.canonical_variant_quantities(p_items);
  for v_item in select value from jsonb_array_elements(p_items) loop
    if v_item - array['variant_id', 'quantity', 'attributes', 'line_key'] <> '{}'::jsonb then
      raise exception 'unsupported checkout line field';
    end if;
    v_attributes := coalesce(v_item -> 'attributes', '{}'::jsonb);
    if not private.valid_line_attributes(v_attributes) then
      raise exception 'attributes must be a text object: at most 20 keys, 64-character keys, 500-character values and 8192 bytes';
    end if;
    v_key := private.checkout_line_key((v_item ->> 'variant_id')::uuid, v_attributes);
    if v_item ? 'line_key' and v_item ->> 'line_key' is distinct from v_key then
      raise exception 'line_key does not match variant and attributes';
    end if;
  end loop;
  select jsonb_agg(jsonb_build_object(
    'variant_id', x.variant_id, 'attributes', x.attributes,
    'line_key', private.checkout_line_key(x.variant_id, x.attributes), 'quantity', x.quantity
  ) order by x.variant_id, private.checkout_line_key(x.variant_id, x.attributes))
  into v_result from (
    select (e ->> 'variant_id')::uuid variant_id,
           coalesce(e -> 'attributes', '{}'::jsonb) attributes,
           sum((e ->> 'quantity')::integer)::integer quantity
    from jsonb_array_elements(p_items) e
    group by (e ->> 'variant_id')::uuid, coalesce(e -> 'attributes', '{}'::jsonb)
  ) x;
  return v_result;
end;
$$;

CREATE FUNCTION private.allocate_price_discount(p_amount numeric, p_variant_id uuid DEFAULT NULL) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  v_base numeric;
  v_allocated numeric;
  v_share record;
begin
  if p_amount <= 0 then return; end if;
  select sum(unit_price * quantity - discount_total) into v_base from _price_lines
  where p_variant_id is null or variant_id = p_variant_id;
  if v_base is null or p_amount > v_base or p_amount <> round(p_amount, 2) then
    raise exception 'discount exceeds line capacity';
  end if;
  -- First allocate across variants, then across their commercial lines. This
  -- preserves SKU-level benefits when a customer changes/splits text attributes.
  if p_variant_id is null then
    for v_share in
      with weights as (
        select variant_id, sum(unit_price * quantity - discount_total) * 100 capacity
        from _price_lines group by variant_id
      ), shares as (
        select variant_id, div(p_amount * 100 * capacity, v_base * 100) floor_share,
               mod(p_amount * 100 * capacity, v_base * 100) remainder from weights
      ) select variant_id, floor_share + case when row_number() over (order by remainder desc, variant_id)
        <= p_amount * 100 - sum(floor_share) over () then 1 else 0 end minor_share from shares
    loop
      perform private.allocate_price_discount(v_share.minor_share / 100, v_share.variant_id);
    end loop;
    return;
  end if;
  -- Exact integer cents within a variant; canonical line_key order breaks ties.
  with weights as (
    select idx, (unit_price * quantity - discount_total) * 100 capacity from _price_lines
    where p_variant_id is null or variant_id = p_variant_id
  ), shares as (
    select idx, div(p_amount * 100 * capacity, v_base * 100) floor_share,
           mod(p_amount * 100 * capacity, v_base * 100) remainder from weights
  ), allocation as (
    select idx, floor_share + case when row_number() over (order by remainder desc, idx)
      <= p_amount * 100 - sum(floor_share) over () then 1 else 0 end minor_share from shares
  ), applied as (
    update _price_lines l set discount_total = l.discount_total + a.minor_share / 100
    from allocation a where a.idx = l.idx returning a.minor_share
  ) select coalesce(sum(minor_share), 0) / 100 into v_allocated from applied;
  if v_allocated <> p_amount then raise exception 'discount allocation does not match its target'; end if;
end;
$$;

CREATE FUNCTION private.calculate_checkout_tax(p_lines jsonb, p_shipping jsonb, p_country text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
declare
  v_rule public.tax_rates;
  v_common jsonb;
  v_allocations jsonb;
  v_total numeric := 0;
  v_lines jsonb;
  v_shipping jsonb := p_shipping;
begin
  select * into v_rule from public.tax_rates
  where p_country is not null and is_active and country in (p_country, '*')
  order by (country = '*'), id limit 1;
  v_common := jsonb_build_object('tax_rate_id', v_rule.id, 'name', v_rule.name,
    'country', v_rule.country, 'rate', v_rule.rate);
  if v_rule.id is not null then
    with bases as (
      select 'item:' || (e ->> 'line_key') key,
        'item:' || coalesce(e ->> 'variant_id', e ->> 'id', e ->> 'line_key') bucket,
        (e ->> 'line_total')::numeric base from jsonb_array_elements(p_lines) e
      union all select 'shipping', 'shipping', (p_shipping ->> 'total')::numeric
      where p_shipping is not null and v_rule.include_shipping
    ), grouped as (
      select bucket, sum(base) base from bases group by bucket
    ), group_shares as (
      select bucket, floor(base * v_rule.rate * 100) floor_share,
        mod(base * v_rule.rate * 100, 1) remainder,
        round(sum(base) over () * v_rule.rate * 100) target from grouped
    ), group_amounts as (
      select bucket, floor_share + case when row_number() over (order by remainder desc, bucket collate "C")
        <= target - sum(floor_share) over () then 1 else 0 end target from group_shares
    ), shares as (
      select b.key, b.bucket, g.target, floor(b.base * v_rule.rate * 100) floor_share,
        mod(b.base * v_rule.rate * 100, 1) remainder from bases b join group_amounts g using (bucket)
    ), allocated as (
      select key, (floor_share + case when row_number() over (partition by bucket order by remainder desc, key collate "C")
        <= target - sum(floor_share) over (partition by bucket) then 1 else 0 end) / 100 amount from shares
    ) select coalesce(jsonb_object_agg(key, amount), '{}'), coalesce(sum(amount), 0)
      into v_allocations, v_total from allocated;
  end if;
  select jsonb_agg(e || jsonb_build_object('tax_lines', case when v_rule.id is null then '[]'::jsonb
    else jsonb_build_array(v_common || jsonb_build_object('taxable_amount', (e ->> 'line_total')::numeric,
      'amount', (v_allocations ->> ('item:' || (e ->> 'line_key')))::numeric)) end) order by ord)
  into v_lines from jsonb_array_elements(p_lines) with ordinality x(e, ord);
  if p_shipping is not null then
    v_shipping := p_shipping || jsonb_build_object('tax_lines',
      case when v_rule.id is null or not v_rule.include_shipping then '[]'::jsonb
      else jsonb_build_array(v_common || jsonb_build_object('taxable_amount', (p_shipping ->> 'total')::numeric,
        'amount', (v_allocations ->> 'shipping')::numeric)) end);
  end if;
  return jsonb_build_object('lines', v_lines, 'shipping_line', v_shipping, 'tax_total', v_total,
    'tax_context', jsonb_build_object('method', 'country_rate_variant_line_v1', 'status', case when p_country is null then 'not_calculated'
      when v_rule.id is null then 'no_rule' else 'calculated' end, 'destination_country', p_country,
      'rule', case when v_rule.id is not null then v_common || jsonb_build_object('include_shipping', v_rule.include_shipping) end));
end;
$$;

CREATE FUNCTION private.assert_pricing_breakdown(p_price jsonb) RETURNS void
    LANGUAGE plpgsql STABLE SET search_path TO '' AS $$
declare
  v_target jsonb;
  v_alloc jsonb;
  v_tax jsonb;
  v_promo jsonb;
  v_sum numeric;
  v_tax_sum numeric := 0;
  v_allocations jsonb := '[]'::jsonb;
  v_shipping jsonb := nullif(p_price -> 'shipping_line', 'null'::jsonb);
  v_context jsonb := p_price -> 'tax_context';
  v_rule jsonb := v_context -> 'rule';
  v_is_shipping boolean;
  v_expected_count integer;
begin
  if private.valid_tax_context(v_context) is distinct from true then raise exception 'invalid tax calculation context'; end if;
  if (v_shipping ->> 'shipping_method_id', v_shipping ->> 'name') is distinct from
     (p_price ->> 'shipping_method_id', p_price ->> 'shipping_method_name') then
    raise exception 'shipping identity does not match header';
  end if;
  if coalesce((v_shipping ->> 'total')::numeric, 0) <> (p_price ->> 'shipping_total')::numeric then
    raise exception 'shipping details do not match header';
  end if;
  if v_shipping is not null and (
    not (v_shipping ?& array['shipping_method_id','name','gross_amount','discount_total','threshold_discount','total','policy','tax_lines','discount_allocations'])
    or jsonb_typeof(v_shipping -> 'policy') is distinct from 'object'
    or jsonb_typeof(v_shipping -> 'gross_amount') is distinct from 'number'
    or jsonb_typeof(v_shipping -> 'discount_total') is distinct from 'number'
    or jsonb_typeof(v_shipping -> 'threshold_discount') is distinct from 'number'
    or jsonb_typeof(v_shipping -> 'total') is distinct from 'number'
    or (v_shipping ->> 'gross_amount')::numeric - (v_shipping ->> 'discount_total')::numeric <> (v_shipping ->> 'total')::numeric
    or (v_shipping ->> 'threshold_discount')::numeric not between 0 and (v_shipping ->> 'discount_total')::numeric
    or (v_shipping ->> 'total')::numeric < 0
  ) then raise exception 'invalid shipping breakdown'; end if;
  for v_target, v_is_shipping in
    select e, false from jsonb_array_elements(p_price -> 'lines') e
    union all select v_shipping, true where v_shipping is not null
  loop
    if jsonb_typeof(v_target -> 'tax_lines') is distinct from 'array'
      or jsonb_typeof(v_target -> 'discount_allocations') is distinct from 'array' then
      raise exception 'pricing target requires tax and discount arrays';
    end if;
    select coalesce(sum((e ->> 'amount')::numeric), 0) into v_sum
      from jsonb_array_elements(v_target -> 'discount_allocations') e;
    if v_sum + (case when v_is_shipping then (v_target ->> 'threshold_discount')::numeric else 0 end)
       is distinct from (v_target ->> 'discount_total')::numeric then
      raise exception 'discount allocations do not match target';
    end if;
    for v_alloc in select value from jsonb_array_elements(v_target -> 'discount_allocations') loop
      if jsonb_typeof(v_alloc -> 'amount') is distinct from 'number' or (v_alloc ->> 'amount')::numeric <= 0 then
        raise exception 'discount allocation must be positive money';
      end if;
      if v_alloc ->> 'promotion_id' is not null and not exists (
        select 1 from jsonb_array_elements(p_price -> 'promotions') p where p ->> 'promotion_id' = v_alloc ->> 'promotion_id'
      ) then raise exception 'discount allocation has no application'; end if;
    end loop;
    v_allocations := v_allocations || (v_target -> 'discount_allocations');
    v_expected_count := case when v_context ->> 'status' = 'calculated'
      and (not v_is_shipping or (v_rule ->> 'include_shipping')::boolean) then 1 else 0 end;
    if jsonb_array_length(v_target -> 'tax_lines') is distinct from v_expected_count then
      raise exception 'tax calculation is missing target details';
    end if;
    for v_tax in select value from jsonb_array_elements(v_target -> 'tax_lines') loop
      if (v_tax -> 'tax_rate_id', v_tax -> 'name', v_tax -> 'country', v_tax -> 'rate') is distinct from
         (v_rule -> 'tax_rate_id', v_rule -> 'name', v_rule -> 'country', v_rule -> 'rate')
         or (v_tax ->> 'taxable_amount')::numeric is distinct from
            (v_target ->> case when v_is_shipping then 'total' else 'line_total' end)::numeric
         or jsonb_typeof(v_tax -> 'rate') is distinct from 'number'
         or jsonb_typeof(v_tax -> 'amount') is distinct from 'number'
         or (v_tax ->> 'rate')::numeric not between 0 and 1
         or (v_tax ->> 'amount')::numeric not between
            floor((v_tax ->> 'taxable_amount')::numeric * (v_tax ->> 'rate')::numeric * 100) / 100
            and ceil((v_tax ->> 'taxable_amount')::numeric * (v_tax ->> 'rate')::numeric * 100) / 100 then
        raise exception 'tax detail does not match calculation basis';
      end if;
      v_tax_sum := v_tax_sum + (v_tax ->> 'amount')::numeric;
    end loop;
  end loop;
  for v_promo in select value from jsonb_array_elements(p_price -> 'promotions') loop
    select coalesce(sum((e ->> 'amount')::numeric), 0) into v_sum from jsonb_array_elements(v_allocations) e
    where e ->> 'promotion_id' = v_promo ->> 'promotion_id';
    if v_sum is distinct from (v_promo ->> 'amount')::numeric then
      raise exception 'discount application does not match allocations';
    end if;
  end loop;
  if v_tax_sum is distinct from (p_price ->> 'tax_total')::numeric then raise exception 'tax details do not match header'; end if;
  if v_context ->> 'status' = 'calculated' and v_tax_sum <> round((
      (p_price ->> 'subtotal')::numeric - (p_price ->> 'discount_total')::numeric
      + case when (v_rule ->> 'include_shipping')::boolean then (p_price ->> 'shipping_total')::numeric else 0 end
    ) * (v_rule ->> 'rate')::numeric, 2) then raise exception 'tax header does not match rule'; end if;
end;
$$;

CREATE FUNCTION private.order_pricing_json(p_order_id uuid) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $$
  select jsonb_build_object('order_id', o.id, 'currency', o.currency, 'subtotal', o.subtotal,
    'discount_total', o.discount_total, 'shipping_total', o.shipping_total, 'tax_total', o.tax_total,
    'total', o.total, 'tax_context', o.tax_context, 'shipping_method_id', o.shipping_method_id, 'shipping_method_name', o.shipping_method_name,
    'lines', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'line_key', i.line_key,
      'variant_id', i.variant_id, 'product_id', i.product_id, 'name', i.name, 'sku', i.sku,
      'variant_title', i.variant_title, 'options', i.options, 'attributes', i.attributes,
      'unit_price', i.unit_price, 'quantity', i.quantity, 'total', i.total,
      'discount_total', i.discount_total, 'line_total', i.line_total,
      'discount_allocations', (select coalesce(jsonb_agg(jsonb_build_object('promotion_id', a.promotion_id,
        'label', a.label, 'amount', a.amount) order by a.promotion_id), '[]') from commerce.order_discount_allocations a where a.order_id = o.id and a.order_item_id = i.id),
      'tax_lines', (select coalesce(jsonb_agg(to_jsonb(t) - array['order_id','order_item_id','shipping_line_id'] order by t.tax_rate_id), '[]')
        from commerce.order_tax_lines t where t.order_id = o.id and t.order_item_id = i.id)
      ) order by i.variant_id, i.line_key), '[]') from public.order_items i where i.order_id = o.id),
    'shipping_line', (select to_jsonb(s) - 'order_id' || jsonb_build_object(
      'discount_allocations', (select coalesce(jsonb_agg(jsonb_build_object('promotion_id', a.promotion_id, 'label', a.label, 'amount', a.amount) order by a.promotion_id), '[]')
        from commerce.order_discount_allocations a where a.order_id = o.id and a.shipping_line_id = s.id),
      'tax_lines', (select coalesce(jsonb_agg(to_jsonb(t) - array['order_id','order_item_id','shipping_line_id'] order by t.tax_rate_id), '[]')
        from commerce.order_tax_lines t where t.order_id = o.id and t.shipping_line_id = s.id)) from commerce.order_shipping_lines s where s.order_id = o.id),
    'promotions', (select coalesce(jsonb_agg(jsonb_build_object('promotion_id', p.promotion_id, 'name', p.name,
      'code', p.code, 'amount', p.amount, 'snapshot', p.snapshot) order by (p.snapshot ->> 'application_index')::integer, p.promotion_id), '[]') from public.order_promotions p where p.order_id = o.id)
  ) from public.orders o where o.id = p_order_id;
$$;

CREATE FUNCTION private.store_order_tax_lines(p_order_id uuid, p_order_item_id uuid, p_shipping_line_id uuid, p_taxes jsonb) RETURNS void
    LANGUAGE sql SECURITY DEFINER SET search_path TO '' AS $$
  insert into commerce.order_tax_lines(order_id, order_item_id, shipping_line_id, tax_rate_id, name, country, rate, taxable_amount, amount)
  select p_order_id, p_order_item_id, p_shipping_line_id, (e ->> 'tax_rate_id')::uuid, e ->> 'name', e ->> 'country',
    (e ->> 'rate')::numeric, (e ->> 'taxable_amount')::numeric, (e ->> 'amount')::numeric from jsonb_array_elements(p_taxes) e;
$$;

CREATE FUNCTION private.store_order_pricing(p_order_id uuid, p_price jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare v_line jsonb; v_item_id uuid; v_shipping_id uuid; v_shipping jsonb := nullif(p_price -> 'shipping_line', 'null'::jsonb);
begin
  perform private.assert_pricing_breakdown(p_price);
  if v_shipping is not null then
    insert into commerce.order_shipping_lines(order_id, shipping_method_id, name, gross_amount, discount_total, threshold_discount, policy)
    values (p_order_id, (v_shipping ->> 'shipping_method_id')::uuid, v_shipping ->> 'name',
      (v_shipping ->> 'gross_amount')::numeric, (v_shipping ->> 'discount_total')::numeric,
      (v_shipping ->> 'threshold_discount')::numeric, v_shipping -> 'policy') returning id into v_shipping_id;
    insert into commerce.order_discount_allocations(order_id, shipping_line_id, promotion_id, label, amount)
    select p_order_id, v_shipping_id, (e ->> 'promotion_id')::uuid, e ->> 'label', (e ->> 'amount')::numeric
      from jsonb_array_elements(v_shipping -> 'discount_allocations') e;
    perform private.store_order_tax_lines(p_order_id, null, v_shipping_id, v_shipping -> 'tax_lines');
  end if;
  for v_line in select value from jsonb_array_elements(p_price -> 'lines') loop
    select id into strict v_item_id from public.order_items where order_id = p_order_id and line_key = v_line ->> 'line_key';
    insert into commerce.order_discount_allocations(order_id, order_item_id, promotion_id, label, amount)
    select p_order_id, v_item_id, (e ->> 'promotion_id')::uuid, e ->> 'label', (e ->> 'amount')::numeric
      from jsonb_array_elements(v_line -> 'discount_allocations') e;
    perform private.store_order_tax_lines(p_order_id, v_item_id, null, v_line -> 'tax_lines');
  end loop;
end;
$$;

CREATE FUNCTION public.get_order_pricing(order_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
begin
  if not exists (select 1 from public.orders o where o.id = get_order_pricing.order_id
    and (o.customer_id = public.current_customer_id() or public.is_admin() or auth.role() = 'service_role')) then
    raise exception 'order not found';
  end if;
  return private.order_pricing_json(order_id);
end;
$$;

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
    'shipping_line', p_price -> 'shipping_line', 'tax_context', p_price -> 'tax_context',
    'lines', (
      select coalesce(jsonb_agg(e.value order by e.value ->> 'variant_id', e.value ->> 'line_key'), '[]'::jsonb)
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
    'tax_context', p_quote.tax_context, 'shipping_line', p_quote.shipping_line,
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
        'id', ql.id,
        'line_key', ql.line_key,
        'attributes', ql.attributes,
        'tax_lines', ql.tax_lines, 'discount_allocations', ql.discount_allocations,
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
      ) order by ql.variant_id, ql.line_key), '[]'::jsonb)
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
    select 1 from (select * from commerce.checkout_quote_lines where quote_id = v_quote.id) q
    full join (select * from public.order_items where order_id = p_order_id) o using (id)
    where q.id is null or o.id is null
       or (q.variant_id, q.product_id, q.attributes, q.line_key, q.quantity,
           q.sku, q.name, q.variant_title, q.options, q.unit_price, q.total, q.discount_total)
          is distinct from
          (o.variant_id, o.product_id, o.attributes, o.line_key, o.quantity,
           o.sku, o.name, o.variant_title, o.options, o.unit_price, o.total, o.discount_total)
  ) then
    raise exception 'quoted order items do not match reservation';
  end if;

  -- 先在本事务内移出 active 集合；后续失败会整体回滚。
  update commerce.checkout_quotes set status = 'completed'
  where id = v_quote.id returning * into v_quote;

  for v_line in
    select ql.variant_id, ql.location_id, sum(ql.quantity)::integer quantity
    from commerce.checkout_quote_lines ql
    where ql.quote_id = v_quote.id and ql.track_inventory
    group by ql.variant_id, ql.location_id
    order by ql.variant_id, ql.location_id
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
  v_tax jsonb;
  v_shipping_json jsonb;
  v_shipping_discounts jsonb := '[]'::jsonb;
  v_snapshot jsonb;
  v_fs_snapshot jsonb;
  v_deferred_snapshot jsonb;
  v_threshold_discount numeric := 0;
  v_shipping public.shipping_methods;
  v_promo public.promotions;
  v_candidate record;
  v_code_found boolean := false;
  v_applied integer := 0;
  v_has_exclusive boolean := false;
  v_scope_qty integer;
  v_min_qty integer;
  v_pct numeric;
  v_amount numeric(12, 2);
  v_base numeric(12, 2);
  v_room numeric(12, 2);
  v_unit_disc numeric(12, 2);
  v_buy integer;
  v_get integer;
  v_get_pct numeric;
  v_free integer;
  v_get_qty integer;
  v_get_only_qty integer;
  v_rounds integer;
  v_overlap_budget integer;
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
  items := private.canonical_checkout_lines(items);
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
    line_key text,
    attributes jsonb,
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
    discount_before numeric(12, 2) not null default 0,
    discount_allocations jsonb not null default '[]',
    check (discount_total between 0 and unit_price * quantity)
  ) on commit drop;
  if exists (select 1 from pg_catalog.pg_class
             where relname = '_price_promos' and relpersistence = 't'
               and pg_catalog.pg_table_is_visible(oid)) then
    drop table _price_promos;
  end if;
  create temporary table _price_promos (
    idx serial primary key, promotion_id uuid, name text, code text, amount numeric(12, 2), stackable boolean, snapshot jsonb
  ) on commit drop;

  -- Canonical commercial lines: identical attributes merge; distinct ones survive.
  for v_item in select value from jsonb_array_elements(items)
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
    insert into _price_lines (line_key, attributes, variant_id, product_id, sku, name, variant_title, options,
                              quantity, unit_price, category_ids, track_inventory)
    values (v_item ->> 'line_key', v_item -> 'attributes', v_variant.id, v_variant.product_id, v_variant.sku,
            v_variant.product_name, v_variant_title, v_options, (v_item ->> 'quantity')::int,
            v_variant.price, v_cat_ids, v_variant.track_inventory);
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

  -- Rule, scope and targets must come from ONE MVCC snapshot. Reading targets
  -- in a later statement could combine an old all-scope with new selected rows.
  for v_candidate in
    select p as promotion,
      (select coalesce(jsonb_agg(jsonb_build_object('role', t.role, 'product_id', t.product_id,
        'variant_id', t.variant_id, 'category_id', t.category_id) order by t.id), '[]')
       from public.promotion_targets t where t.promotion_id = p.id) as targets
    from public.promotions p
    where p.is_active
      and (p.type <> 'free_shipping' or v_shipping.price > 0)
      and (p.starts_at is null or now() >= p.starts_at)
      and (p.ends_at is null or now() <= p.ends_at)
      and (p.usage_limit is null or p.used_count < p.usage_limit)
      and (p.code is null or p.code = upper(coalesce(discount_code, '')))
    order by p.priority, p.created_at, (p.code is null), p.code, p.name, p.id
  loop
    v_promo := v_candidate.promotion;
    if v_promo.code is not null then v_code_found := true; end if;
    if v_applied > 0 and (v_has_exclusive or not v_promo.stackable) then continue; end if;
    if v_promo.code is not null then
      if auth.uid() is not null and (
        select count(*) from public.discount_redemptions dr
        join public.orders o on o.id = dr.order_id
        where dr.promotion_id = v_promo.id and dr.customer_id = public.current_customer_id() and o.status <> 'cancelled'
      ) >= v_promo.per_customer_limit then
        raise exception 'discount code already used';
      end if;
      if v_promo.type in ('order_percentage', 'order_fixed') then
        if v_subtotal < coalesce((v_promo.params ->> 'threshold')::numeric, 0) then
          raise exception 'discount minimum subtotal not met';
        end if;
      end if;
    end if;
    v_snapshot := jsonb_build_object('type', v_promo.type, 'params', v_promo.params,
      'priority', v_promo.priority, 'stackable', v_promo.stackable,
      'apply_scope', v_promo.apply_scope, 'get_scope', v_promo.get_scope,
      'starts_at_epoch', extract(epoch from v_promo.starts_at), 'ends_at_epoch', extract(epoch from v_promo.ends_at),
      'targets', v_candidate.targets);
    update _price_lines set discount_before = discount_total where idx > 0;
    v_amount := 0;
    case v_promo.type
    when 'item_percentage' then
      v_pct := (v_promo.params ->> 'percent')::numeric;
      v_min_qty := coalesce((v_promo.params ->> 'min_quantity')::int, 0);
      select coalesce(sum(l.quantity), 0) into v_scope_qty from _price_lines l
      where private.line_in_scope(v_snapshot, 'apply', l.variant_id, l.product_id, l.category_ids);
      if v_scope_qty > 0 and v_scope_qty >= v_min_qty then
        for v_line in
          select l.variant_id, sum(l.unit_price * l.quantity) gross,
                 sum(l.unit_price * l.quantity - l.discount_total) room
          from _price_lines l
          where private.line_in_scope(v_snapshot, 'apply', l.variant_id, l.product_id, l.category_ids)
          group by l.variant_id order by l.variant_id
        loop
          -- Customer-controlled text must not multiply percentage-rounding benefits.
          v_disc := least(round(v_line.gross * v_pct / 100, 2), v_line.room);
          perform private.allocate_price_discount(v_disc, v_line.variant_id);
          v_amount := v_amount + v_disc;
        end loop;
      end if;
    when 'buy_x_get_y' then
      v_buy := (v_promo.params ->> 'buy')::int;
      v_get := (v_promo.params ->> 'get')::int;
      v_get_pct := coalesce((v_promo.params ->> 'get_percent')::numeric, 100);
      select coalesce(sum(l.quantity), 0) into v_scope_qty from _price_lines l
      where private.line_in_scope(v_snapshot, 'apply', l.variant_id, l.product_id, l.category_ids);
      v_get_role := case when v_snapshot ->> 'get_scope' = 'selected' then 'get' else 'apply' end;
      if v_get_role = 'get' then
        select coalesce(sum(l.quantity), 0), coalesce(sum(l.quantity) filter (
          where not private.line_in_scope(v_snapshot, 'apply', l.variant_id, l.product_id, l.category_ids)), 0)
        into v_get_qty, v_get_only_qty from _price_lines l
        where private.line_in_scope(v_snapshot, 'get', l.variant_id, l.product_id, l.category_ids);
        -- Reserve distinct purchase units before choosing the cheapest gifts.
        -- Cart quantities bound this search to at most 100 rounds. A selected
        -- scope can overlap through products/categories, not only target IDs.
        v_rounds := v_scope_qty / v_buy;
        loop
          v_free := least(v_rounds * v_get, v_get_qty);
          exit when v_rounds * v_buy + greatest(0, v_free - v_get_only_qty) <= v_scope_qty;
          v_rounds := v_rounds - 1;
        end loop;
        v_overlap_budget := v_scope_qty - ((v_free + v_get - 1) / v_get) * v_buy;
      else
        v_free := (floor(v_scope_qty / (v_buy + v_get)))::int * v_get;
        v_overlap_budget := v_free;
      end if;
      for v_line in
        select l.variant_id, l.unit_price, sum(l.quantity)::integer quantity, sum(l.discount_total) discount_total,
          bool_or(private.line_in_scope(v_snapshot, 'apply', l.variant_id, l.product_id, l.category_ids)) overlaps_apply
        from _price_lines l
        where private.line_in_scope(v_snapshot, v_get_role, l.variant_id, l.product_id, l.category_ids)
        group by l.variant_id, l.unit_price
        order by l.unit_price, l.variant_id
      loop
        exit when v_free <= 0;
        v_room := v_line.unit_price * v_line.quantity - v_line.discount_total;
        v_unit_disc := round(v_line.unit_price * v_get_pct / 100, 2);
        if v_unit_disc > 0 and v_room > 0 then
          v_take := least(v_free, v_line.quantity, floor(v_room / v_unit_disc)::int);
          if v_line.overlaps_apply then v_take := least(v_take, v_overlap_budget); end if;
          if v_take > 0 then
            v_disc := v_take * v_unit_disc;
            perform private.allocate_price_discount(v_disc, v_line.variant_id);
            v_amount := v_amount + v_disc;
            v_free := v_free - v_take;
            if v_line.overlaps_apply then v_overlap_budget := v_overlap_budget - v_take; end if;
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
          if v_deferred_fs.id is not null then v_fs := v_deferred_fs; v_fs_snapshot := v_deferred_snapshot;
          else v_fs := v_promo; v_fs_snapshot := v_snapshot; end if;
          v_applied := v_applied + 1;
          if not v_fs.stackable then v_has_exclusive := true; end if;
        elsif v_promo.stackable and v_deferred_fs.id is null then
          v_deferred_fs := v_promo; v_deferred_snapshot := v_snapshot;
        end if;
        -- Zero-benefit exclusive shipping never acquires the exclusivity flag.
      end if;
    end case;

    if v_amount > 0 then
      if v_promo.type in ('order_percentage', 'order_fixed') then
        perform private.allocate_price_discount(v_amount);
      end if;
      update _price_lines set discount_allocations = discount_allocations || jsonb_build_array(
        jsonb_build_object('promotion_id', v_promo.id, 'label', v_promo.name, 'amount', discount_total - discount_before))
      where discount_total > discount_before;
      insert into _price_promos (promotion_id, name, code, amount, stackable, snapshot) values (v_promo.id, v_promo.name, v_promo.code, v_amount, v_promo.stackable, v_snapshot);
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
    v_threshold_discount := v_shipping_total;
    v_shipping_total := 0;
  end if;
  if v_fs.id is null and v_shipping_total > 0 and not v_has_exclusive and v_deferred_fs.id is not null then
    v_fs := v_deferred_fs; v_fs_snapshot := v_deferred_snapshot;
  end if;
  if v_fs.id is not null and v_shipping_total > 0 then
    v_shipping_discounts := jsonb_build_array(jsonb_build_object('promotion_id', v_fs.id, 'label', v_fs.name, 'amount', v_shipping_total));
    insert into _price_promos (promotion_id, name, code, amount, stackable, snapshot) values (v_fs.id, v_fs.name, v_fs.code, v_shipping_total, v_fs.stackable, v_fs_snapshot);
    v_shipping_total := 0;
  end if;

  select jsonb_agg(jsonb_build_object(
           'line_key', line_key, 'attributes', attributes,
           'variant_id', variant_id, 'product_id', product_id, 'sku', sku, 'name', name,
           'variant_title', variant_title, 'options', options, 'quantity', quantity,
           'unit_price', unit_price, 'total', unit_price * quantity,
           'discount_total', discount_total, 'discount_allocations', discount_allocations, 'track_inventory', track_inventory,
           'line_total', unit_price * quantity - discount_total
         ) order by idx) into v_lines_json from _price_lines;
  select coalesce(jsonb_agg(jsonb_build_object(
           'promotion_id', promotion_id, 'name', name, 'code', code, 'amount', amount, 'snapshot', snapshot || jsonb_build_object('application_index', idx)
         ) order by idx), '[]'::jsonb) into v_promos_json from _price_promos;
  if v_shipping.id is not null then
    v_shipping_json := jsonb_build_object('shipping_method_id', v_shipping.id, 'name', v_shipping.name,
      'gross_amount', v_shipping.price, 'discount_total', v_shipping.price - v_shipping_total,
      'threshold_discount', v_threshold_discount, 'total', v_shipping_total,
      'discount_allocations', v_shipping_discounts,
      'policy', jsonb_build_object('countries', v_shipping.countries, 'free_above', v_shipping.free_above));
  end if;
  v_tax := private.calculate_checkout_tax(v_lines_json, v_shipping_json, v_country);
  v_lines_json := v_tax -> 'lines'; v_tax_total := (v_tax ->> 'tax_total')::numeric;
  return jsonb_build_object(
    'tax_context', v_tax -> 'tax_context', 'shipping_line', v_tax -> 'shipping_line',
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
         new.created_at, new.tax_context)
        is distinct from
        (old.customer_id, old.email, old.currency, old.subtotal,
         old.discount_total, old.shipping_total, old.tax_total, old.total,
         old.shipping_address, old.billing_address, old.shipping_method_id,
         old.shipping_method_name, old.discount_code, old.customer_note,
         old.created_at, old.tax_context) then
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
    'tax_total', p_order.tax_total, 'tax_context', p_order.tax_context,
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
  v_price jsonb;
  v_tax jsonb;
  v_line jsonb;
  v_shipping_id uuid;
  v_tax_total numeric(12, 2);
begin
  select * into v_order from public.orders where id = update_order_address.order_id for update;

  if not found then
    raise exception 'order not found';
  end if;
  if v_order.customer_id is distinct from public.current_customer_id() and not public.is_admin() then
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

  -- Only destination tax changes; merchandise, discounts and shipping charges retain their snapshots.
  v_price := private.order_pricing_json(v_order.id);
  v_tax := private.calculate_checkout_tax(v_price -> 'lines', nullif(v_price -> 'shipping_line', 'null'::jsonb), v_address ->> 'country');
  v_tax_total := (v_tax ->> 'tax_total')::numeric;
  delete from commerce.order_tax_lines t where t.order_id = v_order.id;
  for v_line in select value from jsonb_array_elements(v_tax -> 'lines') loop
    perform private.store_order_tax_lines(v_order.id, (v_line ->> 'id')::uuid, null, v_line -> 'tax_lines');
  end loop;
  select s.id into v_shipping_id from commerce.order_shipping_lines s where s.order_id = v_order.id;
  if v_shipping_id is not null then
    perform private.store_order_tax_lines(v_order.id, null, v_shipping_id, v_tax -> 'shipping_line' -> 'tax_lines');
  end if;
  update public.orders
  set shipping_address = v_address, tax_context = v_tax -> 'tax_context',
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
      new.promotions, new.expires_at, new.created_at, new.tax_context, new.shipping_line)
     is distinct from
     (old.customer_id, old.idempotency_key, old.request_hash, old.pricing_hash,
      old.currency, old.subtotal, old.discount_total, old.shipping_total,
      old.tax_total, old.total, old.shipping_address, old.shipping_method_id,
      old.shipping_method_name, old.requested_discount_code, old.customer_note,
      old.promotions, old.expires_at, old.created_at, old.tax_context, old.shipping_line) then
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
  where q.id = new.quote_id for update;
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
    -- A lock without a write cannot fence an old REPEATABLE READ snapshot.
    -- Do not record a physical movement: only the reservation version changes.
    update public.inventory_levels il set reservation_revision = il.reservation_revision + 1
    where il.variant_id = new.variant_id and il.location_id = new.location_id
    returning il.on_hand into v_on_hand;
    if not found then raise exception 'inventory level not found for reservation'; end if;
    v_reserved := private.active_reserved_quantity(
      new.variant_id, new.location_id, null
    );
    if v_on_hand - v_reserved < new.quantity then
      raise exception 'reservation line exceeds available stock';
    end if;
    -- Validate and materialize together in AFTER INSERT, including bulk inserts.
    insert into commerce.inventory_reservations(quote_line_id, quote_id, variant_id, location_id, quantity, expires_at)
    values (new.id, new.quote_id, new.variant_id, new.location_id, new.quantity, v_quote.expires_at);
  end if;
  return new;
end;
$$;

CREATE FUNCTION private.release_inventory_reservations() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
begin
  if new.status in ('completed', 'cancelled', 'expired') then
    delete from commerce.inventory_reservations where quote_id = new.id;
  end if;
  return new;
end;
$$;

CREATE FUNCTION private.validate_inventory_reservation() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from commerce.checkout_quotes q where q.id = old.quote_id and q.status in ('open', 'converted')) then
      raise exception 'active inventory reservation cannot be deleted';
    end if;
    return old;
  end if;
  if not exists (
    select 1 from commerce.checkout_quote_lines l join commerce.checkout_quotes q on q.id = l.quote_id
    where l.id = new.quote_line_id and l.track_inventory and q.status in ('open', 'converted')
      and (l.quote_id, l.variant_id, l.location_id, l.quantity, q.expires_at)
        = (new.quote_id, new.variant_id, new.location_id, new.quantity, new.expires_at)
    for no key update of q
  ) then
    raise exception 'inventory reservation must match an active quote line';
  end if;
  return new;
end;
$$;

CREATE FUNCTION private.line_in_scope(p_snapshot jsonb, p_role text, p_variant_id uuid, p_product_id uuid, p_category_ids uuid[]) RETURNS boolean
    LANGUAGE sql IMMUTABLE SET search_path TO '' AS $$
  select coalesce((p_role = 'apply' and p_snapshot ->> 'apply_scope' = 'all')
    or (p_snapshot ->> case when p_role = 'get' then 'get_scope' else 'apply_scope' end = 'selected'
      and exists (select 1 from jsonb_array_elements(p_snapshot -> 'targets') t where t ->> 'role' = p_role and (
        (t ->> 'variant_id')::uuid = p_variant_id or (t ->> 'product_id')::uuid = p_product_id
        or (t ->> 'category_id')::uuid = any(p_category_ids)))), false);
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
  if not found or (v_quote.customer_id is distinct from public.current_customer_id() and not public.is_admin()) then
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
  v_uid uuid := private.require_customer();
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

  v_items := private.canonical_checkout_lines(items);
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

  perform private.checkout_contact_email(v_uid);
  v_address := private.resolve_checkout_address(v_uid, v_address_input, address_id);
  select l.id into v_location_id from public.locations l
  where l.is_default and l.is_active order by l.id limit 1;

  -- 固定 variant 顺序，并锁 inventory level；所有库存写路径共用这把行锁。
  for v_item in select value from jsonb_array_elements(private.canonical_variant_quantities(v_items))
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
    currency, subtotal, discount_total, shipping_total, tax_total, total, tax_context, shipping_line,
    shipping_address, shipping_method_id, shipping_method_name,
    requested_discount_code, customer_note, promotions, expires_at
  ) values (
    v_uid, v_key, v_request_hash, private.checkout_pricing_hash(v_price),
    v_price ->> 'currency', (v_price ->> 'subtotal')::numeric,
    (v_price ->> 'discount_total')::numeric,
    (v_price ->> 'shipping_total')::numeric,
    (v_price ->> 'tax_total')::numeric, (v_price ->> 'total')::numeric,
    v_price -> 'tax_context', nullif(v_price -> 'shipping_line', 'null'::jsonb),
    v_address, (v_price ->> 'shipping_method_id')::uuid,
    v_price ->> 'shipping_method_name', v_code, note,
    coalesce(v_price -> 'promotions', '[]'::jsonb),
    now() + make_interval(secs => ttl_seconds)
  ) returning * into v_quote;

  for v_line in select value from jsonb_array_elements(v_price -> 'lines')
  loop
    insert into commerce.checkout_quote_lines (
      quote_id, variant_id, product_id, location_id, sku, name, variant_title,
      options, attributes, unit_price, quantity, discount_total, total, line_total,
      track_inventory, tax_lines, discount_allocations
    ) values (
      v_quote.id, (v_line ->> 'variant_id')::uuid,
      (v_line ->> 'product_id')::uuid,
      case when (v_line ->> 'track_inventory')::boolean then v_location_id end,
      v_line ->> 'sku', v_line ->> 'name', v_line ->> 'variant_title',
      v_line -> 'options', v_line -> 'attributes', (v_line ->> 'unit_price')::numeric,
      (v_line ->> 'quantity')::integer,
      (v_line ->> 'discount_total')::numeric,
      round((v_line ->> 'unit_price')::numeric * (v_line ->> 'quantity')::integer, 2),
      (v_line ->> 'line_total')::numeric,
      (v_line ->> 'track_inventory')::boolean, v_line -> 'tax_lines', v_line -> 'discount_allocations'
    );
  end loop;
  return private.checkout_quote_json(v_quote);
end;
$$;

CREATE FUNCTION public.create_order_from_quote(quote_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_uid uuid := private.require_customer();
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
      'quantity', sum(ql.quantity)::integer)
    from commerce.checkout_quote_lines ql
    where ql.quote_id = v_quote.id and ql.track_inventory
    group by ql.variant_id, ql.location_id
    order by ql.variant_id, ql.location_id
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
           'variant_id', ql.variant_id, 'attributes', ql.attributes, 'quantity', ql.quantity)
           order by ql.variant_id, ql.line_key)
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
    customer_id, email, currency, subtotal, discount_total, shipping_total, tax_total, total, tax_context,
    shipping_address, shipping_method_id, shipping_method_name,
    discount_code, customer_note, payment_expires_at
  ) values (
    v_uid, private.checkout_contact_email(v_uid),
    v_price ->> 'currency', (v_price ->> 'subtotal')::numeric,
    (v_price ->> 'discount_total')::numeric,
    (v_price ->> 'shipping_total')::numeric,
    (v_price ->> 'tax_total')::numeric,
    (v_price ->> 'total')::numeric, v_price -> 'tax_context',
    v_quote.shipping_address, (v_price ->> 'shipping_method_id')::uuid,
    v_price ->> 'shipping_method_name', v_code_used, v_quote.customer_note, v_quote.expires_at
  ) returning * into v_order;

  for v_line in select value from jsonb_array_elements(v_price -> 'lines')
  loop
    insert into public.order_items (
      id, order_id, variant_id, product_id, sku, name, variant_title,
      options, attributes, unit_price, quantity, discount_total, total
    ) values (
      (select ql.id from commerce.checkout_quote_lines ql where ql.quote_id = v_quote.id and ql.line_key = v_line ->> 'line_key'),
      v_order.id, (v_line ->> 'variant_id')::uuid,
      (v_line ->> 'product_id')::uuid, v_line ->> 'sku', v_line ->> 'name',
      v_line ->> 'variant_title', v_line -> 'options', v_line -> 'attributes',
      (v_line ->> 'unit_price')::numeric, (v_line ->> 'quantity')::integer,
      (v_line ->> 'discount_total')::numeric,
      round((v_line ->> 'unit_price')::numeric * (v_line ->> 'quantity')::integer, 2)
    );
  end loop;

  for v_promo in select value from jsonb_array_elements(v_price -> 'promotions')
  loop
    insert into public.order_promotions (order_id, promotion_id, name, code, amount, snapshot)
    values (v_order.id, (v_promo ->> 'promotion_id')::uuid,
            v_promo ->> 'name', v_promo ->> 'code',
            (v_promo ->> 'amount')::numeric, v_promo -> 'snapshot');
    update public.promotions set used_count = used_count + 1
    where id = (v_promo ->> 'promotion_id')::uuid;
    if v_promo ->> 'code' is not null then
      insert into public.discount_redemptions (promotion_id, customer_id, order_id)
      values ((v_promo ->> 'promotion_id')::uuid, v_uid, v_order.id);
    end if;
  end loop;

  perform private.store_order_pricing(v_order.id, v_price);
  update commerce.checkout_quotes
  set status = 'converted', order_id = v_order.id
  where id = v_quote.id
  returning * into v_quote;

  insert into public.order_events (order_id, actor_id, type, data)
  values (v_order.id, auth.uid(), 'order_created',
          jsonb_build_object('total', v_order.total,
                             'promotions', v_price -> 'promotions',
                             'checkout_quote_id', v_quote.id,
                             'inventory_reserved', true));
  if v_order.total = 0 then
    -- No provider or synthetic capture is needed. Conversion already owns the
    -- quote/inventory locks and has revalidated the complete pricing snapshot.
    perform private.consume_order_reservation(v_order.id);
    update public.orders set financial_status = 'paid', paid_at = now()
      where id = v_order.id returning * into v_order;
    insert into public.order_events(order_id,actor_id,type,data)
      values(v_order.id,auth.uid(),'payment_received',jsonb_build_object('amount',0,'free_order',true));
  end if;
  return private.storefront_order_json(v_order);
end;
$$;

CREATE FUNCTION public.create_order(items jsonb, idempotency_key text, address jsonb DEFAULT NULL::jsonb, address_id uuid DEFAULT NULL::uuid, shipping_method_id uuid DEFAULT NULL::uuid, discount_code text DEFAULT NULL::text, note text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_subject_id uuid := private.require_customer();
  v_key text := btrim(idempotency_key);
  v_items jsonb;
  v_address jsonb;
  v_request_hash text;
  v_response jsonb;
  v_record commerce.command_idempotency;
  v_order public.orders;
  v_quote jsonb;
begin
  if v_subject_id is null then raise exception 'authentication required'; end if;
  if coalesce(v_key, '') = '' or length(v_key) > 200 then
    raise exception 'idempotency_key is required and must be at most 200 characters';
  end if;
  v_items := private.canonical_checkout_lines(items);
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

  v_quote := public.create_checkout_quote(
    v_items, gen_random_uuid()::text, v_address, address_id, shipping_method_id,
    upper(nullif(btrim(discount_code), '')), note
  );
  v_response := public.create_order_from_quote((v_quote ->> 'id')::uuid);
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

CREATE FUNCTION public.get_checkout_quote(quote_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_quote commerce.checkout_quotes;
begin
  select * into v_quote from commerce.checkout_quotes q
  where q.id = get_checkout_quote.quote_id
    and (q.customer_id = public.current_customer_id() or public.is_admin());
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
    and (o.customer_id = public.current_customer_id() or public.is_admin());
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
  if v_order.customer_id is distinct from public.current_customer_id() and not public.is_admin() then
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
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
    AS $$
declare v_key text;
begin
  if (new.apply_scope = 'all' and exists (select 1 from public.promotion_targets where promotion_id = new.id and role = 'apply'))
    or (new.get_scope = 'same_as_apply' and exists (select 1 from public.promotion_targets where promotion_id = new.id and role = 'get')) then
    raise exception 'remove selected targets before explicitly resetting promotion scope';
  end if;
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
