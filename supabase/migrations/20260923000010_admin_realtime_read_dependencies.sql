begin;

-- Promotion records show redemptions independently of the promotion row.
create trigger admin_configuration_redemptions
  after insert or update or delete on public.discount_redemptions
  for each statement execute function private.notify_admin_domain('admin:configuration');

-- OrderActivity embeds provider money movements as well as order state.
create trigger admin_orders_provider_movements
  after insert or update or delete on commerce.provider_money_movements
  for each statement execute function private.notify_admin_domain('admin:orders');

commit;
