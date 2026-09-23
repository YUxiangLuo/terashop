begin;

-- Personal invalidations disclose no connection, client, scope or cleanup data.
-- Demoted authenticated users retain access to their own security records.
create policy own_mcp_connection_invalidation_read on realtime.messages
  for select to authenticated using (
    extension = 'broadcast'
    and (select auth.jwt()->>'is_anonymous') = 'false'
    and (select realtime.topic()) = 'admin:connections:' || (select auth.uid())::text
  );
-- Deliberately no INSERT policy: browser clients cannot publish invalidations.

create function private.notify_mcp_grant_connection_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_old_user uuid;
  v_new_user uuid;
begin
  if tg_op <> 'INSERT' then v_old_user := old.user_id; end if;
  if tg_op <> 'DELETE' then v_new_user := new.user_id; end if;
  if v_old_user is not null then
    perform realtime.send('{}'::jsonb, 'invalidate', 'admin:connections:' || v_old_user::text, true);
  end if;
  if v_new_user is not null and v_new_user is distinct from v_old_user then
    perform realtime.send('{}'::jsonb, 'invalidate', 'admin:connections:' || v_new_user::text, true);
  end if;
  return null;
exception when others then
  raise warning 'Personal MCP connection invalidation unavailable';
  return null;
end;
$$;

create function private.notify_mcp_revocation_connection_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
begin
  select g.user_id into v_user
    from private.mcp_grants g
    where g.id = case when tg_op = 'DELETE' then old.grant_id else new.grant_id end;
  if v_user is not null then
    perform realtime.send('{}'::jsonb, 'invalidate', 'admin:connections:' || v_user::text, true);
  end if;
  return null;
exception when others then
  raise warning 'Personal MCP cleanup invalidation unavailable';
  return null;
end;
$$;

create trigger mcp_grant_connection_invalidation
  after insert or update or delete on private.mcp_grants
  for each row execute function private.notify_mcp_grant_connection_change();
create trigger mcp_revocation_connection_invalidation
  after insert or update or delete on private.mcp_connection_revocations
  for each row execute function private.notify_mcp_revocation_connection_change();

revoke all on function private.notify_mcp_grant_connection_change(),
  private.notify_mcp_revocation_connection_change()
  from public, anon, authenticated, service_role;

commit;
