begin;

create policy admin_product_invalidation_read on realtime.messages
  for select to authenticated using (
    extension = 'broadcast' and (select realtime.topic()) = 'admin:products'
    and (select public.is_admin())
  );

create function private.notify_admin_products() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform realtime.send('{}'::jsonb, 'invalidate', 'admin:products', true);
  return null;
exception when others then
  raise warning 'Admin product invalidation unavailable';
  return null;
end;
$$;

-- Every source used by list_admin_products, including price/SKU and thumbnail.
create trigger admin_product_invalidation
  after insert or update or delete on public.products
  for each statement execute function private.notify_admin_products();
create trigger admin_variant_invalidation
  after insert or update or delete on public.product_variants
  for each statement execute function private.notify_admin_products();
create trigger admin_image_invalidation
  after insert or update or delete on public.product_images
  for each statement execute function private.notify_admin_products();
create trigger admin_product_category_invalidation
  after insert or update or delete on public.product_categories
  for each statement execute function private.notify_admin_products();

revoke all on function private.notify_admin_products()
  from public, anon, authenticated, service_role;
commit;
