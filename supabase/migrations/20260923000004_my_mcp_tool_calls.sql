begin;

-- Personal security, including after demotion; never accepts a user selector.
create function public.list_my_mcp_tool_calls(page_size integer default 20,
  before_at timestamptz default null, before_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_items jsonb; v_cursor jsonb;
begin
  if auth.role() is distinct from 'authenticated' or not exists (
    select 1 from auth.users where id=auth.uid() and not coalesce(is_anonymous,true)
  ) then raise exception using errcode='42501', message='user session required'; end if;
  if page_size is null or page_size not between 1 and 100
    or (before_at is null) <> (before_id is null)
    or (before_at is not null and not isfinite(before_at)) then
    raise exception using errcode='22023', message='invalid audit page';
  end if;
  with candidates as materialized (
    select * from private.mcp_tool_audit
    where user_id=auth.uid() and (before_at is null or (admitted_at,id)<(before_at,before_id))
    order by admitted_at desc,id desc limit page_size+1
  ), page as (select * from candidates order by admitted_at desc,id desc limit page_size)
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',p.id,'grant_id',p.grant_id,'client_id',p.client_id,'resource',p.resource,
    'tool_name',p.tool_name,'mutation',p.mutation,'admitted_at',p.admitted_at,
    'finished_at',p.finished_at,'outcome',p.outcome
  ) order by p.admitted_at desc,p.id desc),'[]'::jsonb),
    case when (select count(*) from candidates)>page_size then
      (select jsonb_build_object('admitted_at',admitted_at,'id',id)
       from page order by admitted_at,id limit 1) end
  into v_items,v_cursor from page p;
  return jsonb_build_object('items',v_items,'next_cursor',v_cursor);
end;
$$;
revoke all on function public.list_my_mcp_tool_calls(integer,timestamptz,uuid) from public,anon,service_role;
grant execute on function public.list_my_mcp_tool_calls(integer,timestamptz,uuid) to authenticated;
notify pgrst, 'reload schema';
commit;
