begin;

-- These channels are invalidation hints only. RPC authorization remains authoritative.
create policy admin_domain_invalidation_read on realtime.messages
  for select to authenticated using (
    extension = 'broadcast'
    and (select realtime.topic()) in (
      'admin:orders', 'admin:quotes', 'admin:customers',
      'admin:configuration', 'admin:operations'
    )
    and (select public.is_admin())
  );

-- Topic names are fixed in the trigger declarations below. Never include a row,
-- identifier, provider response, error text, or credential in the broadcast.
create function private.notify_admin_domain() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform realtime.send('{}'::jsonb, 'invalidate', tg_argv[0], true);
  return null;
exception when others then
  raise warning 'Admin domain invalidation unavailable';
  return null;
end;
$$;

-- Orders: list/detail, fulfillment, return/refund, pricing and payment state.
create trigger admin_orders_orders after insert or update or delete on public.orders for each statement execute function private.notify_admin_domain('admin:orders');
create trigger admin_orders_items after insert or update or delete on public.order_items for each statement execute function private.notify_admin_domain('admin:orders');
create trigger admin_orders_events after insert or update or delete on public.order_events for each statement execute function private.notify_admin_domain('admin:orders');
create trigger admin_orders_promotions after insert or update or delete on public.order_promotions for each statement execute function private.notify_admin_domain('admin:orders');
create trigger admin_orders_adjustments after insert or update or delete on commerce.order_adjustments for each statement execute function private.notify_admin_domain('admin:orders');
create trigger admin_orders_shipping_lines after insert or update or delete on commerce.order_shipping_lines for each statement execute function private.notify_admin_domain('admin:orders');
create trigger admin_orders_tax_lines after insert or update or delete on commerce.order_tax_lines for each statement execute function private.notify_admin_domain('admin:orders');
create trigger admin_orders_discount_allocations after insert or update or delete on commerce.order_discount_allocations for each statement execute function private.notify_admin_domain('admin:orders');
create trigger admin_orders_fulfillments after insert or update or delete on public.fulfillments for each statement execute function private.notify_admin_domain('admin:orders');
create trigger admin_orders_fulfillment_lines after insert or update or delete on commerce.fulfillment_lines for each statement execute function private.notify_admin_domain('admin:orders');
create trigger admin_orders_refunds after insert or update or delete on commerce.refunds for each statement execute function private.notify_admin_domain('admin:orders');
create trigger admin_orders_refund_lines after insert or update or delete on commerce.refund_lines for each statement execute function private.notify_admin_domain('admin:orders');
create trigger admin_orders_refund_components after insert or update or delete on commerce.refund_components for each statement execute function private.notify_admin_domain('admin:orders');
create trigger admin_orders_returns after insert or update or delete on commerce.returns for each statement execute function private.notify_admin_domain('admin:orders');
create trigger admin_orders_return_lines after insert or update or delete on commerce.return_lines for each statement execute function private.notify_admin_domain('admin:orders');
create trigger admin_orders_return_receipts after insert or update or delete on commerce.return_receipts for each statement execute function private.notify_admin_domain('admin:orders');
create trigger admin_orders_return_receipt_lines after insert or update or delete on commerce.return_receipt_lines for each statement execute function private.notify_admin_domain('admin:orders');
create trigger admin_orders_return_dispositions after insert or update or delete on commerce.return_dispositions for each statement execute function private.notify_admin_domain('admin:orders');
create trigger admin_orders_payment_intents after insert or update or delete on commerce.payment_intents for each statement execute function private.notify_admin_domain('admin:orders');
create trigger admin_orders_payment_transactions after insert or update or delete on commerce.payment_transactions for each statement execute function private.notify_admin_domain('admin:orders');
create trigger admin_orders_refund_requests after insert or update or delete on commerce.refund_requests for each statement execute function private.notify_admin_domain('admin:orders');
create trigger admin_orders_refund_request_lines after insert or update or delete on commerce.refund_request_lines for each statement execute function private.notify_admin_domain('admin:orders');
create trigger admin_orders_refund_request_components after insert or update or delete on commerce.refund_request_components for each statement execute function private.notify_admin_domain('admin:orders');

-- Checkout quote list/detail snapshots.
create trigger admin_quotes_quotes after insert or update or delete on commerce.checkout_quotes for each statement execute function private.notify_admin_domain('admin:quotes');
create trigger admin_quotes_lines after insert or update or delete on commerce.checkout_quote_lines for each statement execute function private.notify_admin_domain('admin:quotes');

-- Customer detail plus the admin user/account views.
create trigger admin_customers_customers after insert or update or delete on public.customers for each statement execute function private.notify_admin_domain('admin:customers');
create trigger admin_customers_profiles after insert or update or delete on public.profiles for each statement execute function private.notify_admin_domain('admin:customers');
create trigger admin_customers_addresses after insert or update or delete on public.addresses for each statement execute function private.notify_admin_domain('admin:customers');

-- Configuration editors and their complete read dependencies.
create trigger admin_configuration_locations after insert or update or delete on public.locations for each statement execute function private.notify_admin_domain('admin:configuration');
create trigger admin_configuration_shipping after insert or update or delete on public.shipping_methods for each statement execute function private.notify_admin_domain('admin:configuration');
create trigger admin_configuration_taxes after insert or update or delete on public.tax_rates for each statement execute function private.notify_admin_domain('admin:configuration');
create trigger admin_configuration_promotions after insert or update or delete on public.promotions for each statement execute function private.notify_admin_domain('admin:configuration');
create trigger admin_configuration_promotion_targets after insert or update or delete on public.promotion_targets for each statement execute function private.notify_admin_domain('admin:configuration');
create trigger admin_configuration_shop_settings after insert or update or delete on private.shop_settings for each statement execute function private.notify_admin_domain('admin:configuration');

-- Payment operations, inbox/reconciliation and outbox operational views.
create trigger admin_operations_provider_events after insert or update or delete on commerce.payment_provider_events for each statement execute function private.notify_admin_domain('admin:operations');
create trigger admin_operations_payment_intents after insert or update or delete on commerce.payment_intents for each statement execute function private.notify_admin_domain('admin:operations');
create trigger admin_operations_payment_transactions after insert or update or delete on commerce.payment_transactions for each statement execute function private.notify_admin_domain('admin:operations');
create trigger admin_operations_provider_movements after insert or update or delete on commerce.provider_money_movements for each statement execute function private.notify_admin_domain('admin:operations');
create trigger admin_operations_refund_requests after insert or update or delete on commerce.refund_requests for each statement execute function private.notify_admin_domain('admin:operations');
create trigger admin_operations_refund_request_lines after insert or update or delete on commerce.refund_request_lines for each statement execute function private.notify_admin_domain('admin:operations');
create trigger admin_operations_refund_request_components after insert or update or delete on commerce.refund_request_components for each statement execute function private.notify_admin_domain('admin:operations');
create trigger admin_operations_outbox after insert or update or delete on commerce.outbox_events for each statement execute function private.notify_admin_domain('admin:operations');
create trigger admin_operations_redrives after insert or update or delete on commerce.outbox_redrives for each statement execute function private.notify_admin_domain('admin:operations');

-- Product detail/editor dependencies omitted by the initial product migration.
create trigger admin_product_option_invalidation after insert or update or delete on public.product_options for each statement execute function private.notify_admin_products();
create trigger admin_product_option_value_invalidation after insert or update or delete on public.product_option_values for each statement execute function private.notify_admin_products();
create trigger admin_variant_option_value_invalidation after insert or update or delete on public.variant_option_values for each statement execute function private.notify_admin_products();

revoke all on function private.notify_admin_domain()
  from public, anon, authenticated, service_role;

commit;
