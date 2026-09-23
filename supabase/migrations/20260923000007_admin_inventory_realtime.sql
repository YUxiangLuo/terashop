begin;

create policy admin_inventory_invalidation_read on realtime.messages
  for select to authenticated using (
    extension = 'broadcast' and (select realtime.topic()) = 'admin:inventory'
    and (select public.is_admin())
  );

create function private.notify_admin_inventory() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform realtime.send('{}'::jsonb, 'invalidate', 'admin:inventory', true);
  return null;
exception when others then
  raise warning 'Admin inventory invalidation unavailable';
  return null;
end;
$$;

create trigger admin_inventory_level_invalidation
  after insert or update or delete on public.inventory_levels
  for each statement execute function private.notify_admin_inventory();
create trigger admin_inventory_reservation_invalidation
  after insert or update or delete on commerce.inventory_reservations
  for each statement execute function private.notify_admin_inventory();
create trigger admin_inventory_movement_invalidation
  after insert on public.inventory_movements
  for each statement execute function private.notify_admin_inventory();

-- Wall-clock reservation expiry alone emits no notification. Reread on demand.
-- Broadcast contains no stock, order, quote, variant or warehouse identifiers.
revoke all on function private.notify_admin_inventory()
  from public, anon, authenticated, service_role;
commit;
