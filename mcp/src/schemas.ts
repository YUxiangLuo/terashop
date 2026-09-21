import * as z from 'zod/v4';

export const id = z.uuid();
export const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const orderNumber = z
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
      id: z.number().int(),
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
  inventory_movement_id: z.number().int().nullable(),
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
export const uploadProductMedia = z.strictObject({
  product_id: id,
  media_id: id,
  content_type: z.enum(['image/jpeg', 'image/png', 'image/webp']),
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
