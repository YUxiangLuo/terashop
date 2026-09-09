begin;

-- Direct content edits remain supported. The authenticated role (including
-- admins) cannot take an address tuple lock and then switch defaults itself.
revoke update on public.addresses from authenticated;
grant update (label, receiver, phone, country, province, city, detail, postal_code)
  on public.addresses to authenticated;

create function private.protect_address_identity_and_default()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (new.id, new.customer_id, new.created_at)
     is distinct from (old.id, old.customer_id, old.created_at) then
    raise exception 'address identity and ownership are immutable';
  end if;
  if new.is_default is distinct from old.is_default
     and current_setting('commerce.default_address_customer', true)
         is distinct from new.customer_id::text then
    raise exception 'use set_default_address to change an existing default';
  end if;
  return new;
end;
$$;
create trigger addresses_default_command_guard
  before update on public.addresses
  for each row execute function private.protect_address_identity_and_default();

-- Retain POST {is_default:true} compatibility: BEFORE INSERT does not already
-- own a target address tuple, so it may safely take the customer lock first.
-- SECURITY DEFINER is needed to clear the old flag after column grants tighten.
create or replace function public.enforce_single_default_address()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_previous text := current_setting('commerce.default_address_customer', true);
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('tera-headless:default-address:' || new.customer_id::text, 0)
  );
  perform set_config('commerce.default_address_customer', new.customer_id::text, true);
  update public.addresses set is_default = false
  where customer_id = new.customer_id and id <> new.id and is_default;
  perform set_config('commerce.default_address_customer', coalesce(v_previous, ''), true);
  return new;
end;
$$;
drop trigger addresses_single_default on public.addresses;
create trigger addresses_single_default
  before insert on public.addresses
  for each row when (new.is_default)
  execute function public.enforce_single_default_address();

create function public.set_default_address(address_id uuid, make_default boolean default true)
returns public.addresses
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_customer_id uuid;
  v_address public.addresses;
  v_previous text := current_setting('commerce.default_address_customer', true);
begin
  if make_default is null then raise exception 'make_default is required'; end if;
  -- Read the immutable owner without locking an address row. Recheck existence
  -- after the customer lock, since a concurrent DELETE can still remove it.
  select a.customer_id into v_customer_id from public.addresses a
  where a.id = set_default_address.address_id;
  if not found or not (
    v_customer_id = auth.uid() or public.is_admin() or auth.role() = 'service_role'
  ) or (auth.uid() is null and auth.role() is distinct from 'service_role') then
    raise exception 'address not found';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('tera-headless:default-address:' || v_customer_id::text, 0)
  );
  select * into v_address from public.addresses a
  where a.id = set_default_address.address_id and a.customer_id = v_customer_id for update;
  if not found then raise exception 'address not found'; end if;

  perform set_config('commerce.default_address_customer', v_customer_id::text, true);
  if make_default then
    update public.addresses set is_default = false
    where customer_id = v_customer_id and id <> v_address.id and is_default;
  end if;
  update public.addresses a set is_default = make_default
  where a.id = v_address.id returning * into v_address;
  perform set_config('commerce.default_address_customer', coalesce(v_previous, ''), true);
  return v_address;
end;
$$;

revoke all on function private.protect_address_identity_and_default() from public, anon, authenticated, service_role;
revoke all on function public.enforce_single_default_address() from public, anon, authenticated, service_role;
revoke all on function public.set_default_address(uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function public.set_default_address(uuid, boolean) to authenticated, service_role;
-- Keep addresses_one_default_per_customer_idx as the final uniqueness invariant.

commit;
