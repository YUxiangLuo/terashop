-- Catalog, customer accounts, addresses, inventory commands and content extensions
-- Cross-domain function references are resolved after all definitions are installed.
begin;
set local check_function_bodies = false;

-- Child ownership is immutable. This also keeps the deferred validator's routing stable.
CREATE FUNCTION private.catalog_product_id(p_table text, p_row jsonb) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select case p_table
    when 'products' then (p_row ->> 'id')::uuid
    when 'product_option_values' then (select product_id from public.product_options where id = (p_row ->> 'option_id')::uuid)
    when 'variant_option_values' then (select product_id from public.product_variants where id = (p_row ->> 'variant_id')::uuid)
    else (p_row ->> 'product_id')::uuid end;
$$;

CREATE FUNCTION private.guard_catalog_product() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_row jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_parent text := case tg_table_name
    when 'product_option_values' then 'option_id'
    when 'variant_option_values' then 'variant_id'
    else 'product_id' end;
  v_product_id uuid := private.catalog_product_id(tg_table_name, v_row);
begin
  if tg_op = 'UPDATE' and (
    to_jsonb(new) -> 'id' is distinct from to_jsonb(old) -> 'id'
    or to_jsonb(new) -> v_parent is distinct from to_jsonb(old) -> v_parent
  ) then
    raise exception 'catalog identity and ownership are immutable; delete and recreate the association';
  end if;
  if tg_table_name <> 'products' then
    -- Child UPDATE/DELETE may already own its row. Never wait backwards for a
    -- product publisher. Touching a non-key column supplies a real write conflict
    -- at snapshot isolation without blocking checkout's parent FK KEY SHARE.
    perform 1 from public.products where id = v_product_id for no key update nowait;
    if not found and tg_op = 'INSERT' then
      -- Never let the FK wait for an invisible/uncommitted ancestor AFTER we
      -- skipped its product lock. Cross-transaction imports must commit parents first.
      raise exception using errcode = '23503', message = 'catalog parent must exist before inserting a child';
    end if;
    update public.products set updated_at = now() where id = v_product_id;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

CREATE FUNCTION private.assert_catalog_product() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_product_id uuid := private.catalog_product_id(tg_table_name,
    case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end);
  v_status text;
begin
  select status into v_status from public.products where id = v_product_id;
  if not found then return null; end if; -- deleted parent / cascading children
  if exists (
    select 1 from public.variant_option_values vo
    join public.product_variants v on v.id = vo.variant_id
    join public.product_option_values ov on ov.id = vo.option_value_id
    join public.product_options o on o.id = ov.option_id
    where v.product_id = v_product_id and o.product_id <> v.product_id
  ) then raise exception 'variant option must belong to the same product'; end if;
  if exists (
    select 1 from public.variant_option_values vo
    join public.product_variants v on v.id = vo.variant_id
    join public.product_option_values ov on ov.id = vo.option_value_id
    where v.product_id = v_product_id
    group by v.id, ov.option_id having count(*) > 1
  ) then raise exception 'variant may select only one value per option'; end if;
  if exists (
    select 1 from public.product_images i join public.product_variants v on v.id = i.variant_id
    where i.product_id = v_product_id and v.product_id <> i.product_id
  ) then raise exception 'image variant must belong to the same product'; end if;
  if v_status = 'active' then
    if not exists (select 1 from public.product_variants where product_id = v_product_id) then
      raise exception 'published product requires a variant';
    end if;
    if exists (
      select 1 from public.product_variants v
      where v.product_id = v_product_id and v.is_active
      and (select count(*) from public.variant_option_values where variant_id = v.id)
          <> (select count(*) from public.product_options where product_id = v_product_id)
    ) then raise exception 'published variant requires one value for every option'; end if;
    if exists (
      select 1 from public.product_variants v
      where v.product_id = v_product_id and v.is_active
      group by array(select option_value_id from public.variant_option_values
                     where variant_id = v.id order by option_value_id)
      having count(*) > 1
    ) then raise exception 'published variants must have unique option combinations'; end if;
  end if;
  return null;
end;
$$;

CREATE FUNCTION private.guard_category_tree() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  -- Serialize graph edits, not readers. Fail fast instead of forming a row/graph
  -- lock inversion; callers retry the entire catalog transaction on 55P03/40001.
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('catalog.category_tree', 0)) then
    raise exception using errcode = '55P03', message = 'category tree is being edited; retry transaction';
  end if;
  update private.category_tree_guard set revision = revision + 1 where singleton;
  return null;
end;
$$;

CREATE FUNCTION private.assert_category_tree() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if tg_op = 'UPDATE' and new.id <> old.id then
    raise exception 'category identity is immutable';
  end if;
  if exists (
    with recursive ancestors as (
      select parent_id from public.categories where id = new.id
      union
      select c.parent_id from public.categories c join ancestors a on c.id = a.parent_id
    ) select 1 from ancestors where parent_id = new.id
  ) then raise exception 'category hierarchy cannot contain a cycle'; end if;
  return null;
end;
$$;

CREATE FUNCTION private.enforce_metafield_definition_compatibility() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if exists (
    select 1
    from public.metafields m
    where m.owner_type = new.owner_type
      and m.namespace = new.namespace
      and m.key = new.key
      and m.type <> new.type
  ) then
    raise exception 'metafield definition type % conflicts with existing values', new.type;
  end if;
  return new;
end;
$$;

CREATE FUNCTION private.enforce_metafield_integrity() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_definition_type text;
begin
  select d.type into v_definition_type
  from public.metafield_definitions d
  where d.owner_type = new.owner_type
    and d.namespace = new.namespace
    and d.key = new.key;

  if found and new.type <> v_definition_type then
    raise exception 'metafield "%" type % does not match definition type %',
      new.key, new.type, v_definition_type;
  end if;

  case new.owner_type
    when 'product' then
      if not exists (select 1 from public.products p where p.id = new.owner_id) then
        raise exception 'metafield owner product not found: %', new.owner_id;
      end if;
    when 'variant' then
      if not exists (select 1 from public.product_variants v where v.id = new.owner_id) then
        raise exception 'metafield owner variant not found: %', new.owner_id;
      end if;
    when 'category' then
      if not exists (select 1 from public.categories c where c.id = new.owner_id) then
        raise exception 'metafield owner category not found: %', new.owner_id;
      end if;
    when 'customer' then
      if not exists (select 1 from public.profiles p where p.id = new.owner_id) then
        raise exception 'metafield owner customer not found: %', new.owner_id;
      end if;
    when 'order' then
      if not exists (select 1 from public.orders o where o.id = new.owner_id) then
        raise exception 'metafield owner order not found: %', new.owner_id;
      end if;
    when 'shop' then
      null; -- 单店部署模式下 shop 使用约定的 singleton UUID，后续由 store_settings 替代。
  end case;

  return new;
end;
$$;

CREATE FUNCTION private.normalize_address_country() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  new.country := private.normalize_country_code(new.country);
  return new;
end;
$$;

CREATE FUNCTION private.normalize_checkout_address(p_address jsonb) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $$
declare
  v_field text;
begin
  -- Price previews may omit the address; order/quote commands require one.
  if p_address is null then return null; end if;
  if jsonb_typeof(p_address) <> 'object' then
    raise exception using errcode = '22023', message = 'address must be an object';
  end if;
  foreach v_field in array array[
    'recipient_name', 'line1', 'line2', 'city', 'region', 'postal_code', 'phone'
  ] loop
    if p_address ? v_field and jsonb_typeof(p_address -> v_field) not in ('string', 'null') then
      raise exception using errcode = '22023', message = format('address %s must be text', v_field);
    end if;
  end loop;
  -- Never infer destination country from currency, language or server location.
  return p_address || jsonb_build_object(
    'country', private.normalize_country_code(p_address ->> 'country')
  );
end;
$$;

CREATE FUNCTION private.normalize_country_code(p_country text, p_allow_wildcard boolean DEFAULT false) RETURNS text
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $_$
declare
  v_country text := upper(btrim(p_country));
begin
  if p_allow_wildcard and v_country = '*' then
    return v_country;
  end if;
  if v_country is null or v_country !~ '^[A-Z]{2}$' then
    raise exception using
      errcode = '22023',
      message = format('invalid ISO country code: %s', coalesce(p_country, '<null>'));
  end if;
  return v_country;
end;
$_$;

CREATE FUNCTION private.normalize_shipping_countries() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  select coalesce(array_agg(private.normalize_country_code(c) order by ord), '{}')
  into new.countries
  from unnest(coalesce(new.countries, '{}')) with ordinality as x(c, ord);
  return new;
end;
$$;

CREATE FUNCTION private.normalize_tax_country() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  new.country := private.normalize_country_code(coalesce(new.country, '*'), true);
  return new;
end;
$$;

CREATE FUNCTION private.protect_address_identity_and_default() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if (new.id, new.customer_id, new.created_at)
     is distinct from (old.id, old.customer_id, old.created_at) then
    raise exception 'address identity and ownership are immutable';
  end if;
  if new.is_default is distinct from old.is_default
     and current_setting('commerce.default_address_customer', true)
         is distinct from new.customer_id::text then
    raise exception 'use set_default_address to change an existing default';
  end if;
  return new;
end;
$$;

CREATE FUNCTION private.set_user_role(user_id uuid, role text) RETURNS public.profiles
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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

CREATE FUNCTION public.adjust_inventory(variant_id uuid, delta integer, reason text DEFAULT 'adjust'::text, note text DEFAULT NULL::text, location_id uuid DEFAULT NULL::uuid) RETURNS public.inventory_levels
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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

CREATE FUNCTION public.anonymize_user(p_user_id uuid) RETURNS public.profiles
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_profile public.profiles;
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  update public.profiles p
  set email = '', full_name = '', phone = null
  where p.id = p_user_id
  returning * into v_profile;
  if not found then raise exception 'user not found'; end if;

  delete from public.addresses a where a.customer_id = p_user_id;
  delete from public.metafields m
  where m.owner_type = 'customer' and m.owner_id = p_user_id;
  update public.inventory_movements set actor_id = null where actor_id = p_user_id;
  update public.order_events set actor_id = null where actor_id = p_user_id;
  update commerce.order_adjustments set actor_id = null where actor_id = p_user_id;
  update commerce.refunds set actor_id = null where actor_id = p_user_id;
  update commerce.refund_requests set actor_id = null where actor_id = p_user_id;
  return v_profile;
end;
$$;

CREATE FUNCTION public.assert_metaobject_exists(p_ref text) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if not exists (select 1 from public.metaobjects where id = p_ref::uuid) then
    raise exception 'referenced metaobject not found: %', p_ref;
  end if;
exception
  when invalid_text_representation then
    raise exception 'invalid metaobject reference: %', p_ref;
end;
$$;

CREATE FUNCTION public.enforce_single_default_address() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_previous text := current_setting('commerce.default_address_customer', true);
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('tera-headless:default-address:' || new.customer_id::text, 0)
  );
  perform set_config('commerce.default_address_customer', new.customer_id::text, true);
  update public.addresses set is_default = false
  where customer_id = new.customer_id and id <> new.id and is_default;
  perform set_config('commerce.default_address_customer', coalesce(v_previous, ''), true);
  return new;
end;
$$;

CREATE FUNCTION public.handle_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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

CREATE FUNCTION public.handle_user_email_change() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  update public.profiles set email = coalesce(new.email, '') where id = new.id;
  return new;
end;
$$;

CREATE FUNCTION public.is_admin() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

CREATE FUNCTION public.moderate_review(review_id uuid, status text) RETURNS public.product_reviews
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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

CREATE FUNCTION public.review_edit_requires_moderation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  -- 非 admin（security definer / service role 除外）修改内容后重新待审
  if new.status = old.status and not public.is_admin() then
    new.status := 'pending';
  end if;
  return new;
end;
$$;

CREATE FUNCTION public.set_default_address(address_id uuid, make_default boolean DEFAULT true) RETURNS public.addresses
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_customer_id uuid;
  v_address public.addresses;
  v_previous text := current_setting('commerce.default_address_customer', true);
begin
  if make_default is null then raise exception 'make_default is required'; end if;
  -- Read the immutable owner without locking an address row. Recheck existence
  -- after the customer lock, since a concurrent DELETE can still remove it.
  select a.customer_id into v_customer_id from public.addresses a
  where a.id = set_default_address.address_id;
  if not found or not (
    v_customer_id = auth.uid() or public.is_admin() or auth.role() = 'service_role'
  ) or (auth.uid() is null and auth.role() is distinct from 'service_role') then
    raise exception 'address not found';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('tera-headless:default-address:' || v_customer_id::text, 0)
  );
  select * into v_address from public.addresses a
  where a.id = set_default_address.address_id and a.customer_id = v_customer_id for update;
  if not found then raise exception 'address not found'; end if;

  perform set_config('commerce.default_address_customer', v_customer_id::text, true);
  if make_default then
    update public.addresses set is_default = false
    where customer_id = v_customer_id and id <> v_address.id and is_default;
  end if;
  update public.addresses a set is_default = make_default
  where a.id = v_address.id returning * into v_address;
  perform set_config('commerce.default_address_customer', coalesce(v_previous, ''), true);
  return v_address;
end;
$$;

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;

CREATE FUNCTION public.set_user_role(user_id uuid, role text) RETURNS public.profiles
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('tera-headless:set-user-role', 0)
  );
  return private.set_user_role(set_user_role.user_id, set_user_role.role);
end;
$$;

CREATE FUNCTION public.validate_metafield_value() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
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

commit;
