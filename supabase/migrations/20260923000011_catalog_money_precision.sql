-- Reject lossy catalog money conversion before jsonb_populate_record coerces
-- numeric JSON values into numeric(12,2). Direct table writes remain unchanged.
CREATE OR REPLACE FUNCTION private.apply_catalog_edit(p_product_id uuid, p_table text, p_change jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
declare
  v_allowed text[];
  v_id uuid;
  v_old jsonb;
  v_patch jsonb;
  v_columns text;
  v_assignments text;
  v_owner uuid;
  v_money_key text;
  v_money numeric;
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
  if p_table = 'product_variants' then
    foreach v_money_key in array array['price','compare_at_price','cost'] loop
      if p_change ? v_money_key and p_change -> v_money_key <> 'null'::jsonb then
        -- Preserve the RPC's existing numeric-string compatibility, but validate
        -- the exact numeric value before coercion into the table's decimal scale.
        v_money := (p_change ->> v_money_key)::numeric;
        if v_money < 0 or v_money > 9999999999.99 or round(v_money,2) <> v_money then
          raise exception using errcode = '22023', message = 'catalog money must be between 0 and 9999999999.99 with at most two decimal places';
        end if;
      end if;
    end loop;
    if p_change ? 'price' and p_change -> 'price' = 'null'::jsonb then
      raise exception using errcode = '22023', message = 'catalog price cannot be null';
    end if;
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
