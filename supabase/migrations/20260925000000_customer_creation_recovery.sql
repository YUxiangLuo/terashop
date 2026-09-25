begin;

-- Resolve only committed identity, never replay or cache the original contact details.
create function public.get_customer_creation_result(idempotency_key text)
returns uuid language plpgsql stable security definer set search_path='' as $$
declare
  v_key text := btrim(idempotency_key);
begin
  if not public.is_admin() and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='admin only';
  end if;
  if coalesce(v_key,'')='' or length(v_key)>200 then
    raise exception using errcode='22023', message='idempotency_key is required and must be at most 200 characters';
  end if;
  return (select c.resource_id from commerce.command_idempotency c
    where c.scope='customer.create'
      and c.subject_id='00000000-0000-0000-0000-000000000000'::uuid
      and c.idempotency_key=v_key);
end;
$$;

revoke all on function public.get_customer_creation_result(text) from public, anon;
grant execute on function public.get_customer_creation_result(text) to authenticated, service_role;

commit;
