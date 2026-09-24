type RecordValue = Record<string, unknown>;

const invalid = (label: string) =>
  Error(`Invalid ${label} response. Reload the saved record before editing.`);

function record(value: unknown, label: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(label);
  return value as RecordValue;
}

function fields(value: RecordValue, label: string, shape: Record<string, string>) {
  for (const [key, type] of Object.entries(shape)) {
    const item = value[key];
    if (type === 'array' ? !Array.isArray(item) : typeof item !== type) throw invalid(label);
  }
}

function nullable(value: RecordValue, key: string, type: string, label: string) {
  if (!(key in value) || (value[key] !== null && typeof value[key] !== type)) throw invalid(label);
}

function finite(value: unknown, integer = false) {
  return typeof value === 'number' && Number.isFinite(value) && (!integer || Number.isSafeInteger(value));
}

function strings(value: unknown) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function identity(value: RecordValue, id: string, label: string) {
  // PostgreSQL returns canonical lowercase UUIDs even for uppercase route IDs.
  if (typeof value.id !== 'string' || value.id.toLowerCase() !== id.toLowerCase())
    throw Error(`Invalid ${label} identity. Reload the saved record before editing.`);
}

function revision(value: RecordValue, expected: number | null, label: string) {
  const next = value.revision;
  if (!finite(next, true) || (next as number) < 1 || (expected !== null && (next as number) < expected))
    throw Error(`Invalid ${label} revision. Reload the saved record before editing.`);
}

// PostgreSQL timestamps carry microseconds. Date.parse truncates those to milliseconds,
// so compare a normalized integer count instead of round-tripping through Date.
function timestampMicros(value: unknown): bigint | null {
  if (typeof value !== 'string') return null;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return null;
  const [, ys, mos, ds, hs, mis, ss, fraction = '', zone, sign, ohs, oms] = match;
  const [year, month, day, hour, minute, second] = [ys, mos, ds, hs, mis, ss].map(Number);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const offsetHour = zone === 'Z' ? 0 : Number(ohs);
  const offsetMinute = zone === 'Z' ? 0 : Number(oms);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  )
    return null;
  const millis = Date.UTC(year, month - 1, day, hour, minute, second);
  const direction = sign === '-' ? -1 : 1;
  const offset = direction * (offsetHour * 60 + offsetMinute);
  return BigInt(millis) * 1000n - BigInt(offset) * 60_000_000n + BigInt(fraction.padEnd(6, '0'));
}

function timestamp(value: RecordValue, expected: string | null, label: string) {
  const next = timestampMicros(value.updated_at);
  const previous = expected === null ? null : timestampMicros(expected);
  if (next === null || (expected !== null && (previous === null || next < previous)))
    throw Error(`Invalid ${label} revision. Reload the saved record before editing.`);
}

function productArrays(item: RecordValue) {
  const fail = () => {
    throw invalid('product');
  };
  for (const imageValue of item.images as unknown[]) {
    const image = record(imageValue, 'product');
    fields(image, 'product', {
      id: 'string',
      url: 'string',
      alt: 'string',
      position: 'number',
    });
    nullable(image, 'variant_id', 'string', 'product');
    if (!finite(image.position, true)) fail();
  }
  for (const variantValue of item.variants as unknown[]) {
    const variant = record(variantValue, 'product');
    fields(variant, 'product', {
      id: 'string',
      price: 'number',
      is_active: 'boolean',
      track_inventory: 'boolean',
      option_value_ids: 'array',
    });
    nullable(variant, 'sku', 'string', 'product');
    if (!finite(variant.price) || (variant.price as number) < 0 || !strings(variant.option_value_ids)) fail();
  }
  for (const optionValue of item.options as unknown[]) {
    const option = record(optionValue, 'product');
    fields(option, 'product', {
      id: 'string',
      name: 'string',
      position: 'number',
      values: 'array',
    });
    if (!finite(option.position, true)) fail();
    for (const valueValue of option.values as unknown[]) {
      const value = record(valueValue, 'product');
      fields(value, 'product', {
        id: 'string',
        value: 'string',
        position: 'number',
      });
      if (!finite(value.position, true)) fail();
    }
  }
  for (const categoryValue of item.categories as unknown[])
    fields(record(categoryValue, 'product'), 'product', {
      id: 'string',
      name: 'string',
      slug: 'string',
    });
}

export function productReceipt(value: unknown, id: string, expected: number | null) {
  const item = record(value, 'product');
  identity(item, id, 'product');
  revision(item, expected, 'product');
  fields(item, 'product', {
    name: 'string',
    slug: 'string',
    status: 'string',
    description: 'string',
    vendor: 'string',
    product_type: 'string',
    images: 'array',
    variants: 'array',
    options: 'array',
    categories: 'array',
  });
  if (!['draft', 'active', 'archived'].includes(item.status as string)) throw invalid('product');
  productArrays(item);
  return item;
}

export function categoryReceipt(value: unknown, id: string, expected: string | null) {
  const item = record(value, 'category');
  identity(item, id, 'category');
  timestamp(item, expected, 'category');
  fields(item, 'category', {
    name: 'string',
    slug: 'string',
    description: 'string',
    position: 'number',
    is_active: 'boolean',
    created_at: 'string',
  });
  nullable(item, 'parent_id', 'string', 'category');
  nullable(item, 'image_url', 'string', 'category');
  if (!finite(item.position, true)) throw invalid('category');
  return item;
}

export function locationReceipt(value: unknown, id: string, expected: number | null) {
  const item = record(value, 'warehouse');
  identity(item, id, 'warehouse');
  revision(item, expected, 'warehouse');
  fields(item, 'warehouse', {
    name: 'string',
    code: 'string',
    is_default: 'boolean',
    is_active: 'boolean',
    created_at: 'string',
  });
  if (!('address' in item)) throw invalid('warehouse');
  return item;
}

export function shippingReceipt(value: unknown, id: string, expected: number | null) {
  const item = record(value, 'shipping method');
  identity(item, id, 'shipping method');
  revision(item, expected, 'shipping method');
  fields(item, 'shipping method', {
    name: 'string',
    description: 'string',
    countries: 'array',
    price: 'number',
    estimated_days: 'string',
    position: 'number',
    is_active: 'boolean',
    created_at: 'string',
    updated_at: 'string',
  });
  nullable(item, 'free_above', 'number', 'shipping method');
  if (
    !strings(item.countries) ||
    !(item.countries as string[]).every((country) => /^[A-Z]{2}$/.test(country)) ||
    !finite(item.price) ||
    (item.price as number) < 0 ||
    (item.free_above !== null && !finite(item.free_above)) ||
    !finite(item.position, true)
  )
    throw invalid('shipping method');
  return item;
}

export function taxReceipt(value: unknown, id: string, expected: number | null) {
  const item = record(value, 'tax rate');
  identity(item, id, 'tax rate');
  revision(item, expected, 'tax rate');
  fields(item, 'tax rate', {
    name: 'string',
    country: 'string',
    rate: 'number',
    include_shipping: 'boolean',
    is_active: 'boolean',
    created_at: 'string',
  });
  if (
    !/^(?:[A-Z]{2}|\*)$/.test(item.country as string) ||
    !finite(item.rate) ||
    (item.rate as number) < 0 ||
    (item.rate as number) > 1
  )
    throw invalid('tax rate');
  return item;
}

export function promotionReceipt(value: unknown, id: string, expected: number | null) {
  const item = record(value, 'promotion');
  identity(item, id, 'promotion');
  revision(item, expected, 'promotion');
  fields(item, 'promotion', {
    name: 'string',
    type: 'string',
    params: 'object',
    priority: 'number',
    stackable: 'boolean',
    apply_scope: 'string',
    get_scope: 'string',
    used_count: 'number',
    per_customer_limit: 'number',
    is_active: 'boolean',
    created_at: 'string',
    updated_at: 'string',
  });
  for (const key of ['code', 'starts_at', 'ends_at'] as const) nullable(item, key, 'string', 'promotion');
  nullable(item, 'usage_limit', 'number', 'promotion');
  if (
    !item.params ||
    Array.isArray(item.params) ||
    !['order_percentage', 'order_fixed', 'item_percentage', 'buy_x_get_y', 'free_shipping'].includes(
      item.type as string,
    ) ||
    !['all', 'selected'].includes(item.apply_scope as string) ||
    !['same_as_apply', 'selected'].includes(item.get_scope as string) ||
    !finite(item.priority, true) ||
    !finite(item.used_count, true) ||
    (item.used_count as number) < 0 ||
    !finite(item.per_customer_limit, true) ||
    (item.per_customer_limit as number) < 1 ||
    (item.usage_limit !== null && (!finite(item.usage_limit, true) || (item.usage_limit as number) < 1))
  )
    throw invalid('promotion');
  if (
    (item.starts_at !== null && timestampMicros(item.starts_at) === null) ||
    (item.ends_at !== null && timestampMicros(item.ends_at) === null)
  )
    throw invalid('promotion');
  return item;
}

export function customerReceipt(value: unknown, id: string, expected: string | null) {
  const item = record(value, 'customer');
  identity(item, id, 'customer');
  timestamp(item, expected, 'customer');
  fields(item, 'customer', {
    full_name: 'string',
    has_account: 'boolean',
    created_at: 'string',
    addresses: 'array',
  });
  for (const key of ['email', 'phone', 'anonymized_at'] as const) nullable(item, key, 'string', 'customer');
  for (const addressValue of item.addresses as unknown[]) {
    const address = record(addressValue, 'customer');
    fields(address, 'customer', {
      id: 'string',
      label: 'string',
      recipient_name: 'string',
      country: 'string',
      line1: 'string',
      is_default: 'boolean',
      updated_at: 'string',
    });
    for (const key of ['phone', 'region', 'city', 'line2', 'postal_code'] as const)
      nullable(address, key, 'string', 'customer');
  }
  return item;
}
