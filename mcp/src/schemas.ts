import * as z from 'zod/v4';

export const id = z.uuid();
export const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
// Preserve key identity across clients. PostgreSQL owns btrim and character
// length validation; JS trim/UTF-16 length have different semantics.
export const key = z
  .string()
  .describe(
    'Keep the same key and identical arguments for retries. The database validates 1–200 characters after trimming ordinary spaces.',
  );
export const pageSize = z.number().int().min(1).max(100).optional();
export const search = z.string().max(200).optional();
export const reason = z.string().max(2000).optional();
export const order = z.strictObject({ order_id: id });
export const createdCursor = z.strictObject({ created_at: z.string().min(1), id }).optional();
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
const money = z
  .number()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER / 100);
const position = z.number().int().min(-2147483648).max(2147483647);
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
