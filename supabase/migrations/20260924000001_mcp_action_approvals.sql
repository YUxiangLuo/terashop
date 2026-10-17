begin;

create table private.mcp_action_approvals (
  id uuid primary key, user_id uuid not null, grant_id uuid not null,
  client_id text not null, issuer text not null, resource text not null, project text not null,
  tool_name text not null check (tool_name in ('refund_paypal','commit_manual_refund','anonymize_customer')),
  arguments jsonb not null check (jsonb_typeof(arguments)='object'), snapshot jsonb not null,
  state text not null default 'pending' check (state in ('pending','approved','rejected','consuming','consumed')),
  created_at timestamptz not null default clock_timestamp(), expires_at timestamptz not null,
  decided_at timestamptz, consumed_at timestamptz
);
alter table private.mcp_action_approvals enable row level security;
revoke all on private.mcp_action_approvals from public,anon,authenticated,service_role;
create index mcp_action_approvals_owner on private.mcp_action_approvals(user_id,state,created_at desc);

create function private.mcp_approval_snapshot(p_tool text,p_args jsonb) returns jsonb
language sql stable security definer set search_path='' as $$
 select to_jsonb(private.command_request_hash(case p_tool
  when 'anonymize_customer' then coalesce((select jsonb_build_object('customer',to_jsonb(c),
    'addresses',(select jsonb_agg(to_jsonb(a) order by a.id) from public.addresses a where a.customer_id=c.id))
    from public.customers c where c.id=(p_args->>'customer_id')::uuid),'null'::jsonb)
  else jsonb_build_object('bound_scope',p_args)
 end))
$$;

create function public.mcp_action_approval_command(p_action text,p_approval_id uuid,p_grant_id uuid,p_user_id uuid,
 p_issuer text,p_resource text,p_project text,p_tool_name text,p_arguments jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a private.mcp_action_approvals; g private.mcp_grants; snap jsonb; result jsonb; required text[];
begin
 if auth.role() is distinct from 'service_role' then raise exception using errcode='42501',message='trusted MCP host required'; end if;
 if p_action is null or p_action not in ('stage','consume','finish') or p_approval_id is null or p_tool_name is null
   or p_tool_name not in ('refund_paypal','commit_manual_refund','anonymize_customer')
   or jsonb_typeof(p_arguments) is distinct from 'object' or octet_length(p_arguments::text)>65536
   then raise exception using errcode='22023',message='invalid bounded approval command'; end if;
 -- Host schemas validate payment payloads. SQL dispatch is limited to one exact signature.
 if p_tool_name='anonymize_customer' and (not p_arguments ? 'customer_id' or p_arguments - 'customer_id' <> '{}')
   then raise exception using errcode='22023',message='invalid action arguments'; end if;
 required:=case p_tool_name when 'anonymize_customer' then array['store:write','store:privacy']
   else array['store:write','store:payments'] end;
 select * into g from private.mcp_grants where id=p_grant_id and user_id=p_user_id and state='active'
   and binding->>'issuer'=p_issuer and binding->>'resource'=p_resource and binding->>'project'=p_project for share;
 if not found then raise exception using errcode='42501',message='active bound grant required'; end if;
 if not g.scopes @> required then raise exception using errcode='42501',message='required scopes missing'; end if;
 -- Hold the actor role through dispatch.
 perform 1 from public.profiles where id=p_user_id and role='admin' for share;
 if not found then raise exception using errcode='42501',message='current admin required'; end if;
 if p_action='stage' then
   snap:=private.mcp_approval_snapshot(p_tool_name,p_arguments);
   insert into private.mcp_action_approvals(id,user_id,grant_id,client_id,issuer,resource,project,tool_name,arguments,snapshot,expires_at)
   values(p_approval_id,p_user_id,p_grant_id,g.binding->>'client_id',p_issuer,p_resource,p_project,p_tool_name,p_arguments,snap,clock_timestamp()+interval '15 minutes') returning * into a;
   return jsonb_build_object('id',a.id,'state',a.state);
 elsif p_action not in ('consume','finish') then raise exception using errcode='22023',message='invalid approval action'; end if;
 select * into a from private.mcp_action_approvals where id=p_approval_id for update;
 if not found then raise exception using errcode='PT404',message='approval not found'; end if;
 if a.user_id<>p_user_id or a.grant_id<>p_grant_id or a.client_id<>g.binding->>'client_id'
   or a.issuer<>p_issuer or a.resource<>p_resource or a.project<>p_project then raise exception using errcode='42501',message='approval binding mismatch'; end if;
 if a.tool_name<>p_tool_name or a.arguments<>p_arguments then raise exception using errcode='PT409',message='approved arguments changed'; end if;
 if p_action='finish' then
   if a.state<>'consuming' then raise exception using errcode='PT409',message='approval is not consuming'; end if;
   update private.mcp_action_approvals set state='consumed' where id=a.id;
   return jsonb_build_object('id',a.id,'state','consumed');
 end if;
 if a.state<>'approved' or a.expires_at<=clock_timestamp() then raise exception using errcode='PT409',message='approval unavailable or expired'; end if;
 -- Compare after row locking, not before waiting on a concurrent business edit.
 if p_tool_name='anonymize_customer' then
   perform 1 from public.customers where id=(p_arguments->>'customer_id')::uuid for update;
 end if;
 snap:=private.mcp_approval_snapshot(p_tool_name,p_arguments);
 if a.snapshot<>snap then raise exception using errcode='PT409',message='approved state changed'; end if;
 update private.mcp_action_approvals set state='consuming',consumed_at=clock_timestamp() where id=a.id;
 if p_tool_name='anonymize_customer' then
   perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',p_user_id)::text,true);
   result:=to_jsonb(public.anonymize_customer((p_arguments->>'customer_id')::uuid));
   update private.mcp_action_approvals set state='consumed' where id=a.id;
 end if;
 return jsonb_build_object('id',a.id,'state',case when result is null then 'consuming' else 'consumed' end,'result',result);
end $$;

create function public.list_my_mcp_action_approvals(p_id uuid default null) returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'tool_name',tool_name,'arguments',arguments,'client_id',client_id,'resource',resource,'state',state,'created_at',created_at,'expires_at',expires_at) order by created_at desc),'[]'::jsonb)
 from (select * from private.mcp_action_approvals where user_id=auth.uid() and public.is_admin() and (p_id is null or id=p_id)
   order by created_at desc,id desc limit 100) recent
$$;
create function public.decide_my_mcp_action_approval(p_id uuid,p_decision text) returns jsonb language plpgsql security definer set search_path='' as $$
declare a private.mcp_action_approvals;
begin
 if auth.role() is distinct from 'authenticated' or not public.is_admin() or p_decision is null or p_decision not in ('approved','rejected') then raise exception using errcode='42501',message='active admin decision required'; end if;
 update private.mcp_action_approvals set state=p_decision,decided_at=clock_timestamp()
 where id=p_id and user_id=auth.uid() and state='pending' and expires_at>clock_timestamp() returning * into a;
 if not found then raise exception using errcode='PT409',message='pending approval unavailable'; end if;
 return jsonb_build_object('id',a.id,'state',a.state);
end $$;
revoke all on function public.mcp_action_approval_command(text,uuid,uuid,uuid,text,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.mcp_action_approval_command(text,uuid,uuid,uuid,text,text,text,text,jsonb) to service_role;
revoke all on function public.list_my_mcp_action_approvals(uuid) from public,anon,service_role;
revoke all on function public.decide_my_mcp_action_approval(uuid,text) from public,anon,service_role;
grant execute on function public.list_my_mcp_action_approvals(uuid) to authenticated;
grant execute on function public.decide_my_mcp_action_approval(uuid,text) to authenticated;
revoke all on function private.mcp_approval_snapshot(text,jsonb) from public,anon,authenticated,service_role;
notify pgrst,'reload schema';
commit;
