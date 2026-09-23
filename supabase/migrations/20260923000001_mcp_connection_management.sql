begin;

-- Durable intent, not a second source of grant validity. No credential payloads.
create table private.mcp_connection_revocations (
  grant_id uuid primary key references private.mcp_grants(id) on delete cascade,
  requested_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz
);
alter table private.mcp_connection_revocations enable row level security;
revoke all on private.mcp_connection_revocations from public, anon, authenticated, service_role;
create index mcp_connection_revocations_pending on private.mcp_connection_revocations(grant_id)
  where completed_at is null;
create index mcp_grants_user_id_id on private.mcp_grants(user_id,id);

-- Personal security remains available after admin demotion. It cannot grant access.
create function public.list_my_mcp_connections(page_size integer default 20, after_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_items jsonb; v_next uuid;
begin
  if auth.role() is distinct from 'authenticated' or not exists (
    select 1 from auth.users where id=auth.uid() and not coalesce(is_anonymous,true)
  ) then raise exception using errcode='42501', message='user session required'; end if;
  if page_size is null or page_size not between 1 and 100 then
    raise exception using errcode='22023', message='invalid page size';
  end if;
  with candidates as materialized (
    select g.*, r.requested_at, r.completed_at from private.mcp_grants g
    left join private.mcp_connection_revocations r on r.grant_id=g.id
    where g.user_id=auth.uid() and (after_id is null or g.id>after_id)
    order by g.id limit page_size+1
  ), page as (select * from candidates order by id limit page_size)
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',p.id,'client_id',p.binding->>'client_id','resource',p.binding->>'resource',
    'scopes',p.scopes,'state',p.state,'created_at',p.created_at,'revoked_at',p.revoked_at,
    'cleanup',case when p.completed_at is not null then 'completed'
      when p.requested_at is not null then 'pending' else 'not_requested' end
  ) order by p.id),'[]'::jsonb),
    case when (select count(*) from candidates)>page_size then (select id from page order by id desc limit 1) end
  into v_items,v_next from page p;
  return jsonb_build_object('items',v_items,'next_cursor',v_next);
end;
$$;

-- Explicit snapshot of IDs: retrying cannot revoke a newly-created connection.
-- Grant locks precede credential locks, matching the existing trusted RPCs.
create function public.revoke_my_mcp_connections(grant_ids uuid[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_ids uuid[]; v_found integer;
begin
  if auth.role() is distinct from 'authenticated' or not exists (
    select 1 from auth.users where id=auth.uid() and not coalesce(is_anonymous,true)
  ) then raise exception using errcode='42501', message='user session required'; end if;
  if grant_ids is null or cardinality(grant_ids) not between 1 and 100
    or array_position(grant_ids,null) is not null then
    raise exception using errcode='22023', message='explicit connection IDs required (1-100)';
  end if;
  select array_agg(distinct x order by x) into v_ids from unnest(grant_ids) x;
  perform id from private.mcp_grants
    where user_id=auth.uid() and id=any(v_ids) order by id for update;
  get diagnostics v_found = row_count;
  if v_found<>cardinality(v_ids) then
    raise exception using errcode='PT404', message='connection not found';
  end if;
  update private.mcp_grants set state='revoked',version=2,revoked_at=clock_timestamp()
    where id=any(v_ids) and state='active';
  delete from private.mcp_credentials where grant_id=any(v_ids);
  insert into private.mcp_connection_revocations(grant_id)
    select unnest(v_ids) on conflict do nothing;
  return jsonb_build_object('ids',v_ids,'state','revoked');
end;
$$;

-- Only the configured issuer host receives upstream IDs. Completion is an
-- idempotent acknowledgement AFTER its durable provider-family tombstone.
create function public.mcp_connection_cleanup_command(p_action text, p_issuer text,
  p_resource text, p_project text, p_grant_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_result jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='trusted authorization host required';
  end if;
  if p_action is null or p_action not in ('list','complete')
    or coalesce(p_issuer,'')='' or coalesce(p_resource,'')='' or coalesce(p_project,'')=''
    or (p_action='list' and p_grant_id is not null)
    or (p_action='complete' and p_grant_id is null) then
    raise exception using errcode='22023', message='invalid cleanup command';
  end if;
  if p_action='list' then
    select coalesce(jsonb_agg(jsonb_build_object('id',id,'upstream_grant_id',upstream_grant_id) order by id),'[]'::jsonb)
      into v_result from (
        select g.id,g.binding->>'session_id' as upstream_grant_id
        from private.mcp_connection_revocations r join private.mcp_grants g on g.id=r.grant_id
        where r.completed_at is null and g.state='revoked'
          and g.binding->>'issuer'=p_issuer and g.binding->>'resource'=p_resource
          and g.binding->>'project'=p_project
        order by g.id limit 20
      ) page;
    return v_result;
  end if;
  update private.mcp_connection_revocations r
    set completed_at=coalesce(r.completed_at,clock_timestamp())
    from private.mcp_grants g where g.id=r.grant_id and g.id=p_grant_id and g.state='revoked'
      and g.binding->>'issuer'=p_issuer and g.binding->>'resource'=p_resource
      and g.binding->>'project'=p_project;
  if not found then raise exception using errcode='PT404', message='cleanup not found'; end if;
  return jsonb_build_object('id',p_grant_id,'cleanup','completed');
end;
$$;

revoke all on function public.list_my_mcp_connections(integer,uuid) from public, anon, service_role;
revoke all on function public.revoke_my_mcp_connections(uuid[]) from public, anon, service_role;
grant execute on function public.list_my_mcp_connections(integer,uuid) to authenticated;
grant execute on function public.revoke_my_mcp_connections(uuid[]) to authenticated;
revoke all on function public.mcp_connection_cleanup_command(text,text,text,text,uuid) from public, anon, authenticated;
grant execute on function public.mcp_connection_cleanup_command(text,text,text,text,uuid) to service_role;
notify pgrst, 'reload schema';
commit;
