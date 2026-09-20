import { afterAll, beforeAll, expect, test } from 'bun:test';
import { api, rpc, signup, makeAdmin, checked, TEST_ADDRESS, type TestUser } from './helpers';
import { normalizeCheckoutAmount } from '../supabase/functions/_shared/paypal';

interface Line { variant_id: string; quantity: number; unit_price: number; discount_total: number; line_total: number }
interface Price {
  lines: Line[]; subtotal: number; discount_total: number; shipping_total: number; tax_total: number; total: number;
  promotions: Array<{ promotion_id: string; amount: number }>;
}
interface Promotion { id: string; code: string | null }
let admin: TestUser;
let buyer: TestUser;
let productId: string;
const variants = Array.from({ length: 8 }, () => crypto.randomUUID()).sort();
const minor = (value: number) => value === 0 ? 0n : BigInt(normalizeCheckoutAmount(value, 'USD').replace('.', ''));
const decimal = (value: bigint | number) => {
  const cents = BigInt(value);
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
};
beforeAll(async () => {
  admin = await signup(); buyer = await signup(); await makeAdmin(admin.userId);
  const [product] = await checked<Array<{ id: string }>>(api('/rest/v1/products', {
    service: true, method: 'POST', body: { slug: `allocation-${crypto.randomUUID()}`, name: 'allocation', status: 'draft' },
  }));
  productId = product.id;
  await checked(api('/rest/v1/product_variants', {
    service: true, method: 'POST', body: variants.map(id => ({ id, product_id: productId, sku: `ALLOC-${id}`, price: '0.01', track_inventory: false })),
  }));
  const [option] = await checked<Array<{ id: string }>>(api('/rest/v1/product_options', {
    service: true, method: 'POST', body: { product_id: productId, name: 'Allocation case' },
  }));
  const values = await checked<Array<{ id: string; value: string }>>(api('/rest/v1/product_option_values', {
    service: true, method: 'POST', body: variants.map(id => ({ option_id: option.id, value: id })),
  }));
  await checked(api('/rest/v1/variant_option_values', {
    service: true, method: 'POST', body: values.map(value => ({ variant_id: value.value, option_value_id: value.id })),
  }));
  await checked(api(`/rest/v1/products?id=eq.${productId}`, {
    service: true, method: 'PATCH', body: { status: 'active' },
  }));
});
afterAll(async () => {
  if (productId) await api(`/rest/v1/products?id=eq.${productId}`, {
    service: true, method: 'PATCH', body: { status: 'archived' },
  });
});
async function prices(cents: number[]): Promise<void> {
  const product = await checked<{ revision: number }>(rpc('get_admin_product', { product_id: productId }, admin.token));
  await checked(rpc('update_product', {
    product_id: productId, expected_revision: product.revision,
    changes: { variants: cents.map((value, index) => ({ id: variants[index], price: decimal(value) })) },
  }, admin.token));
}
function cart(quantities: number[]) {
  return quantities.map((quantity, index) => ({ variant_id: variants[index], quantity }));
}
async function withPromotions<T>(specs: Record<string, unknown>[], run: (promos: Promotion[]) => Promise<T>): Promise<T> {
  const promos = await checked<Promotion[]>(api('/rest/v1/promotions?select=id,code', {
    service: true, method: 'POST', body: specs.map(spec => ({
      name: `allocation-${crypto.randomUUID()}`, code: null, priority: 100, stackable: true, usage_limit: null, ...spec,
    })),
  }));
  try { return await run(promos); }
  finally {
    await checked(api(`/rest/v1/promotions?id=in.(${promos.map(promo => promo.id).join(',')})`, {
      service: true, method: 'PATCH', body: { is_active: false },
    }));
  }
}
const quotePrice = (quantities: number[], discountCode: string | null, shippingId?: string): Promise<Price> => checked(rpc('price_checkout', {
  items: cart(quantities), address: TEST_ADDRESS, discount_code: discountCode, shipping_method_id: shippingId,
}));
function allocate(capacities: bigint[], target: bigint): bigint[] {
  const base = capacities.reduce((a, b) => a + b, 0n);
  if (base === 0n) return capacities.map(() => 0n);
  const allocations = capacities.map(capacity => target * capacity / base);
  const remainders = capacities.map((capacity, index) => ({ index, remainder: target * capacity % base }));
  remainders.sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1);
  const extra = Number(target - allocations.reduce((a, b) => a + b, 0n));
  for (const row of remainders.slice(0, extra)) allocations[row.index] += 1n;
  return allocations;
}
function expectAllocation(price: Price, capacities: bigint[], target: bigint): void {
  expect(price.lines.map(line => minor(line.discount_total))).toEqual(allocate(capacities, target));
  expect(minor(price.discount_total)).toBe(target);
  expect(price.lines.reduce((sum, line) => sum + minor(line.discount_total), 0n)).toBe(target);
  expect(price.promotions.reduce((sum, promo) => sum + minor(promo.amount), 0n)).toBe(target);
  for (const [index, line] of price.lines.entries()) {
    expect(minor(line.discount_total) <= capacities[index]).toBe(true);
    expect(minor(line.line_total)).toBe(capacities[index] - minor(line.discount_total));
  }
  expect(minor(price.total)).toBe(minor(price.subtotal) - target + minor(price.shipping_total) + minor(price.tax_total));
}

for (const [cents, target] of [
  [[1, 1, 1, 1], 2], // old per-line rounding over-allocated 3 cents
  [[2, 2, 2, 1], 5], // last-line clipping used to under-allocate 4 cents
  [[100_000_000_000, 99_999_999_999], 199_999_999_998], // > bigint product, near-equal rational remainders
] as const) {
  test(`最大余数分摊严格守恒：${cents.join('/')} 分分配 ${target} 分优惠`, async () => {
    await prices([...cents]);
    await withPromotions([{
      type: 'order_fixed', params: { amount: decimal(target) }, code: `CENT-${crypto.randomUUID()}`,
    }], async ([promo]) => {
      expectAllocation(await quotePrice(cents.map(() => 1), promo.code), cents.map(BigInt), BigInt(target));
    });
  });
}

test('确定性属性样本：不同数量、权重、零价行与满额钳制都保持目标优惠和行上限', async () => {
  const cents = [0, 1, 2, 3, 7, 13, 101, 137];
  await prices(cents);
  let seed = 0x31415926;
  const random = (limit: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % limit; };
  await withPromotions([{
    type: 'order_fixed', params: { amount: '0.01' }, code: `PROPERTY-${crypto.randomUUID()}`,
  }], async ([promo]) => {
    for (let index = 0; index < 50; index += 1) {
      const count = 1 + random(cents.length);
      const quantities = Array.from({ length: count }, () => 1 + random(5));
      const caps = quantities.map((quantity, item) => BigInt(quantity * cents[item]));
      const base = caps.reduce((sum, value) => sum + value, 0n);
      const configured = index % 10 === 0 ? base + 10n : BigInt(1 + random(Number(base + 20n)));
      await checked(api(`/rest/v1/promotions?id=eq.${promo.id}`, {
        service: true, method: 'PATCH', body: { params: { amount: decimal(configured) } },
      }));
      expectAllocation(await quotePrice(quantities, promo.code), caps, configured < base ? configured : base);
    }
  });
});

test('整单百分比也先确定分币目标，再按最大余数分摊', async () => {
  const cents = [1, 2, 3, 7, 13, 101];
  await prices(cents);
  await withPromotions([{
    type: 'order_percentage', params: { percent: 1 }, code: `PERCENT-${crypto.randomUUID()}`,
  }], async ([promo]) => {
    for (const basisPoints of [1, 100, 1250, 3333, 7500, 10000]) {
      await checked(api(`/rest/v1/promotions?id=eq.${promo.id}`, {
        service: true, method: 'PATCH', body: { params: { percent: basisPoints / 100 } },
      }));
      const caps = cents.map(BigInt);
      const base = caps.reduce((sum, value) => sum + value, 0n);
      expectAllocation(await quotePrice(cents.map(() => 1), promo.code), caps, (base * BigInt(basisPoints) + 5000n) / 10000n);
    }
  });
});

test('购物车顺序、拆行和 UUID 大小写不改变折扣分摊', async () => {
  await prices([1, 2, 3]);
  await withPromotions([{
    type: 'order_fixed', params: { amount: '0.03' }, code: `CANONICAL-${crypto.randomUUID()}`,
  }], async ([promo]) => {
    const canonical = await quotePrice([2, 2, 2], promo.code);
    const split = await checked<Price>(rpc('price_checkout', {
      items: variants.slice(0, 3).reverse().flatMap(id => [
        { variant_id: id.toUpperCase(), quantity: 1 }, { variant_id: id, quantity: 1 },
      ]), address: TEST_ADDRESS, discount_code: promo.code,
    }));
    expect(split).toEqual(canonical);
  });
});

test('已被行优惠用尽的行不再承接整单折扣', async () => {
  await prices([1, 1, 1, 1]);
  await withPromotions([
    { type: 'item_percentage', params: { percent: 100 }, priority: -20, stackable: true },
    { type: 'order_fixed', params: { amount: '0.02' }, priority: -10, stackable: true, code: `ROOM-${crypto.randomUUID()}` },
  ], async ([item, fixed]) => {
    await checked(api('/rest/v1/promotion_targets', {
      service: true, method: 'POST', body: { promotion_id: item.id, role: 'apply', variant_id: variants[0] },
    }));
    const price = await quotePrice([1, 1, 1, 1], fixed.code);
    expect(price.lines.map(line => minor(line.discount_total))).toEqual([1n, 1n, 1n, 0n]);
    expect(price.promotions.find(promo => promo.promotion_id === fixed.id)?.amount).toBe(0.02);
    expect(price.discount_total).toBe(0.03);
  });
});

test('Quote、转单、成功账本与退款沿用同一分币结果', async () => {
  await prices([1, 1, 1, 1]);
  await withPromotions([{
    type: 'order_fixed', params: { amount: '0.02' }, code: `LEDGER-${crypto.randomUUID()}`,
  }], async ([promo]) => {
    const input = { items: cart([1, 1, 1, 1]), address: TEST_ADDRESS, discount_code: promo.code };
    const quote = await checked<{ id: string }>(rpc('create_checkout_quote', {
      ...input, idempotency_key: crypto.randomUUID(),
    }, buyer.token));
    const order = await checked<{ id: string; total: number; discount_total: number }>(rpc('create_order_from_quote', {
      quote_id: quote.id,
    }, buyer.token));
    expect(order).toMatchObject({ total: 0.02, discount_total: 0.02 });
    await checked(rpc('mark_order_paid', { idempotency_key: crypto.randomUUID(), order_id: order.id }, admin.token));
    const lines = await checked<Array<{ id: string; discount_total: number; line_total: number }>>(api(
      `/rest/v1/order_items?order_id=eq.${order.id}&select=id,discount_total,line_total`, { token: buyer.token },
    ));
    expect(lines.reduce((sum, line) => sum + minor(line.discount_total), 0n)).toBe(2n);
    const line = lines.find(row => row.line_total > 0)!;
    await checked(rpc('refund_order', { idempotency_key: crypto.randomUUID(), order_id: order.id, items: [{ order_item_id: line.id, quantity: 1 }] }, admin.token));
    const ledger = await checked<{ balances: { captured: number; refunded: number; is_balanced: boolean } }>(rpc('get_order_ledger', {
      order_id: order.id,
    }, buyer.token));
    expect(ledger.balances).toMatchObject({ captured: 0.02, refunded: 0.01, is_balanced: true });
  });
});

async function withShipping<T>(freeAbove: number, run: (shippingId: string) => Promise<T>): Promise<T> {
  const [shipping] = await checked<Array<{ id: string }>>(api('/rest/v1/shipping_methods', {
    service: true, method: 'POST', body: { name: 'threshold shipping', price: 10, free_above: freeAbove, countries: ['US'] },
  }));
  try { return await run(shipping.id); }
  finally { await checked(api(`/rest/v1/shipping_methods?id=eq.${shipping.id}`, {
    service: true, method: 'PATCH', body: { is_active: false },
  })); }
}

test('已经满额包邮时，零收益独占免邮不阻断后续减 5 元，也不占用量', async () => {
  await prices([10000]);
  await withShipping(90, shipping => withPromotions([
    { type: 'free_shipping', params: {}, stackable: false, priority: -20, usage_limit: 1 },
    { type: 'order_fixed', params: { amount: 5 }, stackable: false, priority: -10 },
  ], async ([free, fixed]) => {
    const price = await quotePrice([1], null, shipping);
    expect(price).toMatchObject({ discount_total: 5, shipping_total: 0 });
    expect(price.promotions).toEqual([expect.objectContaining({ promotion_id: fixed.id, amount: 5 })]);
    await checked(rpc('create_order', {
      idempotency_key: crypto.randomUUID(), items: cart([1]), address: TEST_ADDRESS, shipping_method_id: shipping,
    }, buyer.token));
    const [row] = await checked<Array<{ used_count: number }>>(api(`/rest/v1/promotions?id=eq.${free.id}&select=used_count`, { service: true }));
    expect(row.used_count).toBe(0);
  }));
});

for (const stackable of [true, false]) {
  test(`后续折扣跌破包邮线时，延后免邮${stackable ? '可与商品优惠叠加' : '不能穿透独占商品优惠'}`, async () => {
    await prices([10000]);
    await withShipping(100, shipping => withPromotions([
      { type: 'free_shipping', params: {}, stackable: true, priority: -20 },
      { type: 'order_fixed', params: { amount: 5 }, stackable, priority: -10 },
    ], async ([free, fixed]) => {
      const price = await quotePrice([1], null, shipping);
      expect(price).toMatchObject({ discount_total: 5, shipping_total: stackable ? 0 : 10 });
      expect(price.promotions.find(promo => promo.promotion_id === fixed.id)?.amount).toBe(5);
      expect(price.promotions.find(promo => promo.promotion_id === free.id)?.amount).toBe(stackable ? 10 : undefined);
    }));
  });
}

test('多个免邮候选仍只记一次收益，保留最早可叠加候选的优先级', async () => {
  await prices([10000]);
  await withShipping(100, shipping => withPromotions([
    { type: 'free_shipping', params: {}, stackable: true, priority: -30 },
    { type: 'order_fixed', params: { amount: 5 }, stackable: true, priority: -20 },
    { type: 'free_shipping', params: {}, stackable: true, priority: -10 },
  ], async ([first, fixed, last]) => {
    const price = await quotePrice([1], null, shipping);
    expect(price.promotions).toHaveLength(2);
    expect(price.promotions.find(promo => promo.promotion_id === first.id)?.amount).toBe(10);
    expect(price.promotions.some(promo => promo.promotion_id === last.id)).toBe(false);
    expect(price.promotions.find(promo => promo.promotion_id === fixed.id)?.amount).toBe(5);
    expect(price.shipping_total).toBe(0);
  }));
});
