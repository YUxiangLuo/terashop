begin;

-- One statement snapshot, not a moving cross-page scan. The existing explicit-ID
-- command remains the only writer; grants created after this read are excluded.
create function public.preview_my_mcp_connection_revocation()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_items jsonb;
begin
  if auth.role() is distinct from 'authenticated' or not exists (
    select 1 from auth.users where id=auth.uid() and not coalesce(is_anonymous,true)
  ) then raise exception using errcode='42501', message='user session required'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',g.id,'client_id',g.binding->>'client_id','resource',g.binding->>'resource',
    'scopes',g.scopes,'state',g.state,'created_at',g.created_at,'revoked_at',g.revoked_at,
    'cleanup','not_requested'
  ) order by g.id),'[]'::jsonb) into v_items from (
    select g.* from private.mcp_grants g
    where g.user_id=auth.uid() and not exists (
      select 1 from private.mcp_connection_revocations r where r.grant_id=g.id
    ) order by g.id limit 101
  ) g;
  if jsonb_array_length(v_items)>100 then
    raise exception using errcode='PT422', message='more than 100 eligible connections; revoke explicit pages first';
  end if;
  return jsonb_build_object('items',v_items,'next_cursor',null);
end;
$$;

revoke all on function public.preview_my_mcp_connection_revocation() from public, anon, service_role;
grant execute on function public.preview_my_mcp_connection_revocation() to authenticated;
notify pgrst, 'reload schema';
commit;
