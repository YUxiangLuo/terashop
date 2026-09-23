begin;

-- Invalidation only: never broadcast business rows, parameters or credentials.
-- Private-channel policies are cached by Realtime; they do not replace RPC auth.
create policy admin_category_invalidation_read on realtime.messages
  for select to authenticated using (
    extension = 'broadcast' and (select realtime.topic()) = 'admin:categories'
    and (select public.is_admin())
  );
create policy own_mcp_invalidation_read on realtime.messages
  for select to authenticated using (
    extension = 'broadcast'
    and (select auth.jwt()->>'is_anonymous') = 'false'
    and (select realtime.topic()) = 'admin:calls:' || (select auth.uid())::text
  );
-- No INSERT policy: browser clients must not publish trusted invalidations.

create function private.notify_admin_categories() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform realtime.send('{}'::jsonb, 'invalidate', 'admin:categories', true);
  return null;
exception when others then
  -- Notifications are best effort, never a condition for committing commerce.
  raise warning 'Admin category invalidation unavailable';
  return null;
end;
$$;
create trigger admin_category_invalidation
  after insert or update or delete on public.categories
  for each statement execute function private.notify_admin_categories();

create function private.notify_my_mcp_calls() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform realtime.send('{}'::jsonb, 'invalidate', 'admin:calls:' || new.user_id::text, true);
  return null;
exception when others then
  raise warning 'Personal MCP invalidation unavailable';
  return null;
end;
$$;
create trigger my_mcp_call_invalidation
  after insert or update on private.mcp_tool_audit
  for each row execute function private.notify_my_mcp_calls();

revoke all on function private.notify_admin_categories(), private.notify_my_mcp_calls()
  from public, anon, authenticated, service_role;
commit;
