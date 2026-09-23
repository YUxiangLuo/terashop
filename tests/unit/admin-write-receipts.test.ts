import { describe, expect, test } from 'bun:test';
import {
  categoryReceipt,
  customerReceipt,
  productReceipt,
  promotionReceipt,
  shippingReceipt,
} from '../../admin/src/lib/write-receipts';

const id = '11111111-1111-4111-8111-111111111111';
const product = {
  id,
  revision: 7,
  name: 'Draft',
  slug: 'draft',
  status: 'draft',
  description: '',
  vendor: '',
  product_type: '',
  images: [],
  variants: [],
  options: [],
  categories: [],
};
const shipping = {
  id,
  revision: 4,
  name: 'Ground',
  description: '',
  countries: ['US'],
  price: 5,
  free_above: null,
  estimated_days: '3 days',
  position: 0,
  is_active: true,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
};

describe('admin write receipt validation', () => {
  test('rejects null, wrong identity, stale revision and missing install fields', () => {
    expect(() => productReceipt(null, id, 7)).toThrow('Invalid product');
    expect(() => productReceipt({ ...product, id: 'other' }, id, 7)).toThrow('identity');
    expect(() => productReceipt({ ...product, revision: 6 }, id, 7)).toThrow('revision');
    const { variants: _, ...incomplete } = product;
    expect(() => productReceipt(incomplete, id, 7)).toThrow('Invalid product');
  });

  test('accepts a valid no-op receipt without requiring revision growth', () => {
    expect(productReceipt(product, id, 7)).toBe(product);
    expect(shippingReceipt(shipping, id, 4)).toBe(shipping);
    const canonical = { ...product, id: 'abcdef12-1111-4111-8111-111111111111' };
    expect(productReceipt(canonical, canonical.id.toUpperCase(), 7)).toBe(canonical);
  });

  test('rejects malformed product collection members before an editor can install them', () => {
    for (const malformed of [
      { variants: [{}] },
      { images: [null] },
      { options: [{ id, name: 'Size', position: 0, values: [{}] }] },
      { categories: [{ id, name: 'Missing slug' }] },
    ])
      expect(() => productReceipt({ ...product, ...malformed }, id, 7)).toThrow('Invalid product');
    expect(() =>
      productReceipt(
        {
          ...product,
          variants: [
            {
              id,
              sku: null,
              price: Number.NaN,
              is_active: true,
              track_inventory: true,
              option_value_ids: [],
            },
          ],
        },
        id,
        7,
      ),
    ).toThrow('Invalid product');
  });

  test('requires nullable preserved fields while accepting explicit null and zero', () => {
    expect(shippingReceipt({ ...shipping, free_above: 0 }, id, 4).free_above).toBe(0);
    // Legacy reads accept stored negative thresholds; write validation remains stricter.
    expect(shippingReceipt({ ...shipping, free_above: -1 }, id, 4).free_above).toBe(-1);
    const { free_above: _, ...missingThreshold } = shipping;
    expect(() => shippingReceipt(missingThreshold, id, 4)).toThrow('Invalid shipping');
    const promotion = {
      id,
      revision: 2,
      name: 'Rule',
      code: null,
      type: 'free_shipping',
      params: {},
      priority: 0,
      stackable: false,
      apply_scope: 'all',
      get_scope: 'same_as_apply',
      usage_limit: null,
      used_count: 0,
      per_customer_limit: 1,
      starts_at: null,
      ends_at: null,
      is_active: false,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    };
    expect(promotionReceipt(promotion, id, 2)).toBe(promotion);
    for (const key of ['code', 'usage_limit', 'starts_at', 'ends_at'] as const) {
      const incomplete = { ...promotion } as Record<string, unknown>;
      delete incomplete[key];
      expect(() => promotionReceipt(incomplete, id, 2)).toThrow('Invalid promotion');
    }
    expect(() => promotionReceipt({ ...promotion, type: 'surprise' }, id, 2)).toThrow('Invalid promotion');
  });

  test('timestamp fences accept no-op equality and reject an older receipt', () => {
    const category = {
      id,
      name: 'Root',
      slug: 'root',
      description: '',
      parent_id: null,
      image_url: null,
      position: 0,
      is_active: true,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
    };
    expect(categoryReceipt(category, id, category.updated_at)).toBe(category);
    expect(() =>
      categoryReceipt({ ...category, updated_at: '2026-01-01T00:00:00Z' }, id, category.updated_at),
    ).toThrow('revision');
  });

  test('timestamp fences compare microseconds and normalize explicit timezones', () => {
    const customer = {
      id,
      email: null,
      full_name: 'Ada',
      phone: null,
      has_account: false,
      anonymized_at: null,
      created_at: '2026-01-01T00:00:00Z',
      addresses: [],
      updated_at: '2026-01-02T08:00:00.123456+08:00',
    };
    expect(customerReceipt(customer, id, '2026-01-02T00:00:00.123456Z')).toBe(customer);
    expect(() =>
      customerReceipt(
        { ...customer, updated_at: '2026-01-02T00:00:00.123455+00:00' },
        id,
        '2026-01-02T00:00:00.123456Z',
      ),
    ).toThrow('revision');
  });
});
