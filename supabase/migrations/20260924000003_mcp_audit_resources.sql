begin;

alter table private.mcp_tool_audit
  add column resource_type text,
  add column resource_id uuid,
  add constraint mcp_tool_audit_resource_pair check ((resource_type is null) = (resource_id is null)),
  add constraint mcp_tool_audit_resource_type check (resource_type is null or resource_type in
    ('product','customer','order','location','promotion','checkout_quote','category','tax_rate','shipping_method','managed_media'));

drop function public.mcp_tool_audit_command(text,uuid,uuid,uuid,text,text,text,text,boolean,text);
create function public.mcp_tool_audit_command(p_action text, p_id uuid, p_grant_id uuid,
  p_user_id uuid, p_issuer text, p_resource text, p_project text,
  p_tool_name text default null, p_mutation boolean default null, p_outcome text default null,
  p_resource_type text default null, p_resource_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_grant private.mcp_grants; v_audit private.mcp_tool_audit;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='trusted MCP host required';
  end if;
  if p_id is null or p_grant_id is null or p_user_id is null
    or coalesce(p_issuer,'')='' or coalesce(p_resource,'')='' or coalesce(p_project,'')=''
    or p_action is null or p_action not in ('begin','finish') then
    raise exception using errcode='22023', message='invalid audit command';
  end if;
  if p_action='begin' then
    if p_tool_name is null or p_tool_name !~ '^[a-z][a-z0-9_]{0,79}$'
      or p_mutation is null or p_outcome is not null
      or (p_resource_type is null) <> (p_resource_id is null)
      or (p_resource_type is not null and (p_tool_name,p_resource_type) not in (
        ('get_admin_product','product'),('update_product','product'),('upload_product_media','product'),
        ('inspect_product_media','product'),('list_admin_product_media','product'),
        ('get_admin_customer','customer'),('update_customer','customer'),('anonymize_customer','customer'),('create_customer_address','customer'),
        ('update_customer_address','customer'),('delete_customer_address','customer'),
        ('get_admin_order','order'),('update_order_admin_note','order'),('cancel_order','order'),('mark_order_paid','order'),
        ('refund_paypal','order'),('preview_manual_refund','order'),('commit_manual_refund','order'),
        ('get_order_pricing','order'),('get_order_ledger','order'),('create_fulfillment','order'),
        ('get_admin_location','location'),('update_location','location'),('set_default_location','location'),
        ('get_admin_promotion','promotion'),('update_promotion','promotion'),
        ('get_admin_checkout_quote','checkout_quote'),('cancel_checkout_quote','checkout_quote'),
        ('get_admin_category','category'),('update_category','category'),
        ('get_admin_tax_rate','tax_rate'),('update_tax_rate','tax_rate'),
        ('get_admin_shipping_method','shipping_method'),('update_shipping_method','shipping_method'),
        ('get_managed_media','managed_media'),('recover_media_upload','managed_media'),('publish_managed_media','managed_media'),
        ('prepare_media_discard','managed_media'),('delete_managed_media','managed_media'),('recover_media_deletion','managed_media')
      )) then raise exception using errcode='22023', message='invalid audit admission'; end if;
    select * into v_grant from private.mcp_grants where id=p_grant_id and user_id=p_user_id
      and state='active' and binding->>'issuer'=p_issuer and binding->>'resource'=p_resource
      and binding->>'project'=p_project for share;
    if not found then raise exception using errcode='42501', message='active bound grant required'; end if;
    insert into private.mcp_tool_audit(id,user_id,grant_id,client_id,issuer,resource,project,tool_name,mutation,resource_type,resource_id)
      values(p_id,v_grant.user_id,v_grant.id,v_grant.binding->>'client_id',p_issuer,p_resource,p_project,p_tool_name,p_mutation,p_resource_type,p_resource_id)
      returning * into v_audit;
  else
    if p_tool_name is not null or p_mutation is not null or p_outcome is null
      or p_resource_type is not null or p_resource_id is not null
      or p_outcome not in ('returned','rejected','unknown') then
      raise exception using errcode='22023', message='invalid audit completion';
    end if;
    select * into v_audit from private.mcp_tool_audit where id=p_id and grant_id=p_grant_id
      and user_id=p_user_id and issuer=p_issuer and resource=p_resource and project=p_project for update;
    if not found then raise exception using errcode='PT404', message='audit admission not found'; end if;
    if v_audit.outcome not in ('pending',p_outcome) then
      raise exception using errcode='PT409', message='audit completion conflict';
    end if;
    update private.mcp_tool_audit set outcome=p_outcome,finished_at=coalesce(finished_at,clock_timestamp())
      where id=p_id returning * into v_audit;
  end if;
  return jsonb_build_object('id',v_audit.id,'outcome',v_audit.outcome);
end;
$$;
revoke all on function public.mcp_tool_audit_command(text,uuid,uuid,uuid,text,text,text,text,boolean,text,text,uuid)
  from public, anon, authenticated;
grant execute on function public.mcp_tool_audit_command(text,uuid,uuid,uuid,text,text,text,text,boolean,text,text,uuid)
  to service_role;

create or replace function public.list_my_mcp_tool_calls(page_size integer default 20,
  before_at timestamptz default null, before_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_items jsonb; v_cursor jsonb;
begin
  if auth.role() is distinct from 'authenticated' or not exists (
    select 1 from auth.users where id=auth.uid() and not coalesce(is_anonymous,true)
  ) then raise exception using errcode='42501', message='user session required'; end if;
  if page_size is null or page_size not between 1 and 100 or (before_at is null) <> (before_id is null)
    or (before_at is not null and not isfinite(before_at)) then
    raise exception using errcode='22023', message='invalid audit page'; end if;
  with candidates as materialized (
    select * from private.mcp_tool_audit where user_id=auth.uid()
      and (before_at is null or (admitted_at,id)<(before_at,before_id))
    order by admitted_at desc,id desc limit page_size+1
  ), page as (select * from candidates order by admitted_at desc,id desc limit page_size)
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',p.id,'grant_id',p.grant_id,'client_id',p.client_id,'resource',p.resource,
    'tool_name',p.tool_name,'mutation',p.mutation,'admitted_at',p.admitted_at,
    'finished_at',p.finished_at,'outcome',p.outcome,
    'resource_type',p.resource_type,'resource_id',p.resource_id
  ) order by p.admitted_at desc,p.id desc),'[]'::jsonb),
    case when (select count(*) from candidates)>page_size then
      (select jsonb_build_object('admitted_at',admitted_at,'id',id) from page order by admitted_at,id limit 1) end
  into v_items,v_cursor from page p;
  return jsonb_build_object('items',v_items,'next_cursor',v_cursor);
end;
$$;
notify pgrst, 'reload schema';
commit;
