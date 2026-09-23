import { expect, test } from 'bun:test';
import { missingVariants, validateVariants, type ProductVariant } from '../../admin/src/lib/catalog';
import { productChanges, shippingMoney, taxFraction } from '../../mcp/src/schemas';

const id = '00000000-0000-4000-8000-000000000001';
const variant = (price: number): ProductVariant => ({
  id,
  sku: null,
  price,
  is_active: true,
  track_inventory: false,
  option_value_ids: [],
});

test('MCP write money schemas enforce database decimal scales without changing output money', () => {
  for (const field of ['price', 'compare_at_price', 'cost'] as const) {
    expect(productChanges.safeParse({ variants: [{ id, [field]: 1.005 }] }).success).toBe(false);
    expect(productChanges.safeParse({ variants: [{ id, [field]: 9999999999.99 }] }).success).toBe(true);
  }
  expect(productChanges.safeParse({ variants: [{ id, compare_at_price: null, cost: null }] }).success).toBe(
    true,
  );
  expect(productChanges.safeParse({ variants: [{ id, price: 0.29 }] }).success).toBe(true);
  expect(shippingMoney.safeParse(1.005).success).toBe(false);
  expect(shippingMoney.safeParse(9999999999.99).success).toBe(true);
  expect(taxFraction.safeParse(0.12345).success).toBe(false);
  expect(taxFraction.safeParse(0.1234).success).toBe(true);
});

test('admin catalog rejects fractional cents before generating or validating variants', () => {
  expect(() => missingVariants([], [], 1.005)).toThrow('price');
  expect(() => missingVariants([], [], 0.01)).not.toThrow();
  expect(() => missingVariants([], [], 9999999999.99)).not.toThrow();
  expect(() => validateVariants([], [variant(1.005)], false)).toThrow('price');
  expect(() => validateVariants([], [variant(0.01)], false)).not.toThrow();
});
