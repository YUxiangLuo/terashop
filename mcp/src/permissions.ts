// Explicit business policy, never inferred from tool names or annotations.
export type AdminScope = 'store:read' | 'store:write' | 'store:payments' | 'store:access' | 'store:privacy';
const read: readonly AdminScope[] = Object.freeze(['store:read']);
const write: readonly AdminScope[] = Object.freeze(['store:write']);
const payments: readonly AdminScope[] = Object.freeze(['store:write', 'store:payments']);
const access: readonly AdminScope[] = Object.freeze(['store:write', 'store:access']);
const privacy: readonly AdminScope[] = Object.freeze(['store:write', 'store:privacy']);
const accountPrivacy: readonly AdminScope[] = Object.freeze(['store:write', 'store:access', 'store:privacy']);

export const toolScopes: Readonly<Record<string, readonly AdminScope[]>> = Object.freeze({
  stage_media_upload: write,
  get_managed_media: read,
  recover_media_upload: write,
  publish_managed_media: write,
  prepare_media_discard: write,
  delete_managed_media: write,
  recover_media_deletion: write,
  list_admin_managed_media: read,
  list_admin_product_media: read,
  inspect_product_media: read,
  upload_product_media: write,
  get_admin_shop_settings: read,
  get_admin_payment_summary: read,
  get_admin_order_summary: read,
  export_admin_orders: read,
  update_shop_settings: write,
  list_admin_products: read,
  get_admin_product: read,
  create_product: write,
  update_product: write,
  list_admin_customers: read,
  get_admin_customer: read,
  create_customer: write,
  anonymize_customer: privacy,
  update_customer: write,
  create_customer_address: write,
  update_customer_address: write,
  delete_customer_address: write,
  set_default_address: write,
  get_inventory_availability: read,
  get_admin_location: read,
  list_admin_locations: read,
  list_admin_inventory_movements: read,
  get_inventory_transfer: read,
  transfer_inventory: write,
  create_location: write,
  update_location: write,
  set_default_location: write,
  adjust_inventory: write,
  delete_metaobject: write,
  delete_metaobject_definition: write,
  create_metaobject: write,
  update_metaobject: write,
  create_metaobject_definition: write,
  update_metaobject_definition: write,
  list_admin_metaobject_definitions: read,
  get_admin_metaobject_definition: read,
  list_admin_metaobjects: read,
  get_admin_metaobject: read,
  create_metafield: write,
  update_metafield: write,
  delete_metafield: write,
  create_metafield_definition: write,
  update_metafield_definition: write,
  get_admin_metafield_definition: read,
  list_admin_metafield_definitions: read,
  list_admin_metafields: read,
  get_admin_tax_rate: read,
  list_admin_tax_rates: read,
  create_tax_rate: write,
  update_tax_rate: write,
  get_admin_shipping_method: read,
  list_admin_shipping_methods: read,
  create_shipping_method: write,
  update_shipping_method: write,
  create_promotion: write,
  update_promotion: write,
  get_admin_promotion: read,
  list_admin_promotions: read,
  list_admin_promotion_targets: read,
  list_admin_discount_redemptions: read,
  list_admin_orders: read,
  get_admin_order: read,
  update_order_admin_note: write,
  list_admin_order_events: read,
  get_order_pricing: read,
  list_admin_payment_operations: read,
  get_order_ledger: read,
  get_order_fulfillment_balance: read,
  list_admin_checkout_quotes: read,
  get_admin_checkout_quote: read,
  get_order_checkout_quote: read,
  cancel_checkout_quote: write,
  cancel_order: write,
  cancel_zero_value_order_item: write,
  mark_order_paid: payments,
  refund_order: payments,
  refund_paypal: payments,
  create_fulfillment: write,
  update_fulfillment: write,
  get_order_returns: read,
  create_return: write,
  receive_return: write,
  dispose_return_receipt: write,
  close_return: write,
  list_admin_reviews: read,
  get_admin_review: read,
  delete_review: write,
  moderate_review: write,
  set_user_role: access,
  list_admin_users: read,
  get_admin_user: read,
  anonymize_user: accountPrivacy,
  list_admin_outbox_events: read,
  list_admin_payment_provider_events: read,
  get_admin_operations_summary: read,
  list_admin_reconciliation_issues: read,
  redrive_outbox_event: write,
  get_admin_category: read,
  list_admin_categories: read,
  create_category: write,
  update_category: write,
});

export function requiredToolScopes(name: string): readonly AdminScope[] {
  if (!Object.hasOwn(toolScopes, name)) throw new Error('Unclassified admin tool');
  return toolScopes[name];
}

export function permitsTool(name: string, scopes: readonly AdminScope[]): boolean {
  return Object.hasOwn(toolScopes, name) && toolScopes[name].every((scope) => scopes.includes(scope));
}

// Supplied only by a trusted host, not tool input. This is a scope enforcement
// boundary, NOT a JWT verifier or an HTTP authentication implementation.
export interface ToolAuthorization {
  scopes: readonly AdminScope[];
  currentScopes(): Promise<readonly AdminScope[]>;
}
