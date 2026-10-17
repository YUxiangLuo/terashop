import * as z from 'zod/v4';

export const auditResourceTypes = [
  'product',
  'customer',
  'order',
  'location',
  'promotion',
  'checkout_quote',
  'category',
  'tax_rate',
  'shipping_method',
  'managed_media',
] as const;

export type AuditResourceRef = {
  resourceType: (typeof auditResourceTypes)[number];
  resourceId: string;
};

// This is deliberately an exact tool allowlist, not a convention-based key search.
// In particular, user/profile IDs are never treated as customer records.
const resourceByTool: Readonly<Record<string, readonly [AuditResourceRef['resourceType'], string]>> = {
  get_admin_product: ['product', 'product_id'],
  update_product: ['product', 'product_id'],
  upload_product_media: ['product', 'product_id'],
  inspect_product_media: ['product', 'product_id'],
  list_admin_product_media: ['product', 'product_id'],
  get_admin_customer: ['customer', 'customer_id'],
  update_customer: ['customer', 'customer_id'],
  anonymize_customer: ['customer', 'customer_id'],
  create_customer_address: ['customer', 'customer_id'],
  update_customer_address: ['customer', 'customer_id'],
  delete_customer_address: ['customer', 'customer_id'],
  get_admin_order: ['order', 'order_id'],
  update_order_admin_note: ['order', 'order_id'],
  cancel_order: ['order', 'order_id'],
  mark_order_paid: ['order', 'order_id'],
  refund_paypal: ['order', 'order_id'],
  preview_manual_refund: ['order', 'order_id'],
  commit_manual_refund: ['order', 'order_id'],
  get_order_pricing: ['order', 'order_id'],
  get_order_ledger: ['order', 'order_id'],
  create_fulfillment: ['order', 'order_id'],
  get_admin_location: ['location', 'location_id'],
  update_location: ['location', 'location_id'],
  set_default_location: ['location', 'location_id'],
  get_admin_promotion: ['promotion', 'promotion_id'],
  update_promotion: ['promotion', 'promotion_id'],
  get_admin_checkout_quote: ['checkout_quote', 'quote_id'],
  cancel_checkout_quote: ['checkout_quote', 'quote_id'],
  get_admin_category: ['category', 'category_id'],
  update_category: ['category', 'category_id'],
  get_admin_tax_rate: ['tax_rate', 'tax_rate_id'],
  update_tax_rate: ['tax_rate', 'tax_rate_id'],
  get_admin_shipping_method: ['shipping_method', 'shipping_method_id'],
  update_shipping_method: ['shipping_method', 'shipping_method_id'],
  get_managed_media: ['managed_media', 'media_id'],
  recover_media_upload: ['managed_media', 'media_id'],
  publish_managed_media: ['managed_media', 'media_id'],
  prepare_media_discard: ['managed_media', 'media_id'],
  delete_managed_media: ['managed_media', 'media_id'],
  recover_media_deletion: ['managed_media', 'media_id'],
};

export function auditResourceRef(tool: string, args: unknown): AuditResourceRef | undefined {
  const mapping = resourceByTool[tool];
  if (!mapping || !args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const value = (args as Record<string, unknown>)[mapping[1]];
  const parsed = z.uuid().safeParse(value);
  return parsed.success ? { resourceType: mapping[0], resourceId: parsed.data } : undefined;
}
