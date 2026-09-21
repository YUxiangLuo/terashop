-- Catalog, customer accounts, addresses, inventory commands and content extensions
-- Cross-domain function references are resolved after all definitions are installed.
begin;
set local check_function_bodies = false;

CREATE FUNCTION private.require_customer() RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  select id into v_id from public.customers where auth_user_id = auth.uid() and anonymized_at is null for no key update;
  if v_id is null then raise exception 'active customer required'; end if;
  return v_id;
end;
$$;

CREATE FUNCTION private.lock_customer_content(p_id uuid, p_child_locked boolean DEFAULT false) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
begin
  -- INSERT/commands lock parent first. UPDATE may already own a child tuple:
  -- fail fast rather than invert erasure's customer -> content lock order.
  if p_child_locked then
    perform 1 from public.customers where id = p_id and anonymized_at is null for no key update nowait;
  else
    perform 1 from public.customers where id = p_id and anonymized_at is null for no key update;
  end if;
  if not found then raise exception 'active customer required'; end if;
  update public.customers set updated_at = now() where id = p_id;
end;
$$;

CREATE FUNCTION private.guard_customer_content() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare v_row jsonb := to_jsonb(new); v_customer uuid;
begin
  if tg_table_name = 'metafields' then
    if v_row ->> 'owner_type' <> 'customer' then return new; end if;
    v_customer := (v_row ->> 'owner_id')::uuid;
  else v_customer := (v_row ->> 'customer_id')::uuid; end if;
  if v_customer is not null then perform private.lock_customer_content(v_customer, tg_op = 'UPDATE'); end if;
  return new;
end;
$$;

CREATE FUNCTION private.protect_customer() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
begin
  if (new.id, new.created_at) is distinct from (old.id, old.created_at)
    or (new.auth_user_id is distinct from old.auth_user_id and not (
      old.auth_user_id is not null and new.auth_user_id is null
      and not exists (select 1 from auth.users where id = old.auth_user_id)
    )) then raise exception 'customer identity and account link are immutable'; end if;
  if old.anonymized_at is not null and (to_jsonb(new) - array['updated_at','auth_user_id'])
    is distinct from (to_jsonb(old) - array['updated_at','auth_user_id']) then
    raise exception 'anonymized customer cannot be restored';
  end if;
  return new;
end;
$$;

CREATE FUNCTION public.create_customer(idempotency_key text, email text DEFAULT NULL, full_name text DEFAULT '', phone text DEFAULT NULL) RETURNS public.customers
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare
  v_customer public.customers;
  v_subject_id constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  v_key text := btrim(idempotency_key);
  v_email text := nullif(btrim(email), '');
  v_hash text;
  v_record commerce.command_idempotency;
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'admin only';
  end if;
  if coalesce(v_key, '') = '' or length(v_key) > 200 then
    raise exception using errcode = '22023', message = 'idempotency_key is required and must be at most 200 characters';
  end if;
  v_hash := private.command_request_hash(jsonb_build_object('email',v_email,'full_name',full_name,'phone',phone));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('customer.create:' || v_subject_id || ':' || v_key, 0));
  select * into v_record from commerce.command_idempotency c
    where c.scope = 'customer.create' and c.subject_id = v_subject_id and c.idempotency_key = v_key;
  if found then
    if v_record.request_hash <> v_hash then
      raise exception using errcode = 'PT409', message = 'idempotency key was used with different customer parameters';
    end if;
    -- Re-read rather than caching PII: edits and anonymization survive retries.
    select * into v_customer from public.customers where id = v_record.resource_id;
    if not found then raise exception using errcode = 'PT404', message = 'idempotency resource no longer exists'; end if;
    return v_customer;
  end if;
  insert into public.customers(email, full_name, phone) values (v_email, full_name, phone) returning * into v_customer;
  insert into commerce.command_idempotency(scope,subject_id,idempotency_key,request_hash,resource_type,resource_id)
    values ('customer.create',v_subject_id,v_key,v_hash,'customer',v_customer.id);
  return v_customer;
end;
$$;

CREATE FUNCTION private.customer_summary_json(p_customer public.customers) RETURNS jsonb
    LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path TO '' AS $$
  select jsonb_build_object('id',p_customer.id,'email',p_customer.email,'full_name',p_customer.full_name,
    'phone',p_customer.phone,'has_account',exists(select 1 from auth.users u
      where u.id = p_customer.auth_user_id and not u.is_anonymous),
    'anonymized_at',p_customer.anonymized_at,'created_at',p_customer.created_at,'updated_at',p_customer.updated_at);
$$;

CREATE FUNCTION public.get_admin_customer(customer_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'admin only';
  end if;
  return (select private.customer_summary_json(c) || jsonb_build_object(
    'metafields',private.catalog_metafields_json('customer',c.id,true),
    'addresses',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'label',a.label,
      'recipient_name',a.recipient_name,'phone',a.phone,'country',a.country,'region',a.region,'city',a.city,
      'line1',a.line1,'line2',a.line2,'postal_code',a.postal_code,'is_default',a.is_default,
      'updated_at',a.updated_at)
      order by a.is_default desc,a.id) from public.addresses a where a.customer_id = c.id),'[]'::jsonb))
    from public.customers c where c.id = customer_id);
end;
$$;

CREATE FUNCTION public.list_admin_customers(page_size integer DEFAULT 20, search text DEFAULT NULL,
    anonymized boolean DEFAULT NULL, after_cursor jsonb DEFAULT NULL) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
declare
  v_search text := nullif(btrim(search),'');
  v_after_time timestamptz;
  v_after_id uuid;
  v_items jsonb;
  v_next jsonb;
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'admin only';
  end if;
  if page_size is null or page_size not between 1 and 100 or char_length(search) > 200 then
    raise exception using errcode = '22023', message = 'page_size must be 1-100; search maximum 200 characters';
  end if;
  if after_cursor is not null then
    if jsonb_typeof(after_cursor) is distinct from 'object'
      or jsonb_typeof(after_cursor -> 'created_at') is distinct from 'string'
      or jsonb_typeof(after_cursor -> 'id') is distinct from 'string'
      or after_cursor - array['created_at','id'] <> '{}'::jsonb then
      raise exception using errcode = '22023', message = 'cursor requires created_at and id';
    end if;
    v_after_time := (after_cursor ->> 'created_at')::timestamptz;
    v_after_id := (after_cursor ->> 'id')::uuid;
    if not isfinite(v_after_time) then raise exception using errcode = '22023', message = 'cursor timestamp must be finite'; end if;
  end if;
  with candidates as materialized (
    select c.* from public.customers c where (anonymized is null or (c.anonymized_at is not null) = anonymized)
      and (v_after_time is null or (c.created_at,c.id) < (v_after_time,v_after_id))
      and (v_search is null or strpos(lower(c.full_name),lower(v_search)) > 0
        or strpos(lower(c.email),lower(v_search)) > 0 or strpos(lower(c.phone),lower(v_search)) > 0)
    order by c.created_at desc,c.id desc limit page_size + 1
  ), page as materialized (select * from candidates order by created_at desc,id desc limit page_size)
  select coalesce(jsonb_agg(private.customer_summary_json(p::public.customers) order by p.created_at desc,p.id desc),'[]'::jsonb),
    case when (select count(*) from candidates) > page_size then
      (select jsonb_build_object('created_at',created_at,'id',id) from page order by created_at,id limit 1) end
    into v_items,v_next from page p;
  return jsonb_build_object('items',v_items,'next_cursor',v_next);
end;
$$;

CREATE FUNCTION private.anonymize_customer(p_id uuid) RETURNS public.customers
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare v_customer public.customers;
begin
  update public.customers set email = null, full_name = '', phone = null, anonymized_at = coalesce(anonymized_at, now())
  where id = p_id returning * into v_customer;
  if not found then raise exception 'customer not found'; end if;
  delete from commerce.carts where customer_id = p_id;
  delete from public.addresses where customer_id = p_id;
  delete from public.metafields where owner_type = 'customer' and owner_id = p_id;
  return v_customer;
end;
$$;

CREATE FUNCTION public.anonymize_customer(customer_id uuid) RETURNS public.customers
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then raise exception 'admin only'; end if;
  return private.anonymize_customer(customer_id);
end;
$$;

-- Child ownership is immutable. This also keeps the deferred validator's routing stable.
CREATE FUNCTION private.advance_catalog_revision() RETURNS trigger
    LANGUAGE plpgsql SET search_path TO '' AS $$
begin
  if tg_op = 'INSERT' then
    if new.revision <> 1 then raise exception 'catalog revision is assigned by the database'; end if;
  else
    if new.revision is distinct from old.revision then raise exception 'catalog revision is assigned by the database'; end if;
    new.revision := old.revision + 1;
  end if;
  return new;
end;
$$;

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

CREATE FUNCTION private.validate_catalog_product(v_product_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_status text;
begin
  select status into v_status from public.products where id = v_product_id;
  if not found then return; end if; -- deleted parent / cascading children
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
end;
$$;

-- Metafield ownership can change through the legacy API. Invalidate both
-- aggregates; NOWAIT avoids waiting backwards while already holding a child.
CREATE FUNCTION private.guard_catalog_metafield() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare
  v_row jsonb;
  v_ids uuid[] := '{}'::uuid[];
  v_id uuid;
begin
  foreach v_row in array array[case when tg_op <> 'INSERT' then to_jsonb(old) end,
                              case when tg_op <> 'DELETE' then to_jsonb(new) end] loop
    v_id := case v_row ->> 'owner_type'
      when 'product' then (v_row ->> 'owner_id')::uuid
      when 'variant' then (select product_id from public.product_variants where id = (v_row ->> 'owner_id')::uuid) end;
    if v_id is not null then v_ids := array_append(v_ids,v_id); end if;
  end loop;
  for v_id in select distinct unnest(v_ids) order by 1 loop
    perform 1 from public.products where id = v_id for no key update nowait;
    update public.products set updated_at = now() where id = v_id;
  end loop;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

CREATE FUNCTION private.assert_catalog_product() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
begin
  perform private.validate_catalog_product(private.catalog_product_id(tg_table_name,
    case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end));
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

CREATE FUNCTION private.guard_promotion_targets() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare
  v_row jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_id uuid := (v_row ->> 'promotion_id')::uuid;
begin
  if tg_op = 'UPDATE' and (new.id, new.promotion_id, new.role) is distinct from (old.id, old.promotion_id, old.role) then
    raise exception 'promotion target identity and role are immutable; delete and recreate the association';
  end if;
  -- Child rows may already be locked, so fail fast rather than wait backwards
  -- on checkout's promotion lock. The parent write also fences old RR snapshots.
  perform 1 from public.promotions where id = v_id for no key update nowait;
  if not found then
    if tg_op = 'DELETE' then return old; end if; -- deleting the promotion itself
    raise exception using errcode = '23503', message = 'promotion target parent must exist';
  end if;
  update public.promotions set
    apply_scope = case when tg_op <> 'DELETE' and v_row ->> 'role' = 'apply' then 'selected' else apply_scope end,
    get_scope = case when tg_op <> 'DELETE' and v_row ->> 'role' = 'get' then 'selected' else get_scope end,
    updated_at = now()
  where id = v_id;
  -- Deleting the last target deliberately retains selected/empty (matches none).
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

CREATE FUNCTION private.lock_metafield_key(p_owner text, p_namespace text, p_key text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
begin
  -- Callers may already hold a definition/value row or a catalog/customer lock.
  -- Fail rather than waiting backwards for another key writer's parent lock.
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(
    'metafield:' || jsonb_build_array(p_owner,p_namespace,p_key)::text, 0)) then
    raise exception using errcode = '55P03', message = 'metafield key is being modified; retry transaction';
  end if;
  insert into private.metafield_key_guards as g(owner_type,namespace,key)
    values(p_owner,p_namespace,p_key)
    on conflict (owner_type,namespace,key) do update set revision = g.revision + 1;
end;
$$;

CREATE FUNCTION private.assert_metafield_validations(p_type text, p_value jsonb, p_rules jsonb, p_key text) RETURNS void
    LANGUAGE plpgsql IMMUTABLE SET search_path TO '' AS $$
begin
  if p_type = 'number' then
    if p_rules ? 'min' and (p_value #>> '{}')::numeric < (p_rules ->> 'min')::numeric then
      raise exception 'metafield "%" must be >= %', p_key, p_rules ->> 'min';
    end if;
    if p_rules ? 'max' and (p_value #>> '{}')::numeric > (p_rules ->> 'max')::numeric then
      raise exception 'metafield "%" must be <= %', p_key, p_rules ->> 'max';
    end if;
  end if;
  if p_rules ? 'choices' and jsonb_typeof(p_value) <> 'array'
     and not (p_rules -> 'choices' @> p_value) then
    raise exception 'metafield "%" must be one of %', p_key, p_rules -> 'choices';
  end if;
end;
$$;

CREATE FUNCTION private.enforce_metafield_definition_compatibility() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_value jsonb;
begin
  perform private.lock_metafield_key(new.owner_type,new.namespace,new.key);
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
  for v_value in select m.value from public.metafields m
    where m.owner_type = new.owner_type and m.namespace = new.namespace and m.key = new.key
  loop
    perform private.assert_metafield_validations(new.type,v_value,new.validations,new.key);
  end loop;
  return new;
end;
$$;

CREATE FUNCTION private.sync_metafield_metaobject_refs() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
begin
  delete from private.metafield_metaobject_refs where metafield_id = new.id;
  if new.type = 'metaobject_reference' then
    insert into private.metafield_metaobject_refs values (new.id,(new.value #>> '{}')::uuid);
  elsif new.type = 'list_metaobject_reference' then
    insert into private.metafield_metaobject_refs
      select distinct new.id, value::uuid from jsonb_array_elements_text(new.value);
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
  perform private.lock_metafield_key(new.owner_type,new.namespace,new.key);
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
      if not exists (select 1 from public.customers c where c.id = new.owner_id) then
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
  update private.role_management_guard set revision = revision + 1 where singleton;
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

CREATE FUNCTION public.adjust_inventory(variant_id uuid, delta integer, idempotency_key text, reason text DEFAULT 'adjust'::text, note text DEFAULT NULL::text, location_id uuid DEFAULT NULL::uuid) RETURNS public.inventory_levels
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_location_id uuid;
  v_level public.inventory_levels;
  v_subject_id constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  v_key text := btrim(idempotency_key);
  v_hash text;
  v_record commerce.command_idempotency;
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'admin only';
  end if;
  if coalesce(v_key, '') = '' or length(v_key) > 200 then
    raise exception using errcode = '22023', message = 'idempotency_key is required and must be at most 200 characters';
  end if;
  if delta is null or delta = 0 then
    raise exception using errcode = '22023', message = 'delta must be a non-zero integer';
  end if;
  if reason is null or reason not in ('restock', 'adjust') then
    raise exception using errcode = '22023', message = 'reason must be restock or adjust';
  end if;

  -- Hash the requested location, but bind the resolved warehouse on first success.
  v_hash := private.command_request_hash(jsonb_build_object(
    'variant_id',variant_id,'delta',delta,'reason',reason,'note',note,'location_id',location_id));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('inventory.adjust:' || v_subject_id || ':' || v_key, 0));
  select * into v_record from commerce.command_idempotency c
    where c.scope = 'inventory.adjust' and c.subject_id = v_subject_id and c.idempotency_key = v_key;
  if found then
    if v_record.request_hash <> v_hash then
      raise exception using errcode = 'PT409', message = 'idempotency key was used with different inventory parameters';
    end if;
    select * into v_level from public.inventory_levels il
      where il.variant_id = v_record.resource_id and il.location_id = v_record.resource_location_id;
    if not found then raise exception using errcode = 'PT404', message = 'idempotency resource no longer exists'; end if;
    return v_level;
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

  insert into commerce.command_idempotency(scope,subject_id,idempotency_key,request_hash,resource_type,resource_id,resource_location_id)
    values ('inventory.adjust',v_subject_id,v_key,v_hash,'inventory_level',variant_id,v_location_id);
  return v_level;
end;
$$;

CREATE FUNCTION public.anonymize_user(p_user_id uuid) RETURNS public.profiles
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_profile public.profiles;
  v_customer_id uuid;
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  select id into v_customer_id from public.customers where auth_user_id = p_user_id;
  if v_customer_id is not null then perform private.anonymize_customer(v_customer_id); end if;
  update public.profiles p
  set email = ''
  where p.id = p_user_id
  returning * into v_profile;
  if not found then raise exception 'user not found'; end if;

  update public.inventory_movements set actor_id = null where actor_id = p_user_id;
  update public.order_events set actor_id = null where actor_id = p_user_id;
  update commerce.order_adjustments set actor_id = null where actor_id = p_user_id;
  update commerce.refunds set actor_id = null where actor_id = p_user_id;
  update commerce.refund_requests set actor_id = null where actor_id = p_user_id;
  update commerce.returns set actor_id = null where actor_id = p_user_id;
  update commerce.return_receipts set actor_id = null where actor_id = p_user_id;
  update commerce.return_dispositions set actor_id = null where actor_id = p_user_id;
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
  -- addresses_customer_content acquired the customer row before this INSERT.
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
  insert into public.profiles (id, email) values (new.id, coalesce(new.email, ''));
  insert into public.customers (auth_user_id, email, full_name)
  values (new.id, nullif(new.email, ''), left(coalesce(new.raw_user_meta_data ->> 'full_name', ''), 200));
  return new;
end;
$$;

CREATE FUNCTION public.handle_user_email_change() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  -- Account email follows Auth; customer contact email is independent. Never
  -- attach an existing customer by email or restore erased contact information.
  update public.profiles set email = coalesce(new.email, '') where id = new.id
    and not exists (select 1 from public.customers where auth_user_id = new.id and anonymized_at is not null);
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

CREATE FUNCTION public.moderate_review(review_id uuid, status text, expected_revision integer DEFAULT NULL) RETURNS public.product_reviews
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_review public.product_reviews;
begin
  if not public.is_admin() then
    raise exception using errcode='42501', message='admin only';
  end if;
  if review_id is null or status is null or status not in ('pending', 'approved', 'rejected')
    or expected_revision<1 then
    raise exception using errcode='22023', message='invalid review, status or revision';
  end if;
  select * into v_review from public.product_reviews r where r.id=review_id for update nowait;
  if not found then raise exception using errcode='PT404', message='review not found'; end if;
  if expected_revision is not null and v_review.revision<>expected_revision then
    raise exception using errcode='PT409', message='review was modified';
  end if;
  if v_review.status=status then return v_review; end if;
  update public.product_reviews r
  set status = moderate_review.status
  where r.id = moderate_review.review_id
  returning * into v_review;
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
  if not found or (
    v_customer_id = public.current_customer_id() or public.is_admin() or auth.role() = 'service_role'
  ) is not true or (auth.uid() is null and auth.role() is distinct from 'service_role') then
    raise exception 'address not found';
  end if;
  perform private.lock_customer_content(v_customer_id);
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
    LANGUAGE plpgsql SECURITY DEFINER
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
      raise exception 'unsupported metafield type: %', new.type;
  end case;

  -- definition.validations 执行：min/max（number）、choices（标量白名单）
  select d.validations into v_validations
  from public.metafield_definitions d
  where d.owner_type = new.owner_type
    and d.namespace = new.namespace
    and d.key = new.key;

  perform private.assert_metafield_validations(new.type,new.value,v_validations,new.key);

  return new;
end;
$$;

-- A typed reference is public only while every referenced object and its
-- definition are public. Unstructured JSON is content, never an access rule.
CREATE FUNCTION private.metaobject_references_public(p_type text, p_value jsonb) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $$
  select case when p_type not in ('metaobject_reference','list_metaobject_reference') then true
    else not exists (
      select 1 from jsonb_array_elements_text(case when p_type = 'metaobject_reference'
        then jsonb_build_array(p_value) else p_value end) r(id)
      where not exists (select 1 from public.metaobjects o
        join public.metaobject_definitions d on d.id = o.definition_id
        where o.id = r.id::uuid and o.status = 'active' and d.is_active and d.access = 'public')
    ) end;
$$;

CREATE FUNCTION private.catalog_metafields_json(p_owner_type text, p_owner_id uuid, p_admin boolean) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $$
  select coalesce(jsonb_agg(jsonb_build_object('namespace', m.namespace, 'key', m.key, 'type', m.type, 'value', m.value)
    order by m.namespace, m.key), '[]'::jsonb)
  from public.metafields m where m.owner_type = p_owner_type and m.owner_id = p_owner_id
    and (p_admin or (exists (select 1 from public.metafield_definitions d
      where (d.owner_type,d.namespace,d.key) = (m.owner_type,m.namespace,m.key) and d.access = 'public')
      and private.metaobject_references_public(m.type,m.value)));
$$;

-- Explicit catalog DTO: even an admin calling Storefront sees only public data.
CREATE FUNCTION private.catalog_product_json(p_product public.products, p_admin boolean) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $$
  select jsonb_build_object('id', p_product.id, 'slug', p_product.slug, 'name', p_product.name,
    'description', p_product.description, 'vendor', p_product.vendor, 'product_type', p_product.product_type,
    'tags', p_product.tags, 'seo_title', p_product.seo_title, 'seo_description', p_product.seo_description,
    'currency', 'USD', 'metafields', private.catalog_metafields_json('product',p_product.id,p_admin),
    'variants', coalesce((select jsonb_agg(jsonb_build_object('id',v.id,'sku',v.sku,'barcode',v.barcode,
      'price',v.price,'compare_at_price',v.compare_at_price,'position',v.position,
      'in_stock', not v.track_inventory or exists (select 1 from public.inventory_levels il
        join public.locations l on l.id = il.location_id and l.is_active and l.is_default
        where il.variant_id = v.id and il.on_hand > private.active_reserved_quantity(v.id,l.id,null)),
      'option_value_ids', coalesce((select jsonb_agg(x.option_value_id order by x.option_value_id)
        from public.variant_option_values x where x.variant_id = v.id),'[]'::jsonb),
      'metafields', private.catalog_metafields_json('variant',v.id,p_admin))
      || case when p_admin then jsonb_build_object('cost',v.cost,'is_active',v.is_active,'track_inventory',v.track_inventory)
        else '{}'::jsonb end order by v.position,v.id)
      from public.product_variants v where v.product_id = p_product.id and (p_admin or v.is_active)),'[]'::jsonb),
    'options', coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'name',o.name,'position',o.position,
      'values',coalesce((select jsonb_agg(jsonb_build_object('id',v.id,'value',v.value,'position',v.position) order by v.position,v.id)
        from public.product_option_values v where v.option_id = o.id),'[]'::jsonb)) order by o.position,o.id)
      from public.product_options o where o.product_id = p_product.id),'[]'::jsonb),
    'images', coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'url',i.url,'alt',i.alt,'position',i.position,'variant_id',i.variant_id)
      order by i.position,i.id) from public.product_images i where i.product_id = p_product.id and
      (p_admin or i.variant_id is null or exists (select 1 from public.product_variants v where v.id = i.variant_id and v.is_active))),'[]'::jsonb),
    'categories', coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'slug',c.slug,'name',c.name) order by c.slug,c.id)
      from public.product_categories pc join public.categories c on c.id = pc.category_id
      where pc.product_id = p_product.id and (p_admin or c.is_active)),'[]'::jsonb))
    || case when p_admin then jsonb_build_object('revision',p_product.revision,'status',p_product.status,'created_at',p_product.created_at,'updated_at',p_product.updated_at)
      else '{}'::jsonb end;
$$;

CREATE FUNCTION public.get_storefront_product(product_id uuid) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $$
  select private.catalog_product_json(p,false) from public.products p
  where p.id = product_id and p.status = 'active';
$$;

CREATE FUNCTION public.get_admin_product(product_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'admin only';
  end if;
  return (select private.catalog_product_json(p,true) from public.products p where p.id = product_id);
end;
$$;

-- Whitelisted patch writer for the five editable catalog row types. No caller
-- controls a table/column identifier; omitted fields retain values/defaults.
CREATE FUNCTION private.apply_catalog_edit(p_product_id uuid, p_table text, p_change jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare
  v_allowed text[];
  v_id uuid;
  v_old jsonb;
  v_patch jsonb;
  v_columns text;
  v_assignments text;
  v_owner uuid;
begin
  v_allowed := case p_table
    when 'products' then array['slug','name','description','status','vendor','product_type','tags','seo_title','seo_description']
    when 'product_variants' then array['sku','barcode','price','compare_at_price','cost','track_inventory','position','is_active']
    when 'product_options' then array['name','position']
    when 'product_option_values' then array['option_id','value','position']
    when 'product_images' then array['variant_id','url','alt','position']
    else null end;
  if v_allowed is null or jsonb_typeof(p_change) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'invalid catalog edit';
  end if;
  if exists (select 1 from jsonb_object_keys(p_change) k where not k = any(v_allowed || array['id','delete']))
    or jsonb_typeof(p_change -> 'id') is distinct from 'string'
    or (p_change ? 'delete' and jsonb_typeof(p_change -> 'delete') is distinct from 'boolean') then
    raise exception using errcode = '22023', message = 'unknown or invalid catalog edit field';
  end if;
  v_id := (p_change ->> 'id')::uuid;
  execute format('select to_jsonb(t) from public.%I t where id=$1 for no key update nowait',p_table) into v_old using v_id;
  if v_old is not null then
    v_owner := private.catalog_product_id(p_table,v_old);
    if v_owner is distinct from p_product_id then raise exception 'catalog resource belongs to another product'; end if;
    if p_table = 'product_option_values' and p_change ? 'option_id'
      and (p_change ->> 'option_id')::uuid is distinct from (v_old ->> 'option_id')::uuid then
      raise exception 'catalog option ownership is immutable';
    end if;
  end if;
  if coalesce((p_change ->> 'delete')::boolean,false) then
    if p_table = 'products' or p_change - array['id','delete'] <> '{}'::jsonb or v_old is null then
      raise exception using errcode = '22023', message = 'delete requires an existing child id and no other fields';
    end if;
    execute format('delete from public.%I where id=$1',p_table) using v_id;
    return;
  end if;
  v_patch := p_change - 'delete';
  if v_old is null then
    if p_table = 'products' then raise exception 'product not found'; end if;
    if p_table = 'product_option_values' then
      select product_id into v_owner from public.product_options where id = (p_change ->> 'option_id')::uuid;
      if v_owner is distinct from p_product_id then raise exception 'option must belong to this product'; end if;
    else
      v_patch := v_patch || jsonb_build_object('product_id',p_product_id);
    end if;
    select string_agg(format('%I',k),',' order by k) into v_columns from jsonb_object_keys(v_patch) k;
    execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I,$1)',
      p_table,v_columns,v_columns,p_table) using v_patch;
  else
    v_patch := v_patch - array['id','option_id'];
    if v_patch = '{}'::jsonb then return; end if;
    select string_agg(format('%I=x.%I',k,k),',' order by k) into v_assignments from jsonb_object_keys(v_patch) k;
    execute format('update public.%I t set %s from jsonb_populate_record(null::public.%I,$1) x where t.id=$2',
      p_table,v_assignments,p_table) using v_patch,v_id;
  end if;
end;
$$;

CREATE FUNCTION public.update_product(product_id uuid, expected_revision bigint, changes jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare
  v_product public.products;
  v_group text;
  v_change jsonb;
  v_id uuid;
  v_owner uuid;
  v_categories uuid[];
  v_owner_type text;
  v_metafield_id uuid;
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'admin only';
  end if;
  if expected_revision is null or expected_revision < 1 or jsonb_typeof(changes) is distinct from 'object'
    or octet_length(changes::text) > 262144 then
    raise exception using errcode = '22023', message = 'expected_revision and a changes object up to 256 KiB are required';
  end if;
  if exists (select 1 from jsonb_object_keys(changes) k
    where k not in ('product','options','option_values','variants','variant_options','images','category_ids','metafields')) then
    raise exception using errcode = '22023', message = 'unknown changes field';
  end if;
  select * into v_product from public.products p where p.id = update_product.product_id for no key update;
  if not found then raise exception using errcode = 'PT404', message = 'product not found'; end if;
  if v_product.revision <> expected_revision then
    raise exception using errcode = 'PT409', message = 'product revision conflict; reload before saving';
  end if;
  if changes ? 'product' then
    if jsonb_typeof(changes -> 'product') is distinct from 'object' or changes -> 'product' ?| array['id','delete'] then
      raise exception using errcode = '22023', message = 'product patch cannot specify identity or delete';
    end if;
    perform private.apply_catalog_edit(product_id,'products',changes -> 'product' || jsonb_build_object('id',product_id));
  end if;
  foreach v_group in array array['options','option_values','variants','variant_options','images'] loop
    if not changes ? v_group then continue; end if;
    if jsonb_typeof(changes -> v_group) is distinct from 'array' then
      raise exception using errcode = '22023', message = 'catalog changes collections must be arrays';
    end if;
    if jsonb_array_length(changes -> v_group) > 500 then
      raise exception using errcode = '22023', message = 'catalog changes limited to 500 entries per collection';
    end if;
    if exists (select 1 from jsonb_array_elements(changes -> v_group) e group by (e ->> 'id')::uuid having count(*) > 1) then
      raise exception using errcode = '22023', message = 'duplicate catalog resource id';
    end if;
    for v_change in select value from jsonb_array_elements(changes -> v_group) loop
      if v_group <> 'variant_options' then
        perform private.apply_catalog_edit(product_id,case v_group when 'options' then 'product_options'
          when 'option_values' then 'product_option_values' when 'variants' then 'product_variants' else 'product_images' end,v_change);
      else
        if jsonb_typeof(v_change) is distinct from 'object' or v_change - array['id','option_value_ids'] <> '{}'::jsonb
          or jsonb_typeof(v_change -> 'id') is distinct from 'string'
          or jsonb_typeof(v_change -> 'option_value_ids') is distinct from 'array' then
          raise exception using errcode = '22023', message = 'variant_options requires id and option_value_ids';
        end if;
        v_id := (v_change ->> 'id')::uuid;
        select v.product_id into v_owner from public.product_variants v where v.id = v_id for no key update nowait;
        if v_owner is distinct from product_id then raise exception 'variant must belong to this product'; end if;
        delete from public.variant_option_values where variant_id = v_id;
        insert into public.variant_option_values(variant_id,option_value_id)
          select v_id,value::uuid from jsonb_array_elements_text(v_change -> 'option_value_ids');
      end if;
    end loop;
  end loop;
  if changes ? 'category_ids' then
    if jsonb_typeof(changes -> 'category_ids') is distinct from 'array' then
      raise exception using errcode = '22023', message = 'category_ids must be an array';
    end if;
    if jsonb_array_length(changes -> 'category_ids') > 500
      or exists (select 1 from jsonb_array_elements(changes -> 'category_ids') e where jsonb_typeof(e) <> 'string') then
      raise exception using errcode = '22023', message = 'category_ids requires at most 500 UUID strings';
    end if;
    select coalesce(array_agg(value::uuid),'{}') into v_categories from jsonb_array_elements_text(changes -> 'category_ids');
    if cardinality(v_categories) <> (select count(distinct x) from unnest(v_categories) x) then
      raise exception using errcode = '22023', message = 'duplicate category id';
    end if;
    perform 1 from public.product_categories pc where pc.product_id = update_product.product_id for update nowait;
    delete from public.product_categories pc where pc.product_id = update_product.product_id and not pc.category_id = any(v_categories);
    insert into public.product_categories(product_id,category_id)
      select product_id,x from unnest(v_categories) x where not exists
        (select 1 from public.product_categories pc where pc.product_id = update_product.product_id and pc.category_id = x);
  end if;
  if changes ? 'metafields' then
    if jsonb_typeof(changes -> 'metafields') is distinct from 'array' then
      raise exception using errcode = '22023', message = 'metafields must be an array';
    end if;
    if jsonb_array_length(changes -> 'metafields') > 500 then
      raise exception using errcode = '22023', message = 'metafields limited to 500 entries';
    end if;
    if exists (select 1 from jsonb_array_elements(changes -> 'metafields') e
      group by (e ->> 'variant_id')::uuid,e ->> 'namespace',e ->> 'key' having count(*) > 1) then
      raise exception using errcode = '22023', message = 'duplicate metafield identity';
    end if;
    for v_change in select value from jsonb_array_elements(changes -> 'metafields') loop
      if jsonb_typeof(v_change) is distinct from 'object'
        or v_change - array['variant_id','namespace','key','type','value','delete'] <> '{}'::jsonb
        or jsonb_typeof(v_change -> 'namespace') is distinct from 'string'
        or jsonb_typeof(v_change -> 'key') is distinct from 'string'
        or (v_change ? 'variant_id' and jsonb_typeof(v_change -> 'variant_id') is distinct from 'string')
        or (v_change ? 'delete' and jsonb_typeof(v_change -> 'delete') is distinct from 'boolean') then
        raise exception using errcode = '22023', message = 'invalid metafield edit';
      end if;
      v_owner_type := case when v_change ? 'variant_id' then 'variant' else 'product' end;
      v_owner := product_id;
      if v_owner_type = 'variant' then
        v_owner := (v_change ->> 'variant_id')::uuid;
        perform 1 from public.product_variants v where v.id = v_owner and v.product_id = update_product.product_id for no key update nowait;
        if not found then raise exception 'variant must belong to this product'; end if;
      end if;
      select m.id into v_metafield_id from public.metafields m where m.owner_type = v_owner_type
        and m.owner_id = v_owner and m.namespace = v_change ->> 'namespace' and m.key = v_change ->> 'key' for update nowait;
      if coalesce((v_change ->> 'delete')::boolean,false) then
        if v_metafield_id is null or v_change ?| array['type','value'] then
          raise exception using errcode = '22023', message = 'delete requires an existing metafield and no type/value';
        end if;
        delete from public.metafields where id = v_metafield_id;
      else
        if jsonb_typeof(v_change -> 'type') is distinct from 'string' or not v_change ? 'value' then
          raise exception using errcode = '22023', message = 'metafield edit requires type and value';
        end if;
        if v_metafield_id is null then
          insert into public.metafields(owner_type,owner_id,namespace,key,type,value)
            values (v_owner_type,v_owner,v_change ->> 'namespace',v_change ->> 'key',v_change ->> 'type',v_change -> 'value');
        else
          update public.metafields set type = v_change ->> 'type', value = v_change -> 'value' where id = v_metafield_id;
        end if;
      end if;
    end loop;
  end if;
  -- No trigger is disabled and no transaction-wide constraint mode is changed.
  perform private.validate_catalog_product(product_id);
  return (select private.catalog_product_json(p,true) from public.products p where p.id = update_product.product_id);
end;
$$;

CREATE FUNCTION public.create_product(product_id uuid, changes jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'admin only';
  end if;
  if product_id is null or jsonb_typeof(changes) is distinct from 'object'
    or octet_length(changes::text) > 262144
    or jsonb_typeof(changes -> 'product' -> 'slug') is distinct from 'string'
    or jsonb_typeof(changes -> 'product' -> 'name') is distinct from 'string' then
    raise exception using errcode = '22023', message = 'product_id and product slug/name are required; changes maximum 256 KiB';
  end if;
  -- The draft exists only inside this transaction. All editing and publication
  -- rules stay in update_product; any failure also rolls back this insert.
  insert into public.products(id,slug,name)
    values (product_id,changes -> 'product' ->> 'slug',changes -> 'product' ->> 'name');
  return public.update_product(product_id,1,changes);
end;
$$;

CREATE FUNCTION public.list_admin_products(page_size integer DEFAULT 20, status_filter text DEFAULT NULL,
    category_id uuid DEFAULT NULL, search text DEFAULT NULL, after_cursor jsonb DEFAULT NULL) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
declare
  v_search text := nullif(btrim(search),'');
  v_after_time timestamptz;
  v_after_id uuid;
  v_items jsonb;
  v_next jsonb;
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'admin only';
  end if;
  if page_size is null or page_size not between 1 and 100
    or (status_filter is not null and status_filter not in ('draft','active','archived'))
    or char_length(search) > 200 then
    raise exception using errcode = '22023', message = 'invalid page_size, status_filter or search (maximum 200 characters)';
  end if;
  if after_cursor is not null then
    if jsonb_typeof(after_cursor) is distinct from 'object'
      or jsonb_typeof(after_cursor -> 'updated_at') is distinct from 'string'
      or jsonb_typeof(after_cursor -> 'id') is distinct from 'string'
      or after_cursor - array['updated_at','id'] <> '{}'::jsonb then
      raise exception using errcode = '22023', message = 'cursor requires updated_at and id';
    end if;
    v_after_time := (after_cursor ->> 'updated_at')::timestamptz;
    v_after_id := (after_cursor ->> 'id')::uuid;
    if not isfinite(v_after_time) then
      raise exception using errcode = '22023', message = 'cursor timestamp must be finite';
    end if;
  end if;
  with candidates as materialized (
    select p.id,p.slug,p.name,p.status,p.updated_at,p.revision from public.products p
    where (status_filter is null or p.status = status_filter)
      and (v_after_time is null or (p.updated_at,p.id) < (v_after_time,v_after_id))
      and (category_id is null or exists (select 1 from public.product_categories pc
        where pc.product_id = p.id and pc.category_id = list_admin_products.category_id))
      and (v_search is null or strpos(lower(p.name),lower(v_search)) > 0
        or exists (select 1 from public.product_variants v where v.product_id = p.id
          and strpos(lower(v.sku),lower(v_search)) > 0))
    order by p.updated_at desc,p.id desc limit page_size + 1
  ), page as materialized (select * from candidates order by updated_at desc,id desc limit page_size)
  select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'slug',p.slug,'name',p.name,'status',p.status,
    'updated_at',p.updated_at,'revision',p.revision,'currency','USD',
    'price_from',v.price_from,'price_to',v.price_to,'variant_count',v.variant_count,
    'primary_image',(select i.url from public.product_images i where i.product_id = p.id
      order by i.position,i.id limit 1)) order by p.updated_at desc,p.id desc),'[]'::jsonb),
    case when (select count(*) from candidates) > page_size then
      (select jsonb_build_object('updated_at',updated_at,'id',id) from page order by updated_at,id limit 1) end
  into v_items,v_next from page p cross join lateral (
    select min(price) price_from,max(price) price_to,count(*) variant_count
    from public.product_variants where product_id = p.id
  ) v;
  return jsonb_build_object('items',v_items,'next_cursor',v_next);
end;
$$;

CREATE FUNCTION public.list_storefront_products(page_size integer DEFAULT 20, after_id uuid DEFAULT NULL, category_id uuid DEFAULT NULL) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
declare v_items jsonb; v_next uuid;
begin
  if page_size is null or page_size not between 1 and 100 then
    raise exception using errcode = '22023', message = 'page_size must be between 1 and 100';
  end if;
  with candidates as materialized (
    select p.id,p.slug,p.name from public.products p where p.status = 'active' and (after_id is null or p.id > after_id)
      and (category_id is null or exists (select 1 from public.product_categories pc join public.categories c on c.id = pc.category_id
        where pc.product_id = p.id and c.id = list_storefront_products.category_id and c.is_active))
    order by p.id limit page_size + 1
  ), page as materialized (select * from candidates order by id limit page_size)
  select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'slug',p.slug,'name',p.name,'currency','USD',
    'price_from',(select min(v.price) from public.product_variants v where v.product_id = p.id and v.is_active),
    'in_stock',exists (select 1 from public.product_variants v where v.product_id = p.id and v.is_active and
      (not v.track_inventory or exists (select 1 from public.inventory_levels il join public.locations l on l.id = il.location_id
        where il.variant_id = v.id and l.is_default and l.is_active and il.on_hand > private.active_reserved_quantity(v.id,l.id,null)))),
    'primary_image',(select i.url from public.product_images i where i.product_id = p.id
      and (i.variant_id is null or exists (select 1 from public.product_variants v where v.id = i.variant_id and v.is_active))
      order by i.position,i.id limit 1)) order by p.id),'[]'::jsonb),
    case when (select count(*) from candidates) > page_size then (select id from page order by id desc limit 1) end
  into v_items,v_next from page p;
  return jsonb_build_object('items',v_items,'next_cursor',v_next);
end;
$$;

-- Explicit administrator category DTO; do not expose future table columns.
CREATE FUNCTION private.admin_category_json(p_category public.categories) RETURNS jsonb
    LANGUAGE sql STABLE STRICT SET search_path TO '' AS $$
  select jsonb_build_object('id',p_category.id,'slug',p_category.slug,'name',p_category.name,
    'description',p_category.description,'parent_id',p_category.parent_id,'image_url',p_category.image_url,
    'position',p_category.position,'is_active',p_category.is_active,
    'created_at',p_category.created_at,'updated_at',p_category.updated_at);
$$;

CREATE FUNCTION public.get_admin_category(category_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  return (select private.admin_category_json(c) from public.categories c where c.id=category_id);
end;
$$;

CREATE FUNCTION public.list_admin_categories(page_size integer DEFAULT 20, after_id uuid DEFAULT NULL,
    parent_id uuid DEFAULT NULL, root_only boolean DEFAULT false, active boolean DEFAULT NULL,
    search text DEFAULT NULL) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
declare v_items jsonb; v_next uuid;
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if page_size is null or page_size not between 1 and 100 or root_only is null
    or (root_only and parent_id is not null) or length(search)>200 then
    raise exception using errcode='22023', message='invalid category list filters';
  end if;
  with candidates as materialized (
    select c as category,c.id from public.categories c where (after_id is null or c.id>after_id)
      and (list_admin_categories.parent_id is null or c.parent_id=list_admin_categories.parent_id)
      and (not root_only or c.parent_id is null) and (active is null or c.is_active=active)
      and (nullif(btrim(search),'') is null or strpos(lower(c.name),lower(btrim(search)))>0
        or strpos(lower(c.slug),lower(btrim(search)))>0)
    order by c.id limit page_size+1
  ), page as materialized (select * from candidates order by id limit page_size)
  select coalesce(jsonb_agg(private.admin_category_json(p.category) order by p.id),'[]'::jsonb),
    case when (select count(*) from candidates)>page_size then (select id from page order by id desc limit 1) end
  into v_items,v_next from page p;
  return jsonb_build_object('items',v_items,'next_cursor',v_next);
end;
$$;

CREATE FUNCTION public.update_category(category_id uuid, expected_updated_at timestamptz, changes jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare v_category public.categories; v_new public.categories; v_key text; v_value jsonb;
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if category_id is null or expected_updated_at is null or not isfinite(expected_updated_at)
    or jsonb_typeof(changes) is distinct from 'object' or octet_length(changes::text)>262144 then
    raise exception using errcode='22023', message='invalid category patch';
  end if;
  for v_key,v_value in select * from jsonb_each(changes) loop
    if v_key not in ('slug','name','description','parent_id','image_url','position','is_active')
      or (v_key in ('slug','name','description') and jsonb_typeof(v_value)<>'string')
      or (v_key in ('parent_id','image_url') and jsonb_typeof(v_value) not in ('string','null'))
      or (v_key='position' and (jsonb_typeof(v_value)<>'number' or v_value::text !~ '^-?[0-9]+$'))
      or (v_key='is_active' and jsonb_typeof(v_value)<>'boolean') then
      raise exception using errcode='22023', message='unknown or invalid category field';
    end if;
  end loop;
  select * into v_category from public.categories c where c.id=category_id for update nowait;
  if not found then raise exception using errcode='PT404', message='category not found'; end if;
  if v_category.updated_at is distinct from expected_updated_at then
    raise exception using errcode='PT409', message='category was modified; reread before editing';
  end if;
  v_new := jsonb_populate_record(v_category,changes);
  if v_new is not distinct from v_category then return private.admin_category_json(v_category); end if;
  update public.categories c set slug=v_new.slug,name=v_new.name,description=v_new.description,
    parent_id=v_new.parent_id,image_url=v_new.image_url,position=v_new.position,is_active=v_new.is_active
  where c.id=category_id returning c.* into v_category;
  return private.admin_category_json(v_category);
end;
$$;

CREATE FUNCTION public.create_category(category_id uuid, changes jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare v_category public.categories;
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if category_id is null or jsonb_typeof(changes) is distinct from 'object'
    or jsonb_typeof(changes->'slug') is distinct from 'string'
    or jsonb_typeof(changes->'name') is distinct from 'string' then
    raise exception using errcode='22023', message='category id, slug and name are required';
  end if;
  insert into public.categories(id,slug,name) values(category_id,changes->>'slug',changes->>'name')
    returning * into v_category;
  return public.update_category(category_id,v_category.updated_at,changes);
end;
$$;

CREATE FUNCTION public.update_customer(customer_id uuid, expected_updated_at timestamptz, changes jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare v_customer public.customers; v_new public.customers; v_key text; v_value jsonb;
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if customer_id is null or expected_updated_at is null or not isfinite(expected_updated_at)
    or jsonb_typeof(changes) is distinct from 'object' or octet_length(changes::text)>262144 then
    raise exception using errcode='22023', message='invalid customer patch';
  end if;
  for v_key,v_value in select * from jsonb_each(changes) loop
    if v_key not in ('email','full_name','phone')
      or (v_key='full_name' and jsonb_typeof(v_value)<>'string')
      or (v_key in ('email','phone') and jsonb_typeof(v_value) not in ('string','null')) then
      raise exception using errcode='22023', message='unknown or invalid customer field';
    end if;
  end loop;
  select * into v_customer from public.customers c where c.id=customer_id for no key update nowait;
  if not found then raise exception using errcode='PT404', message='customer not found'; end if;
  if v_customer.anonymized_at is not null then
    raise exception using errcode='PT409', message='customer is anonymized';
  end if;
  if v_customer.updated_at is distinct from expected_updated_at then
    raise exception using errcode='PT409', message='customer was modified; reread before editing';
  end if;
  v_new := jsonb_populate_record(v_customer,changes);
  if v_new is distinct from v_customer then
    update public.customers c set email=v_new.email,full_name=v_new.full_name,phone=v_new.phone where c.id=customer_id;
  end if;
  return public.get_admin_customer(customer_id);
end;
$$;

CREATE FUNCTION public.update_customer_address(customer_id uuid, address_id uuid,
    expected_updated_at timestamptz, changes jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare v_address public.addresses; v_new public.addresses; v_key text; v_value jsonb;
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if customer_id is null or address_id is null or expected_updated_at is null or not isfinite(expected_updated_at)
    or jsonb_typeof(changes) is distinct from 'object' or octet_length(changes::text)>262144 then
    raise exception using errcode='22023', message='invalid address patch';
  end if;
  for v_key,v_value in select * from jsonb_each(changes) loop
    if v_key not in ('label','recipient_name','phone','country','region','city','line1','line2','postal_code')
      or (v_key in ('label','recipient_name','country','line1') and jsonb_typeof(v_value)<>'string')
      or (v_key in ('phone','region','city','line2','postal_code') and jsonb_typeof(v_value) not in ('string','null')) then
      raise exception using errcode='22023', message='unknown or invalid address field';
    end if;
  end loop;
  -- Same parent -> child lock order as anonymization and default selection.
  perform 1 from public.customers c where c.id=customer_id and c.anonymized_at is null for no key update nowait;
  if not found then raise exception using errcode='PT404', message='active customer not found'; end if;
  select * into v_address from public.addresses a
    where a.id=address_id and a.customer_id=update_customer_address.customer_id for update nowait;
  if not found then raise exception using errcode='PT404', message='address not found'; end if;
  if v_address.updated_at is distinct from expected_updated_at then
    raise exception using errcode='PT409', message='address was modified; reread before editing';
  end if;
  v_new := jsonb_populate_record(v_address,changes);
  if v_new is distinct from v_address then
    update public.addresses a set label=v_new.label,recipient_name=v_new.recipient_name,phone=v_new.phone,
      country=v_new.country,region=v_new.region,city=v_new.city,line1=v_new.line1,line2=v_new.line2,postal_code=v_new.postal_code
      where a.id=address_id;
  end if;
  return public.get_admin_customer(customer_id);
end;
$$;

CREATE FUNCTION public.create_customer_address(customer_id uuid, address_id uuid, changes jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare v_address public.addresses;
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if customer_id is null or address_id is null or jsonb_typeof(changes) is distinct from 'object'
    or jsonb_typeof(changes->'recipient_name') is distinct from 'string'
    or jsonb_typeof(changes->'country') is distinct from 'string'
    or jsonb_typeof(changes->'line1') is distinct from 'string' then
    raise exception using errcode='22023', message='customer, address, recipient, country and line1 are required';
  end if;
  perform 1 from public.customers c where c.id=customer_id and c.anonymized_at is null for no key update nowait;
  if not found then raise exception using errcode='PT404', message='active customer not found'; end if;
  insert into public.addresses(id,customer_id,recipient_name,country,line1)
    values(address_id,customer_id,changes->>'recipient_name',changes->>'country',changes->>'line1')
    returning * into v_address;
  return public.update_customer_address(customer_id,address_id,v_address.updated_at,changes);
end;
$$;

CREATE FUNCTION public.delete_customer_address(customer_id uuid, address_id uuid, expected_updated_at timestamptz) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare v_address public.addresses;
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if customer_id is null or address_id is null or expected_updated_at is null or not isfinite(expected_updated_at) then
    raise exception using errcode='22023', message='invalid address deletion';
  end if;
  perform 1 from public.customers c where c.id=customer_id and c.anonymized_at is null for no key update nowait;
  if not found then raise exception using errcode='PT404', message='active customer not found'; end if;
  select * into v_address from public.addresses a
    where a.id=address_id and a.customer_id=delete_customer_address.customer_id for update nowait;
  if not found then raise exception using errcode='PT404', message='address not found'; end if;
  if v_address.updated_at is distinct from expected_updated_at then
    raise exception using errcode='PT409', message='address was modified; reread before deleting';
  end if;
  delete from public.addresses a where a.id=address_id;
  update public.customers c set updated_at=now() where c.id=customer_id;
  return public.get_admin_customer(customer_id);
end;
$$;

CREATE FUNCTION private.admin_location_json(p_location public.locations) RETURNS jsonb
    LANGUAGE sql STABLE STRICT SET search_path TO '' AS $$
  select jsonb_build_object('id',p_location.id,'code',p_location.code,'name',p_location.name,
    'address',p_location.address,'is_default',p_location.is_default,'is_active',p_location.is_active,
    'revision',p_location.revision,'created_at',p_location.created_at);
$$;

CREATE FUNCTION public.get_admin_location(location_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  return (select private.admin_location_json(l) from public.locations l where l.id=location_id);
end;
$$;

CREATE FUNCTION public.list_admin_locations(page_size integer DEFAULT 20, after_id uuid DEFAULT NULL,
    active boolean DEFAULT NULL, search text DEFAULT NULL) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
declare v_items jsonb; v_next uuid;
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if page_size is null or page_size not between 1 and 100 or length(search)>200 then
    raise exception using errcode='22023', message='invalid location list filters';
  end if;
  with candidates as materialized (
    select l as location,l.id from public.locations l where (after_id is null or l.id>after_id)
      and (active is null or l.is_active=active)
      and (nullif(btrim(search),'') is null or strpos(lower(l.name),lower(btrim(search)))>0
        or strpos(lower(l.code),lower(btrim(search)))>0)
    order by l.id limit page_size+1
  ), page as materialized (select * from candidates order by id limit page_size)
  select coalesce(jsonb_agg(private.admin_location_json(p.location) order by p.id),'[]'::jsonb),
    case when (select count(*) from candidates)>page_size then (select id from page order by id desc limit 1) end
  into v_items,v_next from page p;
  return jsonb_build_object('items',v_items,'next_cursor',v_next);
end;
$$;

CREATE FUNCTION public.list_admin_inventory_movements(page_size integer DEFAULT 20, after_id text DEFAULT NULL,
    variant_id uuid DEFAULT NULL, location_id uuid DEFAULT NULL, order_id uuid DEFAULT NULL,
    reason_filter text DEFAULT NULL) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
declare v_items jsonb; v_next text; v_after bigint;
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if page_size is null or page_size not between 1 and 100
    or (after_id is not null and (length(after_id)>19 or after_id !~ '^[1-9][0-9]*$'))
    or (reason_filter is not null and reason_filter not in ('order','cancel','restock','adjust','return','transfer_out','transfer_in')) then
    raise exception using errcode='22023', message='invalid inventory movement filters';
  end if;
  begin v_after := after_id::bigint;
  exception when numeric_value_out_of_range then
    raise exception using errcode='22023', message='invalid inventory movement cursor';
  end;
  with candidates as materialized (
    select m.* from public.inventory_movements m where (v_after is null or m.id<v_after)
      and (list_admin_inventory_movements.variant_id is null or m.variant_id=list_admin_inventory_movements.variant_id)
      and (list_admin_inventory_movements.location_id is null or m.location_id=list_admin_inventory_movements.location_id)
      and (list_admin_inventory_movements.order_id is null or m.order_id=list_admin_inventory_movements.order_id)
      and (reason_filter is null or m.reason=reason_filter)
    order by m.id desc limit page_size+1
  ), page as materialized (select * from candidates order by id desc limit page_size)
  select coalesce(jsonb_agg(jsonb_build_object('id',p.id::text,'variant_id',p.variant_id,
    'location_id',p.location_id,'delta',p.delta,'on_hand_after',p.on_hand_after,'reason',p.reason,
    'order_id',p.order_id,'actor_id',p.actor_id,'note',p.note,'transfer_id',p.transfer_id,'created_at',p.created_at) order by p.id desc),'[]'::jsonb),
    case when (select count(*) from candidates)>page_size then (select id::text from page order by id limit 1) end
  into v_items,v_next from page p;
  return jsonb_build_object('items',v_items,'next_cursor',v_next);
end;
$$;

CREATE FUNCTION private.bump_location_revision() RETURNS trigger
    LANGUAGE plpgsql SET search_path TO '' AS $$
begin
  if tg_op='INSERT' then new.revision := 1;
  elsif (to_jsonb(new)-'revision') is distinct from (to_jsonb(old)-'revision') then
    new.revision := old.revision+1;
  else new.revision := old.revision;
  end if;
  return new;
end;
$$;

CREATE FUNCTION public.update_location(location_id uuid, expected_revision integer, changes jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare v_location public.locations; v_new public.locations; v_key text; v_value jsonb;
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if location_id is null or expected_revision is null or expected_revision<1
    or jsonb_typeof(changes) is distinct from 'object' or octet_length(changes::text)>262144 then
    raise exception using errcode='22023', message='invalid location patch';
  end if;
  for v_key,v_value in select * from jsonb_each(changes) loop
    if v_key not in ('code','name','address','is_active')
      or (v_key in ('code','name') and (jsonb_typeof(v_value)<>'string' or btrim(v_value#>>'{}')=''))
      or (v_key='is_active' and jsonb_typeof(v_value)<>'boolean') then
      raise exception using errcode='22023', message='unknown or invalid location field';
    end if;
  end loop;
  -- Low-volume configuration commands serialize with ALL table writers,
  -- including legacy direct updates, before taking row locks. Readers continue.
  lock table public.locations in share row exclusive mode nowait;
  select * into v_location from public.locations l where l.id=location_id for update nowait;
  if not found then raise exception using errcode='PT404', message='location not found'; end if;
  if v_location.revision<>expected_revision then
    raise exception using errcode='PT409', message='location was modified';
  end if;
  v_new := jsonb_populate_record(v_location,changes);
  if v_location.is_default and v_location.is_active and not v_new.is_active then
    raise exception using errcode='PT409', message='switch default location before deactivation';
  end if;
  -- Reactivation must not implicitly restore a legacy inactive default flag.
  if not v_location.is_active and v_new.is_active then v_new.is_default := false; end if;
  if v_new is distinct from v_location then
    update public.locations l set code=v_new.code,name=v_new.name,address=v_new.address,
      is_active=v_new.is_active,is_default=v_new.is_default
      where l.id=location_id returning * into v_location;
  end if;
  return private.admin_location_json(v_location);
end;
$$;

CREATE FUNCTION public.create_location(location_id uuid, changes jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if location_id is null or jsonb_typeof(changes) is distinct from 'object'
    or jsonb_typeof(changes->'code') is distinct from 'string'
    or jsonb_typeof(changes->'name') is distinct from 'string' then
    raise exception using errcode='22023', message='location id, code and name required';
  end if;
  lock table public.locations in share row exclusive mode nowait;
  insert into public.locations(id,code,name) values(location_id,changes->>'code',changes->>'name');
  return public.update_location(location_id,1,changes);
end;
$$;

CREATE FUNCTION public.set_default_location(location_id uuid, expected_revision integer, expected_default_id uuid DEFAULT NULL) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare v_location public.locations; v_default uuid;
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if location_id is null or expected_revision is null or expected_revision<1 then
    raise exception using errcode='22023', message='invalid default location command';
  end if;
  lock table public.locations in share row exclusive mode nowait;
  select * into v_location from public.locations l where l.id=location_id for update nowait;
  if not found then raise exception using errcode='PT404', message='location not found'; end if;
  select l.id into v_default from public.locations l where l.is_default and l.is_active;
  if v_location.revision<>expected_revision or v_default is distinct from expected_default_id then
    raise exception using errcode='PT409', message='location or default selection was modified';
  end if;
  if not v_location.is_active then
    raise exception using errcode='PT409', message='default location must be active';
  end if;
  update public.locations l set is_default=false where l.is_default and l.id<>location_id;
  if not v_location.is_default then
    update public.locations l set is_default=true where l.id=location_id returning * into v_location;
  end if;
  return private.admin_location_json(v_location);
end;
$$;

CREATE FUNCTION private.assert_inventory_transfer() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
begin
  if new.transfer_id is null then return null; end if;
  if not exists (
    select 1 from public.inventory_movements o join public.inventory_movements i on i.transfer_id=o.transfer_id
    where o.transfer_id=new.transfer_id and o.reason='transfer_out' and i.reason='transfer_in'
      and o.variant_id=i.variant_id and o.location_id<>i.location_id and o.delta::bigint+i.delta::bigint=0
  ) then raise exception using errcode='23514', message='transfer requires a balanced pair of movements'; end if;
  return null;
end;
$$;

CREATE FUNCTION public.get_inventory_transfer(transfer_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
begin
  if not public.is_admin() then raise exception using errcode='42501', message='admin only'; end if;
  return (select jsonb_build_object('id',o.transfer_id,'variant_id',o.variant_id,
    'from_location_id',o.location_id,'to_location_id',i.location_id,'quantity',i.delta,
    'from_on_hand_after',o.on_hand_after,'to_on_hand_after',i.on_hand_after,
    'out_movement_id',o.id::text,'in_movement_id',i.id::text,'actor_id',o.actor_id,'note',o.note,'created_at',o.created_at)
    from public.inventory_movements o join public.inventory_movements i on i.transfer_id=o.transfer_id
    where o.transfer_id=get_inventory_transfer.transfer_id and o.reason='transfer_out' and i.reason='transfer_in');
end;
$$;

CREATE FUNCTION public.transfer_inventory(variant_id uuid, from_location_id uuid, to_location_id uuid,
    quantity integer, idempotency_key text, note text DEFAULT NULL) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare
  v_key text := btrim(idempotency_key); v_hash text; v_record commerce.command_idempotency;
  v_subject constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  v_transfer uuid := gen_random_uuid(); v_location uuid; v_count integer := 0;
  v_from integer; v_to integer; v_tracked boolean;
begin
  if not public.is_admin() then raise exception using errcode='42501', message='admin only'; end if;
  -- Reservation creation may only lock (not update) a stock row. A transaction
  -- snapshot could therefore miss reservations committed while this command waited.
  if current_setting('transaction_isolation')<>'read committed' then
    raise exception using errcode='25001', message='inventory transfer requires READ COMMITTED';
  end if;
  if variant_id is null or from_location_id is null or to_location_id is null or from_location_id=to_location_id
    or quantity is null or quantity<=0 or coalesce(v_key,'')='' or length(v_key)>200 or length(note)>2000 then
    raise exception using errcode='22023', message='invalid inventory transfer';
  end if;
  v_hash := private.command_request_hash(jsonb_build_object('variant_id',variant_id,'from_location_id',from_location_id,
    'to_location_id',to_location_id,'quantity',quantity,'note',note));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('inventory.transfer:'||v_subject||':'||v_key,0));
  select * into v_record from commerce.command_idempotency c
    where c.scope='inventory.transfer' and c.subject_id=v_subject and c.idempotency_key=v_key;
  if found then
    if v_record.request_hash<>v_hash then raise exception using errcode='PT409', message='idempotency key parameter conflict'; end if;
    return public.get_inventory_transfer(v_record.resource_id);
  end if;
  select v.track_inventory into v_tracked from public.product_variants v where v.id=variant_id for share;
  if not found then raise exception using errcode='PT404', message='variant not found'; end if;
  if not v_tracked then raise exception using errcode='22023', message='variant must track inventory'; end if;
  -- Stable lock order for opposing transfers, including creation of missing levels.
  for v_location in select l.id from public.locations l where l.id in (from_location_id,to_location_id)
      and l.is_active order by l.id for share loop
    v_count := v_count+1;
  end loop;
  if v_count<>2 then raise exception using errcode='PT409', message='both warehouses must exist and be active'; end if;
  for v_location in select l.id from public.locations l where l.id in (from_location_id,to_location_id) order by l.id loop
    insert into public.inventory_levels(variant_id,location_id,on_hand) values(variant_id,v_location,0)
      on conflict on constraint inventory_levels_pkey do nothing;
    perform 1 from public.inventory_levels il where il.variant_id=transfer_inventory.variant_id and il.location_id=v_location for update;
  end loop;
  select il.on_hand into v_from from public.inventory_levels il where il.variant_id=transfer_inventory.variant_id and il.location_id=from_location_id;
  if v_from-private.active_reserved_quantity(variant_id,from_location_id,null)<quantity then
    raise exception using errcode='PT409', message='insufficient available inventory';
  end if;
  update public.inventory_levels il set on_hand=il.on_hand-quantity
    where il.variant_id=transfer_inventory.variant_id and il.location_id=from_location_id returning on_hand into v_from;
  update public.inventory_levels il set on_hand=il.on_hand+quantity
    where il.variant_id=transfer_inventory.variant_id and il.location_id=to_location_id returning on_hand into v_to;
  insert into public.inventory_movements(variant_id,location_id,delta,on_hand_after,reason,actor_id,note,transfer_id)
    values(variant_id,from_location_id,-quantity,v_from,'transfer_out',auth.uid(),note,v_transfer),
          (variant_id,to_location_id,quantity,v_to,'transfer_in',auth.uid(),note,v_transfer);
  insert into commerce.command_idempotency(scope,subject_id,idempotency_key,request_hash,resource_type,resource_id)
    values('inventory.transfer',v_subject,v_key,v_hash,'inventory_transfer',v_transfer);
  return public.get_inventory_transfer(v_transfer);
end;
$$;

CREATE FUNCTION private.admin_promotion_json(p public.promotions) RETURNS jsonb
    LANGUAGE sql STABLE STRICT SET search_path TO '' AS $$
  select jsonb_build_object('id',p.id,'revision',p.revision,'name',p.name,'code',p.code,'type',p.type,'params',p.params,
    'priority',p.priority,'stackable',p.stackable,'apply_scope',p.apply_scope,'get_scope',p.get_scope,
    'usage_limit',p.usage_limit,'used_count',p.used_count,'per_customer_limit',p.per_customer_limit,
    'starts_at',p.starts_at,'ends_at',p.ends_at,'is_active',p.is_active,
    'created_at',p.created_at,'updated_at',p.updated_at);
$$;

CREATE FUNCTION public.get_admin_promotion(promotion_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  return (select private.admin_promotion_json(p) from public.promotions p where p.id=promotion_id);
end;
$$;

CREATE FUNCTION public.list_admin_promotions(page_size integer DEFAULT 20, after_id uuid DEFAULT NULL,
    active boolean DEFAULT NULL, type_filter text DEFAULT NULL, code_only boolean DEFAULT NULL,
    search text DEFAULT NULL) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
declare v_items jsonb; v_next uuid;
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if page_size is null or page_size not between 1 and 100 or length(search)>200
    or (type_filter is not null and type_filter not in
      ('order_percentage','order_fixed','item_percentage','buy_x_get_y','free_shipping')) then
    raise exception using errcode='22023', message='invalid promotion list filters';
  end if;
  with candidates as materialized (
    select p as promotion,p.id from public.promotions p where (after_id is null or p.id>after_id)
      and (active is null or p.is_active=active) and (type_filter is null or p.type=type_filter)
      and (code_only is null or (p.code is not null)=code_only)
      and (nullif(btrim(search),'') is null or strpos(lower(p.name),lower(btrim(search)))>0
        or strpos(lower(p.code),lower(btrim(search)))>0)
    order by p.id limit page_size+1
  ), page as materialized (select * from candidates order by id limit page_size)
  select coalesce(jsonb_agg(private.admin_promotion_json(p.promotion) order by p.id),'[]'::jsonb),
    case when (select count(*) from candidates)>page_size then (select id from page order by id desc limit 1) end
  into v_items,v_next from page p;
  return jsonb_build_object('items',v_items,'next_cursor',v_next);
end;
$$;

CREATE FUNCTION public.list_admin_promotion_targets(promotion_id uuid, page_size integer DEFAULT 20,
    after_id uuid DEFAULT NULL, role_filter text DEFAULT NULL) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
declare v_items jsonb; v_next uuid;
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if promotion_id is null or page_size is null or page_size not between 1 and 100
    or (role_filter is not null and role_filter not in ('apply','get')) then
    raise exception using errcode='22023', message='invalid promotion target filters';
  end if;
  with candidates as materialized (
    select t.* from public.promotion_targets t where t.promotion_id=list_admin_promotion_targets.promotion_id
      and (after_id is null or t.id>after_id) and (role_filter is null or t.role=role_filter)
    order by t.id limit page_size+1
  ), page as materialized (select * from candidates order by id limit page_size)
  select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'promotion_id',p.promotion_id,'role',p.role,
    'product_id',p.product_id,'category_id',p.category_id,'variant_id',p.variant_id) order by p.id),'[]'::jsonb),
    case when (select count(*) from candidates)>page_size then (select id from page order by id desc limit 1) end
  into v_items,v_next from page p;
  return jsonb_build_object('items',v_items,'next_cursor',v_next);
end;
$$;

CREATE FUNCTION public.list_admin_discount_redemptions(promotion_id uuid, page_size integer DEFAULT 20,
    after_id uuid DEFAULT NULL, customer_id uuid DEFAULT NULL, order_id uuid DEFAULT NULL) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
declare v_items jsonb; v_next uuid;
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if promotion_id is null or page_size is null or page_size not between 1 and 100 then
    raise exception using errcode='22023', message='invalid redemption filters';
  end if;
  with candidates as materialized (
    select r.* from public.discount_redemptions r where r.promotion_id=list_admin_discount_redemptions.promotion_id
      and (after_id is null or r.id>after_id)
      and (list_admin_discount_redemptions.customer_id is null or r.customer_id=list_admin_discount_redemptions.customer_id)
      and (list_admin_discount_redemptions.order_id is null or r.order_id=list_admin_discount_redemptions.order_id)
    order by r.id limit page_size+1
  ), page as materialized (select * from candidates order by id limit page_size)
  select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'promotion_id',p.promotion_id,
    'customer_id',p.customer_id,'order_id',p.order_id,'created_at',p.created_at) order by p.id),'[]'::jsonb),
    case when (select count(*) from candidates)>page_size then (select id from page order by id desc limit 1) end
  into v_items,v_next from page p;
  return jsonb_build_object('items',v_items,'next_cursor',v_next);
end;
$$;

CREATE FUNCTION private.bump_promotion_revision() RETURNS trigger
    LANGUAGE plpgsql SET search_path TO '' AS $$
begin
  -- Target guards touch the parent even when scopes/timestamps do not change.
  -- Every parent UPDATE must fence stale aggregate edits, including legacy writes.
  if tg_op='INSERT' then new.revision := 1; else new.revision := old.revision+1; end if;
  return new;
end;
$$;

CREATE FUNCTION public.update_promotion(promotion_id uuid, expected_revision integer, changes jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare v_old public.promotions; v_new public.promotions; v_key text; v_value jsonb; v_target jsonb;
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if promotion_id is null or expected_revision is null or expected_revision<1
    or jsonb_typeof(changes) is distinct from 'object' or octet_length(changes::text)>262144 then
    raise exception using errcode='22023', message='invalid promotion patch';
  end if;
  for v_key,v_value in select * from jsonb_each(changes) loop
    if v_key not in ('name','code','type','params','priority','stackable','apply_scope','get_scope',
      'usage_limit','per_customer_limit','starts_at','ends_at','is_active','targets')
      or (v_key in ('name','type','apply_scope','get_scope') and jsonb_typeof(v_value)<>'string')
      or (v_key in ('code','starts_at','ends_at') and jsonb_typeof(v_value) not in ('string','null'))
      or (v_key in ('stackable','is_active') and jsonb_typeof(v_value)<>'boolean')
      or (v_key='params' and jsonb_typeof(v_value)<>'object')
      or (v_key='targets' and jsonb_typeof(v_value)<>'array')
      or (v_key in ('priority','per_customer_limit') and jsonb_typeof(v_value)<>'number')
      or (v_key='usage_limit' and jsonb_typeof(v_value) not in ('number','null')) then
      raise exception using errcode='22023', message='unknown or invalid promotion field';
    end if;
    if v_key in ('priority','per_customer_limit','usage_limit') and jsonb_typeof(v_value)='number'
      and (v_value#>>'{}')::numeric<>trunc((v_value#>>'{}')::numeric) then
      raise exception using errcode='22023', message='promotion limits and priority must be integers';
    end if;
  end loop;
  if changes ? 'type' and not changes ? 'params' then
    raise exception using errcode='22023', message='type changes require complete params';
  end if;
  if changes ? 'targets' then
    if jsonb_array_length(changes->'targets')>100 then
      raise exception using errcode='22023', message='at most 100 targets per replacement';
    end if;
    for v_target in select value from jsonb_array_elements(changes->'targets') loop
      if jsonb_typeof(v_target)<>'object' then
        raise exception using errcode='22023', message='target must be an object';
      end if;
      if v_target-'role'-'product_id'-'category_id'-'variant_id'<>'{}'::jsonb
        or coalesce(v_target->>'role','') not in ('apply','get')
        or num_nonnulls(v_target->>'product_id',v_target->>'category_id',v_target->>'variant_id')<>1 then
        raise exception using errcode='22023', message='target requires role and exactly one reference';
      end if;
    end loop;
  end if;
  select * into v_old from public.promotions p where p.id=promotion_id for no key update nowait;
  if not found then raise exception using errcode='PT404', message='promotion not found'; end if;
  if v_old.revision<>expected_revision then
    raise exception using errcode='PT409', message='promotion was modified';
  end if;
  v_new := jsonb_populate_record(v_old,changes-'targets');
  if btrim(v_new.name)='' or not isfinite(v_new.starts_at) or not isfinite(v_new.ends_at) then
    raise exception using errcode='22023', message='invalid name or schedule';
  end if;
  if changes ? 'targets' then
    -- A supplied array replaces ALL roles; omission leaves associations untouched.
    -- Infer narrowing only; clearing a selected set never silently widens it.
    for v_key in select distinct value->>'role' from jsonb_array_elements(changes->'targets') loop
      if v_key='apply' then
        if changes ? 'apply_scope' and v_new.apply_scope<>'selected' then
          raise exception using errcode='22023', message='apply targets require selected scope';
        end if;
        v_new.apply_scope := 'selected';
      else
        if changes ? 'get_scope' and v_new.get_scope<>'selected' then
          raise exception using errcode='22023', message='get targets require selected scope';
        end if;
        v_new.get_scope := 'selected';
      end if;
    end loop;
    delete from public.promotion_targets t where t.promotion_id=update_promotion.promotion_id;
  end if;
  if v_new is distinct from v_old then
    update public.promotions p set name=v_new.name,code=v_new.code,type=v_new.type,params=v_new.params,
      priority=v_new.priority,stackable=v_new.stackable,apply_scope=v_new.apply_scope,get_scope=v_new.get_scope,
      usage_limit=v_new.usage_limit,per_customer_limit=v_new.per_customer_limit,
      starts_at=v_new.starts_at,ends_at=v_new.ends_at,is_active=v_new.is_active where p.id=promotion_id;
  end if;
  if changes ? 'targets' then
    insert into public.promotion_targets(promotion_id,role,product_id,category_id,variant_id)
      select update_promotion.promotion_id,value->>'role',(value->>'product_id')::uuid,
        (value->>'category_id')::uuid,(value->>'variant_id')::uuid
      from jsonb_array_elements(changes->'targets');
  end if;
  return public.get_admin_promotion(promotion_id);
end;
$$;

CREATE FUNCTION public.create_promotion(promotion_id uuid, changes jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if promotion_id is null or jsonb_typeof(changes) is distinct from 'object'
    or jsonb_typeof(changes->'name') is distinct from 'string'
    or jsonb_typeof(changes->'type') is distinct from 'string'
    or jsonb_typeof(changes->'params') is distinct from 'object' then
    raise exception using errcode='22023', message='promotion id, name, type and params required';
  end if;
  insert into public.promotions(id,name,type,params,is_active)
    values(promotion_id,changes->>'name',changes->>'type',changes->'params',false);
  return public.update_promotion(promotion_id,1,changes);
end;
$$;

CREATE FUNCTION private.bump_shipping_method_revision() RETURNS trigger
    LANGUAGE plpgsql SET search_path TO '' AS $$
begin
  if tg_op='INSERT' then new.revision := 1; else new.revision := old.revision+1; end if;
  return new;
end;
$$;

CREATE FUNCTION private.admin_shipping_method_json(s public.shipping_methods) RETURNS jsonb
    LANGUAGE sql STABLE STRICT SET search_path TO '' AS $$
  select jsonb_build_object('id',s.id,'revision',s.revision,'name',s.name,'description',s.description,
    'countries',s.countries,'price',s.price,'free_above',s.free_above,'estimated_days',s.estimated_days,
    'position',s.position,'is_active',s.is_active,'created_at',s.created_at,'updated_at',s.updated_at);
$$;

CREATE FUNCTION public.get_admin_shipping_method(shipping_method_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  return (select private.admin_shipping_method_json(s) from public.shipping_methods s where s.id=shipping_method_id);
end;
$$;

CREATE FUNCTION public.list_admin_shipping_methods(page_size integer DEFAULT 20, after_id uuid DEFAULT NULL,
    active boolean DEFAULT NULL, country text DEFAULT NULL, search text DEFAULT NULL) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
declare v_items jsonb; v_next uuid; v_country text;
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if page_size is null or page_size not between 1 and 100 or length(search)>200 then
    raise exception using errcode='22023', message='invalid shipping method filters';
  end if;
  if country is not null then v_country := private.normalize_country_code(country); end if;
  with candidates as materialized (
    select s as method,s.id from public.shipping_methods s where (after_id is null or s.id>after_id)
      and (active is null or s.is_active=active)
      and (v_country is null or cardinality(s.countries)=0 or v_country=any(s.countries))
      and (nullif(btrim(search),'') is null or strpos(lower(s.name),lower(btrim(search)))>0)
    order by s.id limit page_size+1
  ), page as materialized (select * from candidates order by id limit page_size)
  select coalesce(jsonb_agg(private.admin_shipping_method_json(p.method) order by p.id),'[]'::jsonb),
    case when (select count(*) from candidates)>page_size then (select id from page order by id desc limit 1) end
  into v_items,v_next from page p;
  return jsonb_build_object('items',v_items,'next_cursor',v_next);
end;
$$;

CREATE FUNCTION public.update_shipping_method(shipping_method_id uuid, expected_revision integer, changes jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare v_old public.shipping_methods; v_new public.shipping_methods; v_key text; v_value jsonb; v_number numeric;
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if shipping_method_id is null or expected_revision is null or expected_revision<1
    or jsonb_typeof(changes) is distinct from 'object' or octet_length(changes::text)>262144 then
    raise exception using errcode='22023', message='invalid shipping method patch';
  end if;
  for v_key,v_value in select * from jsonb_each(changes) loop
    if v_key not in ('name','description','countries','price','free_above','estimated_days','position','is_active')
      or (v_key in ('name','description','estimated_days') and jsonb_typeof(v_value)<>'string')
      or (v_key='countries' and jsonb_typeof(v_value)<>'array')
      or (v_key in ('price','position') and jsonb_typeof(v_value)<>'number')
      or (v_key='free_above' and jsonb_typeof(v_value) not in ('number','null'))
      or (v_key='is_active' and jsonb_typeof(v_value)<>'boolean') then
      raise exception using errcode='22023', message='unknown or invalid shipping method field';
    end if;
    if v_key='countries' and exists (select 1 from jsonb_array_elements(v_value) e where jsonb_typeof(e.value)<>'string') then
      raise exception using errcode='22023', message='countries must contain only country code strings';
    end if;
    if v_key in ('price','free_above') and jsonb_typeof(v_value)='number' then
      v_number := (v_value#>>'{}')::numeric;
      if v_number<0 or v_number>9999999999.99 or v_number<>round(v_number,2) then
        raise exception using errcode='22023', message='money must be nonnegative USD with at most two decimals';
      end if;
    end if;
    if v_key='position' and (v_value#>>'{}')::numeric<>trunc((v_value#>>'{}')::numeric) then
      raise exception using errcode='22023', message='position must be an integer';
    end if;
  end loop;
  select * into v_old from public.shipping_methods s where s.id=shipping_method_id for no key update nowait;
  if not found then raise exception using errcode='PT404', message='shipping method not found'; end if;
  if v_old.revision<>expected_revision then
    raise exception using errcode='PT409', message='shipping method was modified';
  end if;
  v_new := jsonb_populate_record(v_old,changes);
  if btrim(v_new.name)='' then raise exception using errcode='22023', message='shipping method name required'; end if;
  if v_new is distinct from v_old then
    update public.shipping_methods s set name=v_new.name,description=v_new.description,countries=v_new.countries,
      price=v_new.price,free_above=v_new.free_above,estimated_days=v_new.estimated_days,
      position=v_new.position,is_active=v_new.is_active where s.id=shipping_method_id;
  end if;
  return public.get_admin_shipping_method(shipping_method_id);
end;
$$;

CREATE FUNCTION public.create_shipping_method(shipping_method_id uuid, changes jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if shipping_method_id is null or jsonb_typeof(changes) is distinct from 'object'
    or jsonb_typeof(changes->'name') is distinct from 'string'
    or jsonb_typeof(changes->'price') is distinct from 'number' then
    raise exception using errcode='22023', message='shipping method id, name and price required';
  end if;
  insert into public.shipping_methods(id,name,is_active) values(shipping_method_id,changes->>'name',false);
  return public.update_shipping_method(shipping_method_id,1,changes);
end;
$$;

CREATE FUNCTION private.bump_tax_rate_revision() RETURNS trigger
    LANGUAGE plpgsql SET search_path TO '' AS $$
begin
  if tg_op='INSERT' then new.revision := 1; else new.revision := old.revision+1; end if;
  return new;
end;
$$;

CREATE FUNCTION private.admin_tax_rate_json(t public.tax_rates) RETURNS jsonb
    LANGUAGE sql STABLE STRICT SET search_path TO '' AS $$
  select jsonb_build_object('id',t.id,'revision',t.revision,'name',t.name,'country',t.country,
    'rate',t.rate,'include_shipping',t.include_shipping,'is_active',t.is_active,'created_at',t.created_at);
$$;

CREATE FUNCTION public.get_admin_tax_rate(tax_rate_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  return (select private.admin_tax_rate_json(t) from public.tax_rates t where t.id=tax_rate_id);
end;
$$;

CREATE FUNCTION public.list_admin_tax_rates(page_size integer DEFAULT 20, after_id uuid DEFAULT NULL,
    active boolean DEFAULT NULL, country text DEFAULT NULL, search text DEFAULT NULL) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
declare v_items jsonb; v_next uuid; v_country text;
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if page_size is null or page_size not between 1 and 100 or length(search)>200 then
    raise exception using errcode='22023', message='invalid tax rate filters';
  end if;
  if country is not null then v_country := private.normalize_country_code(country,true); end if;
  with candidates as materialized (
    select t as rule,t.id from public.tax_rates t where (after_id is null or t.id>after_id)
      and (active is null or t.is_active=active) and (v_country is null or t.country=v_country)
      and (nullif(btrim(search),'') is null or strpos(lower(t.name),lower(btrim(search)))>0)
    order by t.id limit page_size+1
  ), page as materialized (select * from candidates order by id limit page_size)
  select coalesce(jsonb_agg(private.admin_tax_rate_json(p.rule) order by p.id),'[]'::jsonb),
    case when (select count(*) from candidates)>page_size then (select id from page order by id desc limit 1) end
  into v_items,v_next from page p;
  return jsonb_build_object('items',v_items,'next_cursor',v_next);
end;
$$;

CREATE FUNCTION public.update_tax_rate(tax_rate_id uuid, expected_revision integer, changes jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare v_old public.tax_rates; v_new public.tax_rates; v_key text; v_value jsonb; v_rate numeric;
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if tax_rate_id is null or expected_revision is null or expected_revision<1
    or jsonb_typeof(changes) is distinct from 'object' or octet_length(changes::text)>262144 then
    raise exception using errcode='22023', message='invalid tax rate patch';
  end if;
  for v_key,v_value in select * from jsonb_each(changes) loop
    if v_key not in ('name','country','rate','include_shipping','is_active')
      or (v_key in ('name','country') and jsonb_typeof(v_value)<>'string')
      or (v_key='rate' and jsonb_typeof(v_value)<>'number')
      or (v_key in ('include_shipping','is_active') and jsonb_typeof(v_value)<>'boolean') then
      raise exception using errcode='22023', message='unknown or invalid tax rate field';
    end if;
    if v_key='rate' then
      v_rate := (v_value#>>'{}')::numeric;
      if v_rate<0 or v_rate>1 or v_rate<>round(v_rate,4) then
        raise exception using errcode='22023', message='rate must be a fraction between zero and one with at most four decimals';
      end if;
    end if;
  end loop;
  select * into v_old from public.tax_rates t where t.id=tax_rate_id for no key update nowait;
  if not found then raise exception using errcode='PT404', message='tax rate not found'; end if;
  if v_old.revision<>expected_revision then
    raise exception using errcode='PT409', message='tax rate was modified';
  end if;
  v_new := jsonb_populate_record(v_old,changes);
  if btrim(v_new.name)='' then raise exception using errcode='22023', message='tax rate name required'; end if;
  v_new.country := private.normalize_country_code(v_new.country,true);
  if v_new is distinct from v_old then
    update public.tax_rates t set name=v_new.name,country=v_new.country,rate=v_new.rate,
      include_shipping=v_new.include_shipping,is_active=v_new.is_active where t.id=tax_rate_id;
  end if;
  return public.get_admin_tax_rate(tax_rate_id);
end;
$$;

CREATE FUNCTION public.create_tax_rate(tax_rate_id uuid, changes jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if tax_rate_id is null or jsonb_typeof(changes) is distinct from 'object'
    or jsonb_typeof(changes->'name') is distinct from 'string'
    or jsonb_typeof(changes->'country') is distinct from 'string'
    or jsonb_typeof(changes->'rate') is distinct from 'number' then
    raise exception using errcode='22023', message='tax rate id, name, country and rate required';
  end if;
  insert into public.tax_rates(id,name,country,rate,is_active)
    values(tax_rate_id,changes->>'name',changes->>'country',0,false);
  return public.update_tax_rate(tax_rate_id,1,changes);
end;
$$;

CREATE FUNCTION private.admin_metafield_definition_json(d public.metafield_definitions) RETURNS jsonb
    LANGUAGE sql STABLE STRICT SET search_path TO '' AS $$
  select jsonb_build_object('id',d.id,'revision',d.revision,'owner_type',d.owner_type,'namespace',d.namespace,'key',d.key,
    'name',d.name,'type',d.type,'access',d.access,'description',d.description,'validations',d.validations,
    'position',d.position,'created_at',d.created_at,'updated_at',d.updated_at);
$$;

CREATE FUNCTION public.get_admin_metafield_definition(definition_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  return (select private.admin_metafield_definition_json(d) from public.metafield_definitions d where d.id=definition_id);
end;
$$;

CREATE FUNCTION public.list_admin_metafield_definitions(page_size integer DEFAULT 20, after_id uuid DEFAULT NULL,
    owner_type_filter text DEFAULT NULL, namespace_filter text DEFAULT NULL, access_filter text DEFAULT NULL) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
declare v_items jsonb; v_next uuid;
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if page_size is null or page_size not between 1 and 100
    or owner_type_filter not in ('product','variant','category','customer','order','shop')
    or access_filter not in ('admin','public','customer') then
    raise exception using errcode='22023', message='invalid metafield definition filters';
  end if;
  with candidates as materialized (
    select d as definition,d.id from public.metafield_definitions d where (after_id is null or d.id>after_id)
      and (owner_type_filter is null or d.owner_type=owner_type_filter)
      and (namespace_filter is null or d.namespace=namespace_filter)
      and (access_filter is null or d.access=access_filter)
    order by d.id limit page_size+1
  ), page as materialized (select * from candidates order by id limit page_size)
  select coalesce(jsonb_agg(private.admin_metafield_definition_json(p.definition) order by p.id),'[]'::jsonb),
    case when (select count(*) from candidates)>page_size then (select id from page order by id desc limit 1) end
  into v_items,v_next from page p;
  return jsonb_build_object('items',v_items,'next_cursor',v_next);
end;
$$;

CREATE FUNCTION public.list_admin_metafields(owner_type_filter text, owner_id_filter uuid,
    page_size integer DEFAULT 20, after_id uuid DEFAULT NULL, namespace_filter text DEFAULT NULL,
    key_filter text DEFAULT NULL) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
declare v_items jsonb; v_next uuid;
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if page_size is null or page_size not between 1 and 100 or owner_id_filter is null or owner_type_filter is null
    or owner_type_filter not in ('product','variant','category','customer','order','shop') then
    raise exception using errcode='22023', message='invalid metafield filters';
  end if;
  with candidates as materialized (
    select m.id,jsonb_build_object('id',m.id,'revision',m.revision,'owner_type',m.owner_type,'owner_id',m.owner_id,
      'namespace',m.namespace,'key',m.key,'type',m.type,'value',m.value,
      'created_at',m.created_at,'updated_at',m.updated_at,'definition_id',d.id,
      'definition_access',coalesce(d.access,'admin')) as dto
    from public.metafields m left join public.metafield_definitions d
      on (d.owner_type,d.namespace,d.key)=(m.owner_type,m.namespace,m.key)
    where m.owner_type=owner_type_filter and m.owner_id=owner_id_filter
      and (after_id is null or m.id>after_id)
      and (namespace_filter is null or m.namespace=namespace_filter)
      and (key_filter is null or m.key=key_filter)
    order by m.id limit page_size+1
  ), page as materialized (select * from candidates order by id limit page_size)
  select coalesce(jsonb_agg(p.dto order by p.id),'[]'::jsonb),
    case when (select count(*) from candidates)>page_size then (select id from page order by id desc limit 1) end
  into v_items,v_next from page p;
  return jsonb_build_object('items',v_items,'next_cursor',v_next);
end;
$$;

CREATE FUNCTION private.bump_metafield_definition_revision() RETURNS trigger
    LANGUAGE plpgsql SET search_path TO '' AS $$
begin
  if tg_op='INSERT' then new.revision := 1; else new.revision := old.revision+1; end if;
  return new;
end;
$$;

CREATE FUNCTION public.update_metafield_definition(definition_id uuid, expected_revision integer, changes jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare v_old public.metafield_definitions; v_new public.metafield_definitions; v_key text; v_value jsonb; v_kind text;
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if definition_id is null or expected_revision is null or expected_revision<1
    or jsonb_typeof(changes) is distinct from 'object' or octet_length(changes::text)>262144 then
    raise exception using errcode='22023', message='invalid metafield definition patch';
  end if;
  for v_key,v_value in select * from jsonb_each(changes) loop
    if v_key not in ('name','description','type','access','validations','position')
      or (v_key in ('name','description','type','access') and jsonb_typeof(v_value)<>'string')
      or (v_key='validations' and jsonb_typeof(v_value)<>'object')
      or (v_key='position' and jsonb_typeof(v_value)<>'number') then
      raise exception using errcode='22023', message='unknown or invalid metafield definition field';
    end if;
    if v_key='position' and (v_value#>>'{}')::numeric<>trunc((v_value#>>'{}')::numeric) then
      raise exception using errcode='22023', message='position must be an integer';
    end if;
  end loop;
  select * into v_old from public.metafield_definitions d where d.id=definition_id for no key update nowait;
  if not found then raise exception using errcode='PT404', message='metafield definition not found'; end if;
  if v_old.revision<>expected_revision then
    raise exception using errcode='PT409', message='metafield definition was modified';
  end if;
  v_new := jsonb_populate_record(v_old,changes);
  if btrim(v_new.name)='' or jsonb_typeof(v_new.validations)<>'object' then
    raise exception using errcode='22023', message='name and validation object required';
  end if;
  -- Only expose rules the existing validator actually enforces. Lists and JSON
  -- do not get a pretend choices validator; {} clears the entire rule set.
  for v_key,v_value in select * from jsonb_each(v_new.validations) loop
    if v_key in ('min','max') then
      if v_new.type<>'number' or jsonb_typeof(v_value)<>'number' then
        raise exception using errcode='22023', message='min/max require numeric bounds on number fields';
      end if;
    elsif v_key='choices' then
      v_kind := case when v_new.type='number' then 'number' when v_new.type='boolean' then 'boolean'
        when v_new.type in ('text','rich_text','date','datetime','url','color','metaobject_reference') then 'string' end;
      if v_kind is null or jsonb_typeof(v_value)<>'array' then
        raise exception using errcode='22023', message='choices require an array on a scalar field';
      end if;
      if exists (select 1 from jsonb_array_elements(v_value) e where jsonb_typeof(e.value)<>v_kind) then
        raise exception using errcode='22023', message='choice types must match the field type';
      end if;
    else
      raise exception using errcode='22023', message='unsupported metafield validation';
    end if;
  end loop;
  if (v_new.validations->>'min')::numeric>(v_new.validations->>'max')::numeric then
    raise exception using errcode='22023', message='min must not exceed max';
  end if;
  if v_new is distinct from v_old then
    update public.metafield_definitions d set name=v_new.name,description=v_new.description,type=v_new.type,
      access=v_new.access,validations=v_new.validations,position=v_new.position where d.id=definition_id;
  end if;
  return public.get_admin_metafield_definition(definition_id);
end;
$$;

CREATE FUNCTION public.create_metafield_definition(definition_id uuid, changes jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if definition_id is null or jsonb_typeof(changes) is distinct from 'object'
    or octet_length(changes::text)>262144
    or jsonb_typeof(changes->'owner_type') is distinct from 'string'
    or jsonb_typeof(changes->'key') is distinct from 'string'
    or jsonb_typeof(changes->'name') is distinct from 'string'
    or jsonb_typeof(changes->'type') is distinct from 'string'
    or (changes ? 'namespace' and jsonb_typeof(changes->'namespace')<>'string')
    or btrim(changes->>'key')='' or btrim(coalesce(changes->>'namespace','custom'))='' then
    raise exception using errcode='22023', message='definition identity, name and type required';
  end if;
  insert into public.metafield_definitions(id,owner_type,namespace,key,name,type)
    values(definition_id,changes->>'owner_type',coalesce(changes->>'namespace','custom'),changes->>'key',changes->>'name',changes->>'type');
  return public.update_metafield_definition(definition_id,1,changes-'owner_type'-'namespace'-'key');
end;
$$;

CREATE FUNCTION private.bump_metafield_revision() RETURNS trigger
    LANGUAGE plpgsql SET search_path TO '' AS $$
begin
  if tg_op='INSERT' then new.revision := 1; else new.revision := old.revision+1; end if;
  return new;
end;
$$;

CREATE FUNCTION public.create_metafield(metafield_id uuid, changes jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare v_row public.metafields; v_key text;
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if metafield_id is null or jsonb_typeof(changes) is distinct from 'object'
    or octet_length(changes::text)>262144 or not (changes ? 'value') then
    raise exception using errcode='22023', message='metafield identity, type and value required';
  end if;
  foreach v_key in array array['owner_type','owner_id','key','type'] loop
    if jsonb_typeof(changes->v_key) is distinct from 'string' then
      raise exception using errcode='22023', message='metafield identity and type must be strings';
    end if;
  end loop;
  if changes->>'owner_type' not in ('category','customer','order','shop')
    or (changes ? 'namespace' and jsonb_typeof(changes->'namespace')<>'string')
    or btrim(changes->>'key')='' or btrim(coalesce(changes->>'namespace','custom'))=''
    or exists (select 1 from jsonb_object_keys(changes) k
      where k not in ('owner_type','owner_id','namespace','key','type','value')) then
    raise exception using errcode='22023', message='invalid metafield identity or unknown field';
  end if;
  insert into public.metafields(id,owner_type,owner_id,namespace,key,type,value)
    values(metafield_id,changes->>'owner_type',(changes->>'owner_id')::uuid,
      coalesce(changes->>'namespace','custom'),changes->>'key',changes->>'type',changes->'value')
    returning * into v_row;
  return public.list_admin_metafields(v_row.owner_type,v_row.owner_id,1,null,v_row.namespace,v_row.key)->'items'->0;
end;
$$;

CREATE FUNCTION public.update_metafield(metafield_id uuid, expected_revision integer, changes jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare v_row public.metafields; v_type text; v_value jsonb;
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if metafield_id is null or expected_revision is null or expected_revision<1
    or jsonb_typeof(changes) is distinct from 'object' or octet_length(changes::text)>262144
    or (changes ? 'type' and jsonb_typeof(changes->'type')<>'string') then
    raise exception using errcode='22023', message='invalid metafield patch';
  end if;
  if exists (select 1 from jsonb_object_keys(changes) k where k not in ('type','value')) then
    raise exception using errcode='22023', message='metafield identity cannot be edited';
  end if;
  select * into v_row from public.metafields m where m.id=metafield_id for no key update nowait;
  if not found then raise exception using errcode='PT404', message='metafield not found'; end if;
  if v_row.owner_type not in ('category','customer','order','shop') then
    raise exception using errcode='22023', message='use the product aggregate command for catalog values';
  end if;
  if v_row.revision<>expected_revision then raise exception using errcode='PT409', message='metafield was modified'; end if;
  v_type := coalesce(changes->>'type',v_row.type);
  v_value := case when changes ? 'value' then changes->'value' else v_row.value end;
  if (v_type,v_value) is distinct from (v_row.type,v_row.value) then
    update public.metafields m set type=v_type,value=v_value where m.id=metafield_id;
  end if;
  return public.list_admin_metafields(v_row.owner_type,v_row.owner_id,1,null,v_row.namespace,v_row.key)->'items'->0;
end;
$$;

CREATE FUNCTION public.delete_metafield(metafield_id uuid, expected_revision integer) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare v_row public.metafields;
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if metafield_id is null or expected_revision is null or expected_revision<1 then
    raise exception using errcode='22023', message='metafield id and revision required';
  end if;
  select * into v_row from public.metafields m where m.id=metafield_id for update nowait;
  if not found then raise exception using errcode='PT404', message='metafield not found'; end if;
  if v_row.owner_type not in ('category','customer','order','shop') then
    raise exception using errcode='22023', message='use the product aggregate command for catalog values';
  end if;
  if v_row.revision<>expected_revision then raise exception using errcode='PT409', message='metafield was modified'; end if;
  perform private.lock_metafield_key(v_row.owner_type,v_row.namespace,v_row.key);
  delete from public.metafields m where m.id=metafield_id;
  return jsonb_build_object('id',metafield_id,'deleted',true);
end;
$$;

CREATE FUNCTION private.admin_metaobject_definition_json(d public.metaobject_definitions) RETURNS jsonb
    LANGUAGE sql STABLE STRICT SET search_path TO '' AS $$
  select jsonb_build_object('id',d.id,'revision',d.revision,'type',d.type,'name',d.name,'description',d.description,
    'fields',d.fields,'access',d.access,'is_active',d.is_active,'created_at',d.created_at,'updated_at',d.updated_at);
$$;

CREATE FUNCTION private.admin_metaobject_json(o public.metaobjects, d public.metaobject_definitions) RETURNS jsonb
    LANGUAGE sql STABLE STRICT SET search_path TO '' AS $$
  select jsonb_build_object('id',o.id,'revision',o.revision,'definition_id',o.definition_id,'handle',o.handle,'values',o.values,
    'status',o.status,'created_at',o.created_at,'updated_at',o.updated_at,'definition_type',d.type,
    'definition_access',d.access,'definition_is_active',d.is_active,
    'is_public',o.status='active' and d.is_active and d.access='public');
$$;

CREATE FUNCTION public.get_admin_metaobject_definition(definition_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  return (select private.admin_metaobject_definition_json(d) from public.metaobject_definitions d where d.id=definition_id);
end;
$$;

CREATE FUNCTION public.list_admin_metaobject_definitions(page_size integer DEFAULT 20, after_id uuid DEFAULT NULL,
    type_filter text DEFAULT NULL, access_filter text DEFAULT NULL, active boolean DEFAULT NULL) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
declare v_items jsonb; v_next uuid;
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if page_size is null or page_size not between 1 and 100 or access_filter not in ('admin','public') then
    raise exception using errcode='22023', message='invalid metaobject definition filters';
  end if;
  with candidates as materialized (
    select d as definition,d.id from public.metaobject_definitions d where (after_id is null or d.id>after_id)
      and (type_filter is null or d.type=type_filter) and (access_filter is null or d.access=access_filter)
      and (active is null or d.is_active=active)
    order by d.id limit page_size+1
  ), page as materialized (select * from candidates order by id limit page_size)
  select coalesce(jsonb_agg(private.admin_metaobject_definition_json(p.definition) order by p.id),'[]'::jsonb),
    case when (select count(*) from candidates)>page_size then (select id from page order by id desc limit 1) end
  into v_items,v_next from page p;
  return jsonb_build_object('items',v_items,'next_cursor',v_next);
end;
$$;

CREATE FUNCTION public.get_admin_metaobject(metaobject_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  return (select private.admin_metaobject_json(o,d) from public.metaobjects o
    join public.metaobject_definitions d on d.id=o.definition_id where o.id=metaobject_id);
end;
$$;

CREATE FUNCTION public.list_admin_metaobjects(definition_id_filter uuid, page_size integer DEFAULT 20,
    after_id uuid DEFAULT NULL, status_filter text DEFAULT NULL, handle_filter text DEFAULT NULL) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
declare v_items jsonb; v_next uuid;
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if definition_id_filter is null or page_size is null or page_size not between 1 and 100
    or status_filter not in ('draft','active') then
    raise exception using errcode='22023', message='invalid metaobject filters';
  end if;
  with candidates as materialized (
    select o.id,private.admin_metaobject_json(o,d) as dto from public.metaobjects o
      join public.metaobject_definitions d on d.id=o.definition_id
    where o.definition_id=definition_id_filter and (after_id is null or o.id>after_id)
      and (status_filter is null or o.status=status_filter) and (handle_filter is null or o.handle=handle_filter)
    order by o.id limit page_size+1
  ), page as materialized (select * from candidates order by id limit page_size)
  select coalesce(jsonb_agg(p.dto order by p.id),'[]'::jsonb),
    case when (select count(*) from candidates)>page_size then (select id from page order by id desc limit 1) end
  into v_items,v_next from page p;
  return jsonb_build_object('items',v_items,'next_cursor',v_next);
end;
$$;

CREATE FUNCTION private.lock_metaobject_definition(p_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
begin
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('metaobject:' || p_id::text,0)) then
    raise exception using errcode='55P03', message='metaobject definition is being modified; retry transaction';
  end if;
  insert into private.metaobject_definition_guards as g(definition_id) values(p_id)
    on conflict (definition_id) do update set revision=g.revision+1;
end;
$$;

CREATE FUNCTION private.assert_metaobject_fields(p_fields jsonb) RETURNS void
    LANGUAGE plpgsql IMMUTABLE SET search_path TO '' AS $$
declare f jsonb; k text; v jsonb; kind text; rules jsonb; seen text[] := ARRAY[]::text[];
begin
  if jsonb_typeof(p_fields) is distinct from 'array' or octet_length(p_fields::text)>262144 then
    raise exception using errcode='22023', message='fields must be an array up to 256 KiB';
  end if;
  if jsonb_array_length(p_fields)>100 then
    raise exception using errcode='22023', message='at most 100 fields allowed';
  end if;
  for f in select jsonb_array_elements(p_fields) loop
    if jsonb_typeof(f) is distinct from 'object' then
      raise exception using errcode='22023', message='field must be an object';
    end if;
    if jsonb_typeof(f->'key') is distinct from 'string' or btrim(f->>'key')=''
      or jsonb_typeof(f->'type') is distinct from 'string'
      or f->>'type' not in ('text','rich_text','number','boolean','date','datetime','url','color','json','list_text','list_number')
      or f->>'key'=any(seen)
      or exists(select 1 from jsonb_object_keys(f) x where x not in ('key','name','type','required','validations'))
      or (f ? 'name' and (jsonb_typeof(f->'name')<>'string' or btrim(f->>'name')=''))
      or (f ? 'required' and jsonb_typeof(f->'required')<>'boolean') then
      raise exception using errcode='22023', message='invalid or duplicate field declaration';
    end if;
    seen := array_append(seen,f->>'key');
    rules := coalesce(f->'validations','{}'::jsonb);
    if jsonb_typeof(rules)<>'object' then
      raise exception using errcode='22023', message='validations must be an object';
    end if;
    for k,v in select * from jsonb_each(rules) loop
      if k in ('min','max') then
        if f->>'type'<>'number' or jsonb_typeof(v)<>'number' then
          raise exception using errcode='22023', message='min/max require numeric bounds on number fields';
        end if;
      elsif k='choices' then
        kind := case when f->>'type'='number' then 'number' when f->>'type'='boolean' then 'boolean'
          when f->>'type' in ('text','rich_text','date','datetime','url','color') then 'string' end;
        if kind is null or jsonb_typeof(v)<>'array' then
          raise exception using errcode='22023', message='choices require an array on a scalar field';
        end if;
        if exists(select 1 from jsonb_array_elements(v) e where jsonb_typeof(e.value)<>kind) then
          raise exception using errcode='22023', message='choice types must match the field';
        end if;
      else
        raise exception using errcode='22023', message='unsupported field validation';
      end if;
    end loop;
    if (rules->>'min')::numeric>(rules->>'max')::numeric then
      raise exception using errcode='22023', message='min must not exceed max';
    end if;
  end loop;
end;
$$;

CREATE FUNCTION private.assert_metaobject_values(p_fields jsonb, p_values jsonb) RETURNS void
    LANGUAGE plpgsql STABLE SET search_path TO '' AS $$
declare f jsonb; v jsonb; t text; kind text;
begin
  if jsonb_typeof(p_values) is distinct from 'object' or octet_length(p_values::text)>262144 then
    raise exception using errcode='22023', message='values must be an object up to 256 KiB';
  end if;
  if exists(select 1 from jsonb_object_keys(p_values) k
    where not exists(select 1 from jsonb_array_elements(p_fields) declared where declared->>'key'=k)) then
    raise exception using errcode='22023', message='undeclared metaobject field';
  end if;
  for f in select jsonb_array_elements(p_fields) loop
    v := p_values->(f->>'key'); t := f->>'type';
    if coalesce((f->>'required')::boolean,false) and (v is null or v='null'::jsonb) then
      raise exception using errcode='22023', message='required metaobject field missing or null';
    end if;
    if v is null then continue; end if;
    kind := case when t='number' then 'number' when t='boolean' then 'boolean'
      when t in ('text','rich_text','date','datetime','url','color') then 'string'
      when t in ('list_text','list_number') then 'array' end;
    if kind is not null and jsonb_typeof(v)<>kind then
      raise exception using errcode='22023', message='metaobject value type mismatch';
    end if;
    if t in ('list_text','list_number') then
      if exists(select 1 from jsonb_array_elements(v) e
        where jsonb_typeof(e.value)<>case when t='list_text' then 'string' else 'number' end) then
        raise exception using errcode='22023', message='metaobject list element type mismatch';
      end if;
    elsif t in ('date','datetime') then
      begin
        if t='date' then perform (v#>>'{}')::date; else perform (v#>>'{}')::timestamptz; end if;
      exception when others then
        raise exception using errcode='22023', message='invalid metaobject date or datetime';
      end;
    end if;
    perform private.assert_metafield_validations(t,v,f->'validations',f->>'key');
  end loop;
end;
$$;

CREATE FUNCTION private.guard_metaobject_definition() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare v jsonb;
begin
  -- BEFORE triggers precede RLS WITH CHECK; reject API callers before validation.
  if (auth.role() in ('anon','authenticated') or current_setting('role') in ('anon','authenticated'))
    and not public.is_admin() then
    raise exception using errcode='42501', message='admin only';
  end if;
  if tg_op='UPDATE' and (new.id,new.type) is distinct from (old.id,old.type) then
    raise exception using errcode='22023', message='metaobject definition identity is immutable';
  end if;
  perform private.lock_metaobject_definition(case when tg_op='DELETE' then old.id else new.id end);
  if tg_op='DELETE' then return old; end if;
  if btrim(new.type)='' or btrim(new.name)='' then
    raise exception using errcode='22023', message='definition type and name must not be blank';
  end if;
  perform private.assert_metaobject_fields(new.fields);
  for v in select o.values from public.metaobjects o where o.definition_id=new.id loop
    perform private.assert_metaobject_values(new.fields,v);
  end loop;
  if tg_op='INSERT' then new.revision := 1; else new.revision := old.revision+1; end if;
  return new;
end;
$$;

CREATE FUNCTION private.guard_metaobject_values() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare v_fields jsonb;
begin
  if (auth.role() in ('anon','authenticated') or current_setting('role') in ('anon','authenticated'))
    and not public.is_admin() then
    raise exception using errcode='42501', message='admin only';
  end if;
  if tg_op='UPDATE' and (new.id,new.definition_id) is distinct from (old.id,old.definition_id) then
    raise exception using errcode='22023', message='metaobject identity and definition are immutable';
  end if;
  perform private.lock_metaobject_definition(case when tg_op='DELETE' then old.definition_id else new.definition_id end);
  if tg_op='DELETE' then return old; end if;
  select d.fields into v_fields from public.metaobject_definitions d where d.id=new.definition_id;
  if not found then raise exception using errcode='23503', message='metaobject definition not found'; end if;
  perform private.assert_metaobject_values(v_fields,new.values);
  if tg_op='INSERT' then new.revision := 1; else new.revision := old.revision+1; end if;
  return new;
end;
$$;

CREATE FUNCTION public.update_metaobject_definition(definition_id uuid, expected_revision integer, changes jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare v_old public.metaobject_definitions; v_new public.metaobject_definitions; k text; v jsonb;
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if definition_id is null or expected_revision is null or expected_revision<1
    or jsonb_typeof(changes) is distinct from 'object' or octet_length(changes::text)>262144 then
    raise exception using errcode='22023', message='invalid metaobject definition patch';
  end if;
  for k,v in select * from jsonb_each(changes) loop
    if k not in ('name','description','fields','access','is_active')
      or (k in ('name','description','access') and jsonb_typeof(v)<>'string')
      or (k='fields' and jsonb_typeof(v)<>'array') or (k='is_active' and jsonb_typeof(v)<>'boolean') then
      raise exception using errcode='22023', message='unknown or invalid definition field';
    end if;
  end loop;
  select * into v_old from public.metaobject_definitions d where d.id=definition_id for no key update nowait;
  if not found then raise exception using errcode='PT404', message='metaobject definition not found'; end if;
  if v_old.revision<>expected_revision then raise exception using errcode='PT409', message='definition was modified'; end if;
  v_new := jsonb_populate_record(v_old,changes);
  if v_new is distinct from v_old then
    update public.metaobject_definitions d set name=v_new.name,description=v_new.description,fields=v_new.fields,
      access=v_new.access,is_active=v_new.is_active where d.id=definition_id;
  end if;
  return public.get_admin_metaobject_definition(definition_id);
end;
$$;

CREATE FUNCTION public.create_metaobject_definition(definition_id uuid, changes jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if definition_id is null or jsonb_typeof(changes) is distinct from 'object' or octet_length(changes::text)>262144
    or jsonb_typeof(changes->'type') is distinct from 'string' or jsonb_typeof(changes->'name') is distinct from 'string'
    or jsonb_typeof(changes->'fields') is distinct from 'array' then
    raise exception using errcode='22023', message='definition id, type, name and fields required';
  end if;
  insert into public.metaobject_definitions(id,type,name,fields)
    values(definition_id,changes->>'type',changes->>'name',changes->'fields');
  return public.update_metaobject_definition(definition_id,1,changes-'type');
end;
$$;

CREATE FUNCTION public.update_metaobject(metaobject_id uuid, expected_revision integer, changes jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare v_old public.metaobjects; v_new public.metaobjects; k text; v jsonb;
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if metaobject_id is null or expected_revision is null or expected_revision<1
    or jsonb_typeof(changes) is distinct from 'object' or octet_length(changes::text)>262144 then
    raise exception using errcode='22023', message='invalid metaobject patch';
  end if;
  for k,v in select * from jsonb_each(changes) loop
    if k not in ('handle','values','status')
      or (k in ('handle','status') and jsonb_typeof(v)<>'string')
      or (k='values' and jsonb_typeof(v)<>'object') then
      raise exception using errcode='22023', message='unknown or invalid metaobject field';
    end if;
  end loop;
  select * into v_old from public.metaobjects o where o.id=metaobject_id for no key update nowait;
  if not found then raise exception using errcode='PT404', message='metaobject not found'; end if;
  if v_old.revision<>expected_revision then raise exception using errcode='PT409', message='metaobject was modified'; end if;
  v_new := jsonb_populate_record(v_old,changes);
  if btrim(v_new.handle)='' or v_new.status not in ('draft','active') then
    raise exception using errcode='22023', message='nonblank handle and draft/active status required';
  end if;
  if v_new is distinct from v_old then
    update public.metaobjects o set handle=v_new.handle,values=v_new.values,status=v_new.status where o.id=metaobject_id;
  end if;
  return public.get_admin_metaobject(metaobject_id);
end;
$$;

CREATE FUNCTION public.create_metaobject(metaobject_id uuid, changes jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if metaobject_id is null or jsonb_typeof(changes) is distinct from 'object' or octet_length(changes::text)>262144
    or jsonb_typeof(changes->'definition_id') is distinct from 'string'
    or jsonb_typeof(changes->'handle') is distinct from 'string'
    or jsonb_typeof(changes->'values') is distinct from 'object' then
    raise exception using errcode='22023', message='metaobject id, definition, handle and values required';
  end if;
  insert into public.metaobjects(id,definition_id,handle,values,status)
    values(metaobject_id,(changes->>'definition_id')::uuid,changes->>'handle',changes->'values','draft');
  return public.update_metaobject(metaobject_id,1,changes-'definition_id');
end;
$$;

CREATE FUNCTION public.delete_metaobject(metaobject_id uuid, expected_revision integer) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare v_row public.metaobjects;
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if metaobject_id is null or expected_revision is null or expected_revision<1 then
    raise exception using errcode='22023', message='metaobject id and revision required';
  end if;
  select * into v_row from public.metaobjects o where o.id=metaobject_id for update nowait;
  if not found then raise exception using errcode='PT404', message='metaobject not found'; end if;
  if v_row.revision<>expected_revision then raise exception using errcode='PT409', message='metaobject was modified'; end if;
  -- The existing trigger fences definition writers; real reference FKs protect
  -- target lifetime even against concurrent inserts and old snapshots.
  delete from public.metaobjects o where o.id=metaobject_id;
  return jsonb_build_object('id',metaobject_id,'deleted',true);
end;
$$;

CREATE FUNCTION public.delete_metaobject_definition(definition_id uuid, expected_revision integer) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare v_row public.metaobject_definitions;
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if definition_id is null or expected_revision is null or expected_revision<1 then
    raise exception using errcode='22023', message='definition id and revision required';
  end if;
  select * into v_row from public.metaobject_definitions d where d.id=definition_id for update nowait;
  if not found then raise exception using errcode='PT404', message='metaobject definition not found'; end if;
  if v_row.revision<>expected_revision then raise exception using errcode='PT409', message='definition was modified'; end if;
  -- Acquire the durable fence BEFORE inspecting children: a stale RR snapshot
  -- must not mistake a newly populated definition for empty and cascade-delete it.
  perform private.lock_metaobject_definition(definition_id);
  if exists(select 1 from public.metaobjects o where o.definition_id=delete_metaobject_definition.definition_id) then
    raise exception using errcode='23503', message='definition still has entries; delete them explicitly first';
  end if;
  delete from public.metaobject_definitions d where d.id=definition_id;
  return jsonb_build_object('id',definition_id,'deleted',true);
end;
$$;

CREATE FUNCTION private.bump_review_revision() RETURNS trigger
    LANGUAGE plpgsql SET search_path TO '' AS $$
begin
  if tg_op='INSERT' then new.revision:=1; else new.revision:=old.revision+1; end if;
  return new;
end;
$$;

CREATE FUNCTION public.list_admin_reviews(page_size integer DEFAULT 20, after_id uuid DEFAULT NULL,
    product_id_filter uuid DEFAULT NULL, customer_id_filter uuid DEFAULT NULL,
    status_filter text DEFAULT NULL, rating_filter integer DEFAULT NULL) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
declare v_items jsonb; v_next uuid;
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if page_size is null or page_size not between 1 and 100
    or (status_filter is not null and status_filter not in ('pending','approved','rejected'))
    or (rating_filter is not null and rating_filter not between 1 and 5) then
    raise exception using errcode='22023', message='invalid review filters';
  end if;
  with candidates as materialized (
    select r.id,r.revision,r.product_id,r.customer_id,r.rating,r.title,r.status,r.created_at,r.updated_at
    from public.product_reviews r
    where (after_id is null or r.id>after_id)
      and (product_id_filter is null or r.product_id=product_id_filter)
      and (customer_id_filter is null or r.customer_id=customer_id_filter)
      and (status_filter is null or r.status=status_filter)
      and (rating_filter is null or r.rating=rating_filter)
    order by r.id limit page_size+1
  ), page as materialized (select * from candidates order by id limit page_size)
  select coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]'::jsonb),
    case when (select count(*) from candidates)>page_size then (select id from page order by id desc limit 1) end
  into v_items,v_next from page p;
  return jsonb_build_object('items',v_items,'next_cursor',v_next);
end;
$$;

CREATE FUNCTION public.get_admin_review(review_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if review_id is null then raise exception using errcode='22023', message='review id required'; end if;
  return (select jsonb_build_object('id',r.id,'revision',r.revision,'product_id',r.product_id,
    'customer_id',r.customer_id,'rating',r.rating,'title',r.title,'body',r.body,'status',r.status,
    'created_at',r.created_at,'updated_at',r.updated_at) from public.product_reviews r where r.id=review_id);
end;
$$;

CREATE FUNCTION public.delete_review(review_id uuid, expected_revision integer) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare v_review public.product_reviews;
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if review_id is null or expected_revision is null or expected_revision<1 then
    raise exception using errcode='22023', message='review id and revision required';
  end if;
  select * into v_review from public.product_reviews r where r.id=review_id for update nowait;
  if not found then raise exception using errcode='PT404', message='review not found'; end if;
  if v_review.revision<>expected_revision then raise exception using errcode='PT409', message='review was modified'; end if;
  delete from public.product_reviews r where r.id=review_id;
  return jsonb_build_object('id',review_id,'deleted',true);
end;
$$;

CREATE FUNCTION public.list_admin_users(page_size integer DEFAULT 20, after_id uuid DEFAULT NULL,
    role_filter text DEFAULT NULL, search text DEFAULT NULL) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
declare v_items jsonb; v_next uuid; v_search text:=nullif(btrim(search),'');
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if page_size is null or page_size not between 1 and 100 or char_length(search)>200
    or (role_filter is not null and role_filter not in ('admin','customer')) then
    raise exception using errcode='22023', message='invalid user filters';
  end if;
  with candidates as materialized (
    select p.id as user_id,p.email,p.role,p.created_at,p.updated_at,c.id as customer_id,
      c.anonymized_at as customer_anonymized_at
    from public.profiles p left join public.customers c on c.auth_user_id=p.id
    where (after_id is null or p.id>after_id) and (role_filter is null or p.role=role_filter)
      and (v_search is null or strpos(lower(p.email),lower(v_search))>0)
    order by p.id limit page_size+1
  ), page as materialized (select * from candidates order by user_id limit page_size)
  select coalesce(jsonb_agg(to_jsonb(p) order by p.user_id),'[]'::jsonb),
    case when (select count(*) from candidates)>page_size then (select user_id from page order by user_id desc limit 1) end
  into v_items,v_next from page p;
  return jsonb_build_object('items',v_items,'next_cursor',v_next);
end;
$$;

CREATE FUNCTION public.get_admin_user(user_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if user_id is null then raise exception using errcode='22023', message='user id required'; end if;
  return (select jsonb_build_object('user_id',p.id,'email',p.email,'role',p.role,
    'created_at',p.created_at,'updated_at',p.updated_at,'customer_id',c.id,'customer_anonymized_at',c.anonymized_at)
    from public.profiles p left join public.customers c on c.auth_user_id=p.id where p.id=user_id);
end;
$$;

CREATE FUNCTION public.get_admin_shop_settings() RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  return (select jsonb_build_object('name',s.name,'timezone',s.timezone,'currency','USD',
    'revision',s.revision,'updated_at',s.updated_at) from private.shop_settings s where s.singleton);
end;
$$;

CREATE FUNCTION public.update_shop_settings(expected_revision integer, changes jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare v_old private.shop_settings; v_new private.shop_settings; v_key text; v_value jsonb;
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if expected_revision is null or expected_revision<1 or jsonb_typeof(changes) is distinct from 'object'
    or octet_length(changes::text)>8192 then
    raise exception using errcode='22023', message='invalid shop settings patch';
  end if;
  for v_key,v_value in select * from jsonb_each(changes) loop
    if v_key not in ('name','timezone') or jsonb_typeof(v_value)<>'string' then
      raise exception using errcode='22023', message='unknown or invalid shop settings field';
    end if;
  end loop;
  select * into strict v_old from private.shop_settings s where s.singleton for no key update nowait;
  if v_old.revision<>expected_revision then
    raise exception using errcode='PT409', message='shop settings were modified';
  end if;
  v_new := jsonb_populate_record(v_old,changes);
  if char_length(v_new.name) not between 1 and 200 or btrim(v_new.name)=''
    or char_length(v_new.timezone) not between 1 and 100
    or not exists (select 1 from pg_catalog.pg_timezone_names t where t.name=v_new.timezone) then
    raise exception using errcode='22023', message='invalid shop name or timezone';
  end if;
  if v_new is distinct from v_old then
    update private.shop_settings s set name=v_new.name,timezone=v_new.timezone,
      revision=s.revision+1,updated_at=clock_timestamp() where s.singleton;
  end if;
  return public.get_admin_shop_settings();
end;
$$;

-- Storage owns object identity. This projection is discovery, not a reference
-- registry or evidence that the underlying bytes exist or are safe to delete.
CREATE FUNCTION public.list_admin_product_media(product_id uuid, page_size integer DEFAULT 20,
    after_id uuid DEFAULT NULL) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
declare v_items jsonb; v_next uuid;
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if product_id is null or page_size is null or page_size not between 1 and 100 then
    raise exception using errcode='22023', message='invalid media list filters';
  end if;
  with candidates as materialized (
    select o.id,o.name from storage.objects o
    where o.bucket_id='catalog-media' and (after_id is null or o.id>after_id)
      and o.name like 'products/' || product_id::text || '/%'
      and o.name ~ ('^products/' || product_id::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$')
    order by o.id limit page_size+1
  ), page as materialized (select * from candidates order by id limit page_size)
  select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'product_id',product_id,
    'media_id',split_part(split_part(p.name,'/',3),'.',1)::uuid,'path',p.name,
    'expected_content_type',case split_part(p.name,'.',2)
      when 'jpg' then 'image/jpeg' when 'png' then 'image/png' else 'image/webp' end)
    order by p.id),'[]'::jsonb),
    case when (select count(*) from candidates)>page_size then (select id from page order by id desc limit 1) end
  into v_items,v_next from page p;
  return jsonb_build_object('items',v_items,'next_cursor',v_next);
end;
$$;

-- Source row locks and existing catalog/category revision guards serialize edits.
-- Deleting a source cascades its edge; transaction rollback restores both.
CREATE FUNCTION private.sync_catalog_media_url_ref() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare v_row jsonb := to_jsonb(new); v_url text;
begin
  if tg_table_name = 'product_images' then
    insert into private.catalog_media_url_refs(product_image_id,url)
      values ((v_row->>'id')::uuid,v_row->>'url')
      on conflict (product_image_id) do update set url=excluded.url;
  else
    v_url := v_row->>'image_url';
    if v_url is null then
      delete from private.catalog_media_url_refs where category_id=(v_row->>'id')::uuid;
    else
      insert into private.catalog_media_url_refs(category_id,url)
        values ((v_row->>'id')::uuid,v_url)
        on conflict (category_id) do update set url=excluded.url;
    end if;
  end if;
  return new;
end;
$$;

-- Only the authenticated Edge handler supplies actor_id. Never grant this
-- service command to authenticated: verification/publication are trusted facts.
CREATE FUNCTION public.managed_media_command(actor_id uuid, action text, media_id uuid DEFAULT NULL,
    request_id uuid DEFAULT NULL, content_type text DEFAULT NULL, byte_size integer DEFAULT NULL,
    sha256 text DEFAULT NULL) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare v_media private.managed_media;
begin
  if auth.role() is distinct from 'service_role' or not exists (
    select 1 from public.profiles p join auth.users u on u.id=p.id
    where p.id=actor_id and p.role='admin' and not coalesce(u.is_anonymous,true)
  ) then raise exception using errcode='42501', message='admin actor and service required'; end if;
  if action is null or action not in ('allocate','get','begin_upload','uploaded','verified','retain','discard','delete','deleted','published') then
    raise exception using errcode='22023', message='invalid media action';
  end if;
  if action='allocate' then
    if media_id is not null or request_id is null or content_type is null or byte_size is null or sha256 is null then
      raise exception using errcode='22023', message='invalid upload identity';
    end if;
    insert into private.managed_media(request_id,content_type,byte_size,sha256)
      values (request_id,content_type,byte_size,sha256) on conflict on constraint managed_media_request_id_key do nothing;
    select * into v_media from private.managed_media m where m.request_id=managed_media_command.request_id for update;
    if not found then raise exception using errcode='40001', message='retry media allocation'; end if;
    if v_media.content_type<>content_type or v_media.byte_size<>byte_size or v_media.sha256<>sha256 then
      raise exception using errcode='PT409', message='upload request content conflict';
    end if;
  else
    if media_id is null or request_id is not null or content_type is not null or byte_size is not null or sha256 is not null then
      raise exception using errcode='22023', message='invalid media identity';
    end if;
    select * into v_media from private.managed_media m where m.id=media_id for update;
    if not found then raise exception using errcode='PT404', message='media not found'; end if;
    if action='begin_upload' then
      if v_media.state<>'uploading' or v_media.upload_status<>'not_started' then
        raise exception using errcode='PT409', message='upload already admitted; recover without writing';
      end if;
      -- No expiry or reset: a timed-out Storage request may still write later.
      update private.managed_media set upload_status='pending' where id=media_id returning * into v_media;
    elsif action='uploaded' then
      if v_media.upload_status<>'pending' or v_media.state not in ('uploading','staged','retained') then
        raise exception using errcode='PT409', message='upload cannot be settled';
      end if;
      update private.managed_media set upload_status='settled',
        state=case when state='uploading' then 'staged' else state end
        where id=media_id returning * into v_media;
    elsif action='verified' then
      if v_media.state not in ('uploading','staged') then
        raise exception using errcode='PT409', message='media is frozen';
      end if;
      update private.managed_media set state='staged' where id=media_id returning * into v_media;
    elsif action='retain' then
      if v_media.state not in ('staged','retained') then
        raise exception using errcode='PT409', message='media cannot be published';
      end if;
      update private.managed_media set state='retained' where id=media_id returning * into v_media;
    elsif action='discard' then
      if v_media.state not in ('staged','discard_prepared','discarded') or v_media.upload_status<>'settled' then
        raise exception using errcode='PT409', message='media cannot be discarded';
      end if;
      update private.managed_media set state=case when state='discarded' then state else 'discard_prepared' end
        where id=media_id returning * into v_media;
    elsif action in ('delete','deleted') then
      if v_media.state not in ('discard_prepared','discarded') or v_media.upload_status<>'settled' then
        raise exception using errcode='PT409', message='media not prepared for deletion';
      end if;
      update private.managed_media set state=case when action='deleted' then 'discarded' else state end
        where id=media_id returning * into v_media;
    elsif action='published' then
      if v_media.state<>'retained' then raise exception using errcode='PT409', message='media not retained'; end if;
      update private.managed_media set published=true where id=media_id returning * into v_media;
    end if;
  end if;
  return jsonb_build_object('id',v_media.id,'request_id',v_media.request_id,'state',v_media.state,
    'content_type',v_media.content_type,'byte_size',v_media.byte_size,'sha256',v_media.sha256,
    'published',v_media.published,'upload_status',v_media.upload_status);
end;
$$;

commit;
