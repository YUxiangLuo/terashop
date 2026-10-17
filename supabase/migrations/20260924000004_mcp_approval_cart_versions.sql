begin;

-- Cart edits increment the cart version, not customers.updated_at. Include both
-- identity and version so an old approval cannot erase subsequently edited carts.
-- Consumption already holds the customer lock used by authenticated cart commands.
create or replace function private.mcp_approval_snapshot(p_tool text,p_args jsonb) returns jsonb
language sql stable security definer set search_path='' as $$
 select to_jsonb(private.command_request_hash(case p_tool
  when 'anonymize_customer' then coalesce((select jsonb_build_object('customer',to_jsonb(c),
    'addresses',(select jsonb_agg(to_jsonb(a) order by a.id) from public.addresses a where a.customer_id=c.id),
    'carts',(select jsonb_agg(jsonb_build_object('id',k.id,'version',k.version) order by k.id) from commerce.carts k where k.customer_id=c.id))
    from public.customers c where c.id=(p_args->>'customer_id')::uuid),'null'::jsonb)
  else jsonb_build_object('bound_scope',p_args)
 end))
$$;

-- Previously staged anonymization approvals will fail their fingerprint check;
-- require a fresh human decision instead of silently upgrading approved state.
commit;
