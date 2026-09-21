import * as z from 'zod/v4';

export const id = z.uuid();
export const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const bigintString = z
  .string()
  .regex(/^(0|-?[1-9][0-9]{0,18})$/)
  .refine((value) => {
    try {
      const number = BigInt(value);
      return number.toString() === value && number >= -9223372036854775808n && number <= 9223372036854775807n;
    } catch {
      return false;
    }
  }, 'Expected a canonical signed bigint decimal string');
export const orderNumber = bigintString;
export const adminOrderPage = z.strictObject({
  items: z
    .array(
      z.strictObject({
        id,
        order_number: orderNumber,
        customer_id: id,
        email: z.string(),
        status: z.enum(['open', 'completed', 'cancelled']),
        financial_status: z.enum(['pending', 'paid', 'partially_refunded', 'refunded', 'voided']),
        fulfillment_status: z.enum(['unfulfilled', 'partially_fulfilled', 'fulfilled']),
        currency: z.literal('USD'),
        total: z.number().nonnegative(),
        created_at: z.iso.datetime({ offset: true }),
      }),
    )
    .max(100),
  next_cursor: orderNumber.nullable(),
});

const timestamp = z.iso.datetime({ offset: true });
export const reviewResult = z.strictObject({
  id,
  revision: version,
  product_id: id,
  customer_id: id,
  rating: z.number().int().min(1).max(5),
  title: z.string(),
  body: z.string(),
  status: z.enum(['pending', 'approved', 'rejected']),
  created_at: timestamp,
  updated_at: timestamp,
});
export const reviewPage = z.strictObject({
  items: z.array(reviewResult.omit({ body: true })).max(100),
  next_cursor: id.nullable(),
});
export const reviewDeletion = z.strictObject({ id, deleted: z.literal(true) });
export const profileResult = z.strictObject({
  id,
  email: z.string(),
  role: z.enum(['admin', 'customer']),
  created_at: timestamp,
  updated_at: timestamp,
});
export const adminUser = profileResult.omit({ id: true }).extend({
  user_id: id,
  customer_id: id.nullable(),
  customer_anonymized_at: timestamp.nullable(),
});
export const adminUserPage = z.strictObject({
  items: z.array(adminUser).max(100),
  next_cursor: id.nullable(),
});
export const customerResult = z.strictObject({
  id,
  auth_user_id: id.nullable(),
  email: z.string().nullable(),
  full_name: z.string(),
  phone: z.string().nullable(),
  anonymized_at: timestamp.nullable(),
  created_at: timestamp,
  updated_at: timestamp,
});
const customerSummary = customerResult.omit({ auth_user_id: true }).extend({ has_account: z.boolean() });
export const customerAddress = z.strictObject({
  id,
  customer_id: id,
  label: z.string(),
  recipient_name: z.string(),
  phone: z.string().nullable(),
  country: z.string(),
  region: z.string().nullable(),
  city: z.string().nullable(),
  line1: z.string(),
  line2: z.string().nullable(),
  postal_code: z.string().nullable(),
  is_default: z.boolean(),
  created_at: timestamp,
  updated_at: timestamp,
});
export const adminCustomerDetail = customerSummary.extend({
  addresses: z.array(customerAddress.omit({ customer_id: true, created_at: true })),
  metafields: z.array(
    z.strictObject({
      namespace: z.string(),
      key: z.string(),
      type: z.string(),
      value: z.json(),
    }),
  ),
});
export const adminCustomerPage = z.strictObject({
  items: z.array(customerSummary).max(100),
  next_cursor: z.strictObject({ created_at: timestamp, id }).nullable(),
});
const money = z
  .number()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER / 100);
const totals = {
  subtotal: money,
  discount_total: money,
  shipping_total: money,
  tax_total: money,
  total: money,
};
// These are stored JSON snapshots, not new input commands. Keep their contents
// unchanged; fixed DTO envelopes and relational rows below remain strict.
const jsonObject = z.record(z.string(), z.json());
export const orderNoteResult = z.strictObject({ id, admin_note: z.string().nullable() });
export const orderEventPage = z.strictObject({
  items: z
    .array(
      z.strictObject({
        id: bigintString,
        order_id: id,
        actor_id: id.nullable(),
        type: z.string(),
        created_at: timestamp,
      }),
    )
    .max(100),
  next_cursor: bigintString.nullable(),
});
export const zeroValueCancellation = z.strictObject({
  id,
  order_id: id,
  order_item_id: id,
  quantity: version,
  restocked_quantity: z.number().int().nonnegative(),
  created_at: timestamp,
});
export const paypalRefundResult = z.strictObject({
  refund_request_id: id,
  order_id: id,
  provider: z.literal('paypal'),
  provider_status: z.enum(['PENDING', 'COMPLETED', 'FAILED', 'CANCELLED']),
  pending_reconciliation: z.boolean(),
});
export const checkoutQuote = z.strictObject({
  id,
  status: z.enum(['open', 'converted', 'completed', 'cancelled', 'expired']),
  is_reserved: z.boolean(),
  order_id: id.nullable(),
  currency: z.literal('USD'),
  ...totals,
  tax_context: jsonObject,
  shipping_line: jsonObject.nullable(),
  shipping_address: jsonObject,
  shipping_method_id: id.nullable(),
  shipping_method_name: z.string().nullable(),
  discount_code: z.string().nullable(),
  customer_note: z.string().nullable(),
  promotions: z.array(z.json()),
  cancel_reason: z.string().nullable(),
  expires_at: timestamp,
  created_at: timestamp,
  updated_at: timestamp,
  lines: z.array(
    z.strictObject({
      id,
      line_key: z.string(),
      attributes: z.record(z.string(), z.string()),
      tax_lines: z.array(z.json()),
      discount_allocations: z.array(z.json()),
      variant_id: id,
      product_id: id,
      sku: z.string().nullable(),
      name: z.string(),
      variant_title: z.string(),
      options: z.json(),
      unit_price: money,
      quantity: version,
      discount_total: money,
      total: money,
      line_total: money,
      track_inventory: z.boolean(),
    }),
  ),
});
export const adminCheckoutQuote = checkoutQuote.extend({
  customer_id: id,
  stored_status: checkoutQuote.shape.status,
});
export const adminCheckoutQuotePage = z.strictObject({
  items: z
    .array(
      adminCheckoutQuote.pick({
        id: true,
        customer_id: true,
        order_id: true,
        stored_status: true,
        status: true,
        is_reserved: true,
        currency: true,
        total: true,
        expires_at: true,
        created_at: true,
        updated_at: true,
      }),
    )
    .max(100),
  next_cursor: id.nullable(),
});
export const orderResult = adminOrderPage.shape.items.element.extend({
  ...totals,
  tax_context: jsonObject,
  shipping_address: jsonObject,
  billing_address: jsonObject.nullable(),
  shipping_method_id: id.nullable(),
  shipping_method_name: z.string().nullable(),
  discount_code: z.string().nullable(),
  customer_note: z.string().nullable(),
  cancel_reason: z.string().nullable(),
  paid_at: timestamp.nullable(),
  payment_expires_at: timestamp,
  cancelled_at: timestamp.nullable(),
  completed_at: timestamp.nullable(),
  updated_at: timestamp,
});
export const adminOrderResult = orderResult.extend({ admin_note: z.string().nullable() });
const discountAllocation = z.strictObject({ promotion_id: id, label: z.string(), amount: money });
const taxLine = z.strictObject({
  id,
  tax_rate_id: id,
  name: z.string(),
  country: z.string(),
  rate: z.number().min(0).max(1),
  taxable_amount: money,
  amount: money,
});
const allocations = {
  discount_allocations: z.array(discountAllocation),
  tax_lines: z.array(taxLine),
};
export const orderPricing = z.strictObject({
  order_id: id,
  currency: z.literal('USD'),
  ...totals,
  tax_context: jsonObject,
  shipping_method_id: id.nullable(),
  shipping_method_name: z.string().nullable(),
  lines: z.array(
    z.strictObject({
      id,
      line_key: z.string(),
      variant_id: id.nullable(),
      product_id: id.nullable(),
      name: z.string(),
      sku: z.string().nullable(),
      variant_title: z.string(),
      options: z.json(),
      attributes: z.record(z.string(), z.string()),
      unit_price: money,
      quantity: z.number().int().positive(),
      total: money,
      discount_total: money,
      line_total: money,
      ...allocations,
    }),
  ),
  shipping_line: z
    .strictObject({
      id,
      shipping_method_id: id.nullable(),
      name: z.string(),
      gross_amount: money,
      discount_total: money,
      threshold_discount: money,
      total: money,
      policy: jsonObject,
      ...allocations,
    })
    .nullable(),
  promotions: z.array(
    z.strictObject({
      promotion_id: id,
      name: z.string(),
      code: z.string().nullable(),
      amount: money,
      snapshot: z.json(),
    }),
  ),
});
export const adminOrderDetail = adminOrderResult
  .extend({
    pricing: orderPricing,
    fulfillments: z.array(
      z.strictObject({
        id,
        order_id: id,
        version,
        status: z.enum(['pending', 'shipped', 'delivered', 'cancelled']),
        carrier: z.string(),
        tracking_number: z.string(),
        tracking_url: z.string().nullable(),
        shipped_at: timestamp.nullable(),
        delivered_at: timestamp.nullable(),
        created_at: timestamp,
        lines: z.array(z.strictObject({ order_item_id: id, quantity: z.number().int().positive() })),
      }),
    ),
  })
  .nullable();

const quantity = z.number().int().nonnegative();
export const fulfillmentResult = adminOrderDetail.unwrap().shape.fulfillments.element.omit({ lines: true });
export const inventoryLevel = z.strictObject({
  variant_id: id,
  location_id: id,
  on_hand: quantity,
  reservation_revision: quantity,
});
export const inventoryAvailability = inventoryLevel.omit({ reservation_revision: true }).extend({
  reserved: quantity,
  available: z.number().int(),
});
export const adminLocation = z.strictObject({
  id,
  code: z.string(),
  name: z.string(),
  address: z.json(),
  is_default: z.boolean(),
  is_active: z.boolean(),
  revision: version,
  created_at: timestamp,
});
export const adminLocationPage = z.strictObject({
  items: z.array(adminLocation).max(100),
  next_cursor: id.nullable(),
});
export const inventoryMovementPage = z.strictObject({
  items: z
    .array(
      z.strictObject({
        id: bigintString,
        variant_id: id,
        location_id: id,
        delta: z.number().int(),
        on_hand_after: z.number().int(),
        reason: z.enum(['order', 'cancel', 'restock', 'adjust', 'return', 'transfer_out', 'transfer_in']),
        order_id: id.nullable(),
        actor_id: id.nullable(),
        note: z.string().nullable(),
        transfer_id: id.nullable(),
        created_at: timestamp,
      }),
    )
    .max(100),
  next_cursor: bigintString.nullable(),
});
export const inventoryTransfer = z.strictObject({
  id,
  variant_id: id,
  from_location_id: id,
  to_location_id: id,
  quantity: quantity.positive(),
  from_on_hand_after: quantity,
  to_on_hand_after: quantity,
  out_movement_id: bigintString,
  in_movement_id: bigintString,
  actor_id: id.nullable(),
  note: z.string().nullable(),
  created_at: timestamp,
});
const transactionStatus = z.enum(['pending', 'succeeded', 'failed', 'cancelled']);
export const orderLedger = z.strictObject({
  order: adminOrderPage.shape.items.element
    .omit({ customer_id: true, email: true })
    .extend({ subtotal: money }),
  balances: z.strictObject({
    adjustment_total: z.number(),
    captured: money,
    refunded: money,
    net_paid: z.number(),
    is_balanced: z.boolean(),
  }),
  adjustments: z.array(
    z.strictObject({
      id: bigintString,
      order_item_id: id.nullable(),
      kind: z.enum(['discount', 'shipping', 'tax', 'manual', 'rounding']),
      amount: z.number(),
      currency: z.literal('USD'),
      label: z.string(),
      source_type: z.string(),
      source_ref: z.string().nullable(),
      created_at: timestamp,
    }),
  ),
  payment_intents: z.array(
    z.strictObject({
      id,
      provider: z.literal('paypal'),
      status: z.enum(['requires_action', 'processing', 'succeeded', 'failed', 'cancelled']),
      amount: money,
      currency: z.literal('USD'),
      provider_reference: z.string().nullable(),
      created_at: timestamp,
      updated_at: timestamp,
    }),
  ),
  transactions: z.array(
    z.strictObject({
      id,
      payment_intent_id: id.nullable(),
      parent_transaction_id: id.nullable(),
      provider: z.string(),
      kind: z.enum(['authorization', 'capture', 'refund', 'void']),
      status: transactionStatus,
      amount: money,
      currency: z.literal('USD'),
      provider_reference: z.string().nullable(),
      processed_at: timestamp.nullable(),
      created_at: timestamp,
    }),
  ),
  refunds: z.array(
    z.strictObject({
      id,
      payment_transaction_id: id.nullable(),
      status: transactionStatus,
      source: z.enum(['items', 'shipping', 'custom_amount', 'remaining', 'legacy']),
      amount: money,
      currency: z.literal('USD'),
      reason: z.string().nullable(),
      restock_requested: z.boolean(),
      components: z.array(
        z.strictObject({
          kind: z.enum(['tax', 'shipping', 'unallocated']),
          tax_line_id: id.nullable(),
          shipping_line_id: id.nullable(),
          amount: money,
        }),
      ),
      created_at: timestamp,
      lines: z.array(
        z.strictObject({
          order_item_id: id,
          quantity,
          amount: money,
          cancelled_quantity: quantity,
          restocked_quantity: quantity,
        }),
      ),
    }),
  ),
  fulfillments: z.array(
    adminOrderDetail.unwrap().shape.fulfillments.element.omit({ order_id: true, version: true }),
  ),
});
export const fulfillmentBalance = z.strictObject({
  order_id: id,
  payment_hold: z.boolean(),
  is_fulfillable: z.boolean(),
  lines: z.array(
    z.strictObject({
      order_item_id: id,
      ordered_quantity: quantity,
      fulfilled_quantity: quantity,
      cancelled_quantity: quantity,
      reserved_quantity: quantity,
      available_quantity: quantity,
    }),
  ),
});
export const returnDisposition = z.strictObject({
  id,
  receipt_line_id: id,
  quantity: quantity.positive(),
  disposition: z.enum(['restock', 'discard']),
  inventory_movement_id: bigintString.nullable(),
  note: z.string().nullable(),
  created_at: timestamp,
});
export const returnReceipt = z.strictObject({
  id,
  return_id: id,
  order_id: id,
  location_id: id,
  note: z.string().nullable(),
  received_at: timestamp,
  lines: z.array(
    z.strictObject({
      id,
      return_line_id: id,
      quantity: quantity.positive(),
      undisposed_quantity: quantity,
      dispositions: z.array(returnDisposition),
    }),
  ),
});
export const returnAuthorization = z.strictObject({
  id,
  order_id: id,
  fulfillment_id: id,
  status: z.enum(['open', 'closed', 'cancelled']),
  reason: z.string().nullable(),
  created_at: timestamp,
  closed_at: timestamp.nullable(),
  lines: z.array(
    z.strictObject({
      id,
      order_item_id: id,
      quantity: quantity.positive(),
      received_quantity: quantity,
      receivable_quantity: quantity,
    }),
  ),
  receipts: z.array(returnReceipt),
});
export const orderReturns = z.strictObject({
  order_id: id,
  lines: z.array(
    z.strictObject({
      fulfillment_id: id,
      order_item_id: id,
      shipped_quantity: quantity,
      authorized_unreceived_quantity: quantity,
      received_quantity: quantity,
      available_quantity: quantity,
    }),
  ),
  returns: z.array(returnAuthorization),
});

const decimalAmount = z.string().regex(/^(0|[1-9][0-9]*)\.[0-9]{2}$/);
export const paymentSummary = z.strictObject({
  start_at: timestamp,
  end_at: timestamp,
  currency: z.literal('USD'),
  time_basis: z.literal('payment_transactions.created_at'),
  capture_count: z.string().regex(/^(0|[1-9][0-9]*)$/),
  refund_count: z.string().regex(/^(0|[1-9][0-9]*)$/),
  captured_amount: decimalAmount,
  refunded_amount: decimalAmount,
  net_amount: z.string().regex(/^-?(0|[1-9][0-9]*)\.[0-9]{2}$/),
});
const paymentOperation = z.strictObject({
  id,
  order_id: id,
  provider: z.literal('paypal'),
  amount: decimalAmount,
  currency: z.literal('USD'),
  created_at: timestamp,
});
const polling = {
  last_provider_poll_at: timestamp.nullable(),
  provider_poll_attempts: z.number().int().nonnegative(),
  updated_at: timestamp,
};
const paymentIntent = paymentOperation.extend({
  payment_method: z.enum(['paypal', 'card']),
  status: z.enum(['requires_action', 'processing', 'succeeded', 'failed', 'cancelled']),
  expires_at: timestamp,
  provider_capture_requested_at: timestamp.nullable(),
  ...polling,
});
const refundRequest = paymentOperation.extend({
  parent_transaction_id: id,
  status: z.enum(['requested', 'submitted', 'processing', 'succeeded', 'failed', 'cancelled']),
  source: z.enum(['items', 'shipping', 'custom_amount', 'remaining']),
  restock_requested: z.boolean(),
  result_refund_id: id.nullable(),
  has_error: z.boolean(),
  submitted_at: timestamp.nullable(),
  processed_at: timestamp.nullable(),
  provider_refund_requested_at: timestamp.nullable(),
  ...polling,
});
const moneyMovement = paymentOperation.extend({
  // Unmatched provider facts may be non-USD and have eight fractional digits.
  amount: z.string().regex(/^(0|[1-9][0-9]*)\.[0-9]{8}$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  provider_event_id: id,
  kind: z.enum(['capture', 'refund']),
  payment_intent_id: id.nullable(),
  refund_request_id: id.nullable(),
  payment_transaction_id: id.nullable(),
  reconciliation_status: z.enum(['unmatched', 'matched', 'action_required']),
  has_error: z.boolean(),
  matched_at: timestamp.nullable(),
});
const paymentPage = z.strictObject({ order_id: id, next_cursor: id.nullable() });
export const paymentOperations = z.discriminatedUnion('kind', [
  paymentPage.extend({ kind: z.literal('payment_intent'), items: z.array(paymentIntent).max(100) }),
  paymentPage.extend({ kind: z.literal('refund_request'), items: z.array(refundRequest).max(100) }),
  paymentPage.extend({ kind: z.literal('money_movement'), items: z.array(moneyMovement).max(100) }),
]);
const diagnosticTimestamp = z.union([timestamp, z.enum(['infinity', '-infinity'])]);
export const outboxPage = z.strictObject({
  items: z
    .array(
      z.strictObject({
        id: bigintString,
        event_id: id,
        aggregate_type: z.string(),
        aggregate_id: id,
        event_type: z.string(),
        status: z.enum(['pending', 'processing', 'published', 'failed', 'exhausted']),
        attempts: quantity,
        retry_start: quantity,
        available_at: diagnosticTimestamp,
        lease_expires_at: diagnosticTimestamp.nullable(),
        published_at: timestamp.nullable(),
        created_at: timestamp,
        has_error: z.boolean(),
        last_redrive: z
          .strictObject({
            attempts: quantity,
            worker_id: z.string(),
            reason: z.string(),
            created_at: timestamp,
          })
          .nullable(),
      }),
    )
    .max(100),
  next_after_id: bigintString.nullable(),
});
const diagnosticPage = z.strictObject({
  next_cursor: z.strictObject({ created_at: timestamp, id }).nullable(),
});
export const providerEventPage = diagnosticPage.extend({
  items: z
    .array(
      z.strictObject({
        id,
        provider: z.literal('paypal'),
        provider_event_id: z.string(),
        source: z.enum(['webhook', 'api_response']),
        event_type: z.string(),
        status: z.enum(['received', 'processed', 'ignored', 'failed']),
        livemode: z.boolean(),
        resource_type: z
          .enum(['payment_intent', 'payment_transaction', 'refund_request', 'provider_money_movement'])
          .nullable(),
        resource_id: id.nullable(),
        attempts: quantity,
        automatic_retry_exhausted: z.boolean(),
        next_attempt_at: diagnosticTimestamp,
        processed_at: timestamp.nullable(),
        occurred_at: timestamp,
        created_at: timestamp,
        has_error: z.boolean(),
      }),
    )
    .max(100),
});
export const reconciliationPage = diagnosticPage.extend({
  items: z
    .array(
      moneyMovement.omit({ payment_transaction_id: true, matched_at: true }).extend({
        order_id: id.nullable(),
        reconciliation_status: z.enum(['unmatched', 'action_required']),
      }),
    )
    .max(100),
});
const countString = z.string().regex(/^(0|[1-9][0-9]*)$/);
export const orderSummary = z.strictObject({
  start_at: timestamp,
  end_at: timestamp,
  currency: z.literal('USD'),
  time_basis: z.literal('orders.created_at'),
  order_count: countString,
  order_total_amount: decimalAmount,
  status_counts: z.strictObject({
    open: countString.optional(),
    completed: countString.optional(),
    cancelled: countString.optional(),
  }),
  financial_status_counts: z.strictObject({
    pending: countString.optional(),
    paid: countString.optional(),
    partially_refunded: countString.optional(),
    refunded: countString.optional(),
    voided: countString.optional(),
  }),
  fulfillment_status_counts: z.strictObject({
    unfulfilled: countString.optional(),
    partially_fulfilled: countString.optional(),
    fulfilled: countString.optional(),
  }),
});
export const orderExport = z.strictObject({
  start_at: timestamp,
  end_at: timestamp,
  items: z
    .array(
      adminOrderPage.shape.items.element.omit({ customer_id: true, email: true }).extend({
        subtotal: decimalAmount,
        discount_total: decimalAmount,
        shipping_total: decimalAmount,
        tax_total: decimalAmount,
        total: decimalAmount,
        updated_at: timestamp,
      }),
    )
    .max(100),
  next_cursor: id.nullable(),
});
export const shopSettings = z.strictObject({
  name: z.string(),
  timezone: z.string(),
  currency: z.literal('USD'),
  revision: version,
  updated_at: timestamp,
});
const operationsBase = z.strictObject({
  start_at: timestamp,
  end_at: timestamp,
  observed_at: timestamp,
  unresolved_count: countString,
  oldest_created_at: timestamp.nullable(),
});
export const operationsSummary = z.discriminatedUnion('component', [
  operationsBase.extend({
    component: z.literal('outbox'),
    status_counts: z.strictObject({
      pending: countString.optional(),
      processing: countString.optional(),
      failed: countString.optional(),
      exhausted: countString.optional(),
    }),
    ready_count: countString,
    expired_lease_count: countString,
    retry_exhausted_count: countString,
  }),
  operationsBase.extend({
    component: z.literal('inbox'),
    status_counts: z.strictObject({ received: countString.optional(), failed: countString.optional() }),
    ready_count: countString,
    expired_lease_count: z.null(),
    retry_exhausted_count: countString,
  }),
  operationsBase.extend({
    component: z.literal('reconciliation'),
    status_counts: z.strictObject({
      unmatched: countString.optional(),
      action_required: countString.optional(),
    }),
    ready_count: z.null(),
    expired_lease_count: z.null(),
    retry_exhausted_count: z.null(),
  }),
]);
// Preserve key identity across clients. PostgreSQL owns btrim and character
// length validation; JS trim/UTF-16 length have different semantics.
export const key = z
  .string()
  .describe(
    'Keep the same key and identical arguments for retries. The database validates 1–200 characters after trimming ordinary spaces.',
  );
export const pageSize = z.number().int().min(1).max(100).optional();
export const metafieldOwner = z.enum(['product', 'variant', 'category', 'customer', 'order', 'shop']);
export const search = z.string().max(200).optional();
export const reason = z.string().max(2000).optional();
export const order = z.strictObject({ order_id: id });
export const createdCursor = z.strictObject({ created_at: z.string().min(1), id }).optional();
export const promotionType = z.enum([
  'order_percentage',
  'order_fixed',
  'item_percentage',
  'buy_x_get_y',
  'free_shipping',
]);
export const promotionResult = z.strictObject({
  id,
  revision: version,
  name: z.string(),
  code: z.string().nullable(),
  type: promotionType,
  params: jsonObject,
  priority: z.number().int().min(-2147483648).max(2147483647),
  stackable: z.boolean(),
  apply_scope: z.enum(['all', 'selected']),
  get_scope: z.enum(['same_as_apply', 'selected']),
  usage_limit: quantity.positive().nullable(),
  used_count: quantity,
  per_customer_limit: quantity.positive(),
  starts_at: diagnosticTimestamp.nullable(),
  ends_at: diagnosticTimestamp.nullable(),
  is_active: z.boolean(),
  created_at: timestamp,
  updated_at: timestamp,
});
export const promotionPage = z.strictObject({
  items: z.array(promotionResult).max(100),
  next_cursor: id.nullable(),
});
export const promotionTargetPage = z.strictObject({
  items: z
    .array(
      z
        .strictObject({
          id,
          promotion_id: id,
          role: z.enum(['apply', 'get']),
          product_id: id.nullable(),
          category_id: id.nullable(),
          variant_id: id.nullable(),
        })
        .refine(
          (t) => [t.product_id, t.category_id, t.variant_id].filter((v) => v !== null).length === 1,
          'Exactly one target reference is required',
        ),
    )
    .max(100),
  next_cursor: id.nullable(),
});
export const discountRedemptionPage = z.strictObject({
  items: z
    .array(
      z.strictObject({
        id,
        promotion_id: id,
        customer_id: id,
        order_id: id.nullable(),
        created_at: timestamp,
      }),
    )
    .max(100),
  next_cursor: id.nullable(),
});
export const promotionChanges = z.strictObject({
  name: z.string().optional(),
  code: z.string().nullable().optional(),
  type: promotionType.optional(),
  params: z.record(z.string(), z.json()).optional(),
  priority: z.number().int().min(-2147483648).max(2147483647).optional(),
  stackable: z.boolean().optional(),
  apply_scope: z.enum(['all', 'selected']).optional(),
  get_scope: z.enum(['same_as_apply', 'selected']).optional(),
  usage_limit: z.number().int().positive().max(2147483647).nullable().optional(),
  per_customer_limit: z.number().int().positive().max(2147483647).optional(),
  starts_at: z.string().nullable().optional(),
  ends_at: z.string().nullable().optional(),
  is_active: z.boolean().optional(),
  targets: z
    .array(
      z
        .strictObject({
          role: z.enum(['apply', 'get']),
          product_id: id.nullable().optional(),
          category_id: id.nullable().optional(),
          variant_id: id.nullable().optional(),
        })
        .refine(
          (t) => [t.product_id, t.category_id, t.variant_id].filter((v) => v != null).length === 1,
          'Exactly one target reference is required',
        ),
    )
    .max(100)
    .optional(),
});
export const locationChanges = z.strictObject({
  code: z.string().optional(),
  name: z.string().optional(),
  address: z.json().optional(),
  is_active: z.boolean().optional(),
});
export const customerChanges = z.strictObject({
  email: z.string().nullable().optional(),
  full_name: z.string().optional(),
  phone: z.string().nullable().optional(),
});
export const addressChanges = z.strictObject({
  label: z.string().optional(),
  recipient_name: z.string().optional(),
  phone: z.string().nullable().optional(),
  country: z.string().optional(),
  region: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  line1: z.string().optional(),
  line2: z.string().nullable().optional(),
  postal_code: z.string().nullable().optional(),
});
// Bound inline protocol payloads independently of Storage's 5 MiB limit.
export const productMediaIdentity = z.strictObject({
  product_id: id,
  media_id: id,
  content_type: z.enum(['image/jpeg', 'image/png', 'image/webp']),
});
export const uploadProductMedia = productMediaIdentity.extend({
  data_base64: z
    .string()
    .min(4)
    .max(1398104)
    .refine((value) => {
      if (value.length > 1398104) return false;
      const bytes = Buffer.from(value, 'base64');
      return bytes.length > 0 && bytes.length <= 1048576 && bytes.toString('base64') === value;
    }, 'Expected canonical base64 for 1 byte to 1 MiB'),
});
export const itemQuantities = z
  .array(z.strictObject({ order_item_id: id, quantity: version }))
  .min(1)
  .max(100);
const position = z.number().int().min(-2147483648).max(2147483647);
const productSummary = z.strictObject({
  id,
  slug: z.string(),
  name: z.string(),
  status: z.enum(['draft', 'active', 'archived']),
  revision: version,
  updated_at: timestamp,
  currency: z.literal('USD'),
});
export const adminProductPage = z.strictObject({
  items: z
    .array(
      productSummary.extend({
        price_from: money.nullable(),
        price_to: money.nullable(),
        variant_count: quantity,
        primary_image: z.string().nullable(),
      }),
    )
    .max(100),
  next_cursor: z.strictObject({ updated_at: timestamp, id }).nullable(),
});
const catalogMetafields = z.array(
  z.strictObject({
    namespace: z.string(),
    key: z.string(),
    type: z.string(),
    value: z.json(),
  }),
);
export const adminProduct = productSummary.extend({
  created_at: timestamp,
  description: z.string(),
  vendor: z.string(),
  product_type: z.string(),
  tags: z.array(z.string()),
  seo_title: z.string().nullable(),
  seo_description: z.string().nullable(),
  metafields: catalogMetafields,
  variants: z.array(
    z.strictObject({
      id,
      sku: z.string().nullable(),
      barcode: z.string().nullable(),
      price: money,
      compare_at_price: money.nullable(),
      // The stored cost column permits negative values; output is not a write command.
      cost: z.number().nullable(),
      position,
      in_stock: z.boolean(),
      is_active: z.boolean(),
      track_inventory: z.boolean(),
      option_value_ids: z.array(id),
      metafields: catalogMetafields,
    }),
  ),
  options: z.array(
    z.strictObject({
      id,
      name: z.string(),
      position,
      values: z.array(z.strictObject({ id, value: z.string(), position })),
    }),
  ),
  images: z.array(
    z.strictObject({
      id,
      url: z.string(),
      alt: z.string(),
      position,
      variant_id: id.nullable(),
    }),
  ),
  categories: z.array(z.strictObject({ id, slug: z.string(), name: z.string() })),
});
export const productMediaResult = z.strictObject({ path: z.string().min(1), url: z.url() });
export const productMediaInspection = productMediaResult.extend({
  content_type: productMediaIdentity.shape.content_type,
  byte_size: z.number().int().min(1).max(5242880),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export const adminProductMediaPage = z.strictObject({
  items: z.array(
    z.strictObject({
      id,
      product_id: id,
      media_id: id,
      path: z.string().regex(/^products\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp)$/),
      expected_content_type: productMediaIdentity.shape.content_type,
    }),
  ),
  next_cursor: id.nullable(),
});
export const metafieldType = z.enum([
  'text',
  'rich_text',
  'number',
  'boolean',
  'date',
  'datetime',
  'url',
  'color',
  'json',
  'list_text',
  'list_number',
  'metaobject_reference',
  'list_metaobject_reference',
]);
export const metafieldDefinitionChanges = z.strictObject({
  name: z.string().optional(),
  description: z.string().optional(),
  type: metafieldType.optional(),
  access: z.enum(['admin', 'public', 'customer']).optional(),
  validations: z
    .strictObject({
      min: z.number().optional(),
      max: z.number().optional(),
      choices: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
    })
    .optional(),
  position: position.optional(),
});
export const metaobjectFields = z
  .array(
    z.strictObject({
      key: z.string(),
      name: z.string().optional(),
      type: metafieldType.exclude(['metaobject_reference', 'list_metaobject_reference']),
      required: z.boolean().optional(),
      validations: metafieldDefinitionChanges.shape.validations,
    }),
  )
  .max(100);
export const metaobjectDefinitionChanges = z.strictObject({
  name: z.string().optional(),
  description: z.string().optional(),
  fields: metaobjectFields.optional(),
  access: z.enum(['admin', 'public']).optional(),
  is_active: z.boolean().optional(),
});
export const metafieldDefinitionResult = z.strictObject({
  id,
  revision: version,
  owner_type: metafieldOwner,
  namespace: z.string(),
  key: z.string(),
  name: z.string(),
  type: metafieldType,
  access: z.enum(['admin', 'public', 'customer']),
  description: z.string(),
  validations: metafieldDefinitionChanges.shape.validations.unwrap(),
  position,
  created_at: timestamp,
  updated_at: timestamp,
});
export const metafieldResult = z.strictObject({
  id,
  revision: version,
  owner_type: metafieldOwner,
  owner_id: id,
  namespace: z.string(),
  key: z.string(),
  type: metafieldType,
  value: z.json(),
  created_at: timestamp,
  updated_at: timestamp,
  definition_id: id.nullable(),
  definition_access: z.enum(['admin', 'public', 'customer']),
});
export const metaobjectDefinitionResult = z.strictObject({
  id,
  revision: version,
  type: z.string(),
  name: z.string(),
  description: z.string(),
  fields: metaobjectFields,
  access: z.enum(['admin', 'public']),
  is_active: z.boolean(),
  created_at: timestamp,
  updated_at: timestamp,
});
export const metaobjectResult = z.strictObject({
  id,
  revision: version,
  definition_id: id,
  handle: z.string(),
  values: z.record(z.string(), z.json()),
  status: z.enum(['draft', 'active']),
  created_at: timestamp,
  updated_at: timestamp,
  definition_type: z.string(),
  definition_access: z.enum(['admin', 'public']),
  definition_is_active: z.boolean(),
  is_public: z.boolean(),
});
export const metafieldDefinitionPage = z.strictObject({
  items: z.array(metafieldDefinitionResult).max(100),
  next_cursor: id.nullable(),
});
export const metafieldPage = z.strictObject({
  items: z.array(metafieldResult).max(100),
  next_cursor: id.nullable(),
});
export const metaobjectDefinitionPage = z.strictObject({
  items: z.array(metaobjectDefinitionResult).max(100),
  next_cursor: id.nullable(),
});
export const metaobjectPage = z.strictObject({
  items: z.array(metaobjectResult).max(100),
  next_cursor: id.nullable(),
});
export const metadataDeletion = z.strictObject({ id, deleted: z.literal(true) });
export const taxFraction = z.number().min(0).max(1);
export const taxRateChanges = z.strictObject({
  name: z.string().optional(),
  country: z.string().optional(),
  rate: taxFraction.optional(),
  include_shipping: z.boolean().optional(),
  is_active: z.boolean().optional(),
});
export const shippingMoney = z.number().nonnegative().max(9999999999.99);
export const shippingMethodChanges = z.strictObject({
  name: z.string().optional(),
  description: z.string().optional(),
  countries: z.array(z.string()).optional(),
  price: shippingMoney.optional(),
  free_above: shippingMoney.nullable().optional(),
  estimated_days: z.string().optional(),
  position: position.optional(),
  is_active: z.boolean().optional(),
});
export const categoryChanges = z.strictObject({
  slug: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  parent_id: id.nullable().optional(),
  image_url: z.string().nullable().optional(),
  position: position.optional(),
  is_active: z.boolean().optional(),
});
export const categoryResult = z.strictObject({
  id,
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  parent_id: id.nullable(),
  image_url: z.string().nullable(),
  position,
  is_active: z.boolean(),
  created_at: timestamp,
  updated_at: timestamp,
});
export const shippingMethodResult = z.strictObject({
  id,
  revision: version,
  name: z.string(),
  description: z.string(),
  countries: z.array(z.string().regex(/^[A-Z]{2}$/)),
  price: shippingMoney,
  // Historical table rows can have a negative threshold; do not reinterpret it.
  free_above: z.number().min(-9999999999.99).max(9999999999.99).nullable(),
  estimated_days: z.string(),
  position,
  is_active: z.boolean(),
  created_at: timestamp,
  updated_at: timestamp,
});
export const taxRateResult = z.strictObject({
  id,
  revision: version,
  name: z.string(),
  country: z.string().regex(/^(\*|[A-Z]{2})$/),
  rate: taxFraction,
  include_shipping: z.boolean(),
  is_active: z.boolean(),
  created_at: timestamp,
});
export const categoryPage = z.strictObject({
  items: z.array(categoryResult).max(100),
  next_cursor: id.nullable(),
});
export const shippingMethodPage = z.strictObject({
  items: z.array(shippingMethodResult).max(100),
  next_cursor: id.nullable(),
});
export const taxRatePage = z.strictObject({
  items: z.array(taxRateResult).max(100),
  next_cursor: id.nullable(),
});
const deletion = z.strictObject({ id, delete: z.literal(true) });
const resources = <S extends z.ZodType>(schema: S) =>
  z
    .array(z.union([schema, deletion]))
    .max(500)
    .optional();

// Full PATCH shape, not a free-form record of database columns. The database
// remains authoritative for cross-resource, decimal and publication rules.
export const productChanges = z.strictObject({
  product: z
    .strictObject({
      slug: z.string().optional(),
      name: z.string().optional(),
      description: z.string().optional(),
      status: z.enum(['draft', 'active', 'archived']).optional(),
      vendor: z.string().optional(),
      product_type: z.string().optional(),
      tags: z.array(z.string()).optional(),
      seo_title: z.string().nullable().optional(),
      seo_description: z.string().nullable().optional(),
    })
    .optional(),
  options: resources(z.strictObject({ id, name: z.string().optional(), position: position.optional() })),
  option_values: resources(
    z.strictObject({
      id,
      option_id: id.optional(),
      value: z.string().optional(),
      position: position.optional(),
    }),
  ),
  variants: resources(
    z.strictObject({
      id,
      sku: z.string().nullable().optional(),
      barcode: z.string().nullable().optional(),
      price: money.optional(),
      compare_at_price: money.nullable().optional(),
      cost: money.nullable().optional(),
      track_inventory: z.boolean().optional(),
      position: position.optional(),
      is_active: z.boolean().optional(),
    }),
  ),
  variant_options: z
    .array(z.strictObject({ id, option_value_ids: z.array(id) }))
    .max(500)
    .optional(),
  images: resources(
    z.strictObject({
      id,
      variant_id: id.nullable().optional(),
      url: z.string().optional(),
      alt: z.string().optional(),
      position: position.optional(),
    }),
  ),
  category_ids: z.array(id).max(500).optional(),
  metafields: z
    .array(
      z.union([
        z.strictObject({
          namespace: z.string(),
          key: z.string(),
          variant_id: id.optional(),
          type: z.string(),
          value: z.json(),
        }),
        z.strictObject({
          namespace: z.string(),
          key: z.string(),
          variant_id: id.optional(),
          delete: z.literal(true),
        }),
      ]),
    )
    .max(500)
    .optional(),
});

export const refund = z
  .strictObject({
    order_id: id,
    idempotency_key: key,
    items: itemQuantities.optional(),
    amount: money.positive().optional(),
    shipping_amount: money.positive().optional(),
    reason,
    restock: z.boolean().optional(),
    provider: z.string().optional(),
  })
  .refine(
    (value) =>
      value.amount === undefined || (value.items === undefined && value.shipping_amount === undefined),
    {
      message: 'amount is mutually exclusive with items and shipping_amount',
    },
  )
  .refine((value) => !value.restock || value.items !== undefined, { message: 'restock requires items' });

const paypalMoney = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,2})?$/)
  .refine((value) => Number(value) > 0, 'Amount must be positive');
export const paypalRefund = z
  .strictObject({
    order_id: id,
    idempotency_key: key,
    amount: paypalMoney.optional(),
    shipping_amount: paypalMoney.optional(),
    items: itemQuantities.optional(),
    reason: z.string().max(1000).optional(),
    restock: z.boolean().optional(),
  })
  .refine(
    (v) => v.amount !== undefined || v.shipping_amount !== undefined || v.items !== undefined,
    'Explicit amount, items or shipping_amount required',
  )
  .refine(
    (v) => v.amount === undefined || (v.items === undefined && v.shipping_amount === undefined),
    'amount is mutually exclusive with items and shipping_amount',
  )
  .refine((v) => !v.restock || v.items !== undefined, 'restock requires items');
