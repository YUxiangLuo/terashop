begin;

-- Trusted remote-host observations, NOT business transaction receipts. No payloads.
-- No cascading foreign keys: retain evidence after grant/account removal.
create table private.mcp_tool_audit (
  id uuid primary key,
  user_id uuid not null,
  grant_id uuid not null,
  client_id text not null,
  issuer text not null,
  resource text not null,
  project text not null,
  tool_name text not null,
  mutation boolean not null,
  admitted_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  outcome text not null default 'pending' check (outcome in ('pending','returned','rejected','unknown')),
  check ((outcome='pending') = (finished_at is null))
);
alter table private.mcp_tool_audit enable row level security;
revoke all on private.mcp_tool_audit from public, anon, authenticated, service_role;
create index mcp_tool_audit_user_time on private.mcp_tool_audit(user_id,admitted_at,id);

create function public.mcp_tool_audit_command(p_action text, p_id uuid, p_grant_id uuid,
  p_user_id uuid, p_issuer text, p_resource text, p_project text,
  p_tool_name text default null, p_mutation boolean default null, p_outcome text default null)
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
      or p_mutation is null or p_outcome is not null then
      raise exception using errcode='22023', message='invalid audit admission';
    end if;
    select * into v_grant from private.mcp_grants where id=p_grant_id and user_id=p_user_id
      and state='active' and binding->>'issuer'=p_issuer and binding->>'resource'=p_resource
      and binding->>'project'=p_project for share;
    if not found then raise exception using errcode='42501', message='active bound grant required'; end if;
    insert into private.mcp_tool_audit(id,user_id,grant_id,client_id,issuer,resource,project,tool_name,mutation)
      values(p_id,v_grant.user_id,v_grant.id,v_grant.binding->>'client_id',p_issuer,p_resource,p_project,p_tool_name,p_mutation)
      returning * into v_audit;
  else
    if p_tool_name is not null or p_mutation is not null or p_outcome is null
      or p_outcome not in ('returned','rejected','unknown') then
      raise exception using errcode='22023', message='invalid audit completion';
    end if;
    -- Completion may follow revocation/removal. Match the immutable admitted identity.
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
revoke all on function public.mcp_tool_audit_command(text,uuid,uuid,uuid,text,text,text,text,boolean,text)
  from public, anon, authenticated;
grant execute on function public.mcp_tool_audit_command(text,uuid,uuid,uuid,text,text,text,text,boolean,text)
  to service_role;
notify pgrst, 'reload schema';
commit;
