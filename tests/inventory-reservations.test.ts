import { afterAll, beforeAll, afterEach, describe, expect, test } from 'bun:test';
import { stockedProduct, archiveProduct, type CatalogFixture } from './support/catalog';
import { Cleanup } from './support/cleanup';
import {
  api, rpc, signup, makeAdmin, stockOf, checked, TEST_ADDRESS,
  type TestUser,
} from './helpers';

type StockFixture = CatalogFixture;

interface QuoteResult {
  id: string;
  status: string;
  is_reserved: boolean;
  order_id: string | null;
  total: number;
  expires_at: string;
  shipping_address: Record<string, unknown>;
  lines: Array<{ variant_id: string; quantity: number }>;
}

interface Availability {
  on_hand: number;
  reserved: number;
  available: number;
}

let admin: TestUser;
let buyerA: TestUser;
let buyerB: TestUser;
let reserveStock: StockFixture;
let contentionStock: StockFixture;
let paymentStock: StockFixture;
let cancelStock: StockFixture;
let expiryStock: StockFixture;
let pricingStock: StockFixture;
let promoStock: StockFixture;
const cleanup = new Cleanup();
const createStockFixture = (label: string) => stockedProduct(admin, { label, onHand: 5, cleanup });

async function availability(variantId: string): Promise<Availability> {
  const { status, data } = await rpc('get_inventory_availability', {
    variant_id: variantId,
  }, admin.token);
  if (status >= 400) throw new Error(JSON.stringify(data));
  return data as Availability;
}

const createQuote = (
  fixture: StockFixture,
  user: TestUser,
  quantity: number,
  idempotencyKey = `quote-${crypto.randomUUID()}`,
  extra: Record<string, unknown> = {},
) => rpc('create_checkout_quote', {
  items: [{ variant_id: fixture.variantId, quantity }],
  address: TEST_ADDRESS,
  idempotency_key: idempotencyKey,
  ...extra,
}, user.token);

afterAll(() => cleanup.run());

beforeAll(async () => {
  admin = await signup();
  buyerA = await signup();
  buyerB = await signup();
  await makeAdmin(admin.userId);
  [reserveStock, contentionStock, paymentStock, cancelStock, expiryStock, pricingStock, promoStock] =
    await Promise.all([
      createStockFixture('reserve'),
      createStockFixture('contention'),
      createStockFixture('payment'),
      createStockFixture('cancel'),
      createStockFixture('expiry'),
      createStockFixture('pricing'),
      createStockFixture('promotion'),
    ]);
});

describe('Checkout Quote 与库存预占', () => {
  test('并发幂等报价只预占一次，不提前扣 on_hand，并影响 Storefront in_stock', async () => {
    const hidden = await api('/rest/v1/checkout_quotes?select=*', { service: true });
    expect(hidden.status).toBe(404);
    const deniedWorker = await rpc('expire_checkout_quotes', { max_quotes: 1 }, buyerA.token);
    expect(deniedWorker.status).toBe(403);

    const key = `quote-idempotent-${crypto.randomUUID()}`;
    const [first, replay] = await Promise.all([
      createQuote(reserveStock, buyerA, 5, key),
      createQuote(reserveStock, buyerA, 5, key),
    ]);
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    const quote = first.data as QuoteResult;
    expect((replay.data as QuoteResult).id).toBe(quote.id);
    expect(quote.lines).toEqual([
      expect.objectContaining({ variant_id: reserveStock.variantId, quantity: 5 }),
    ]);

    expect(await stockOf(reserveStock.sku)).toBe(5);
    expect(await availability(reserveStock.variantId)).toMatchObject({
      on_hand: 5, reserved: 5, available: 0,
    });
    const listing = await api(`/rest/v1/product_listing?slug=eq.${reserveStock.slug}&select=in_stock`);
    expect((listing.data as { in_stock: boolean }[])[0].in_stock).toBe(false);

    const stranger = await rpc('get_checkout_quote', { quote_id: quote.id }, buyerB.token);
    expect(stranger.status).toBe(400);
    expect((stranger.data as { message: string }).message).toBe('checkout quote not found');

    const unsafeAdjustment = await rpc('adjust_inventory', {
      variant_id: reserveStock.variantId, delta: -1, reason: 'adjust',
    }, admin.token);
    expect(unsafeAdjustment.status).toBe(400);
    expect((unsafeAdjustment.data as { message: string }).message).toContain('reserved stock');

    const cancelled = await rpc('cancel_checkout_quote', {
      quote_id: quote.id, reason: '用户离开结账页',
    }, buyerA.token);
    expect((cancelled.data as QuoteResult).status).toBe('cancelled');
    expect((cancelled.data as QuoteResult).shipping_address).toEqual({});
    expect(await availability(reserveStock.variantId)).toMatchObject({
      on_hand: 5, reserved: 0, available: 5,
    });
    const relisted = await api(`/rest/v1/product_listing?slug=eq.${reserveStock.slug}&select=in_stock`);
    expect((relisted.data as { in_stock: boolean }[])[0].in_stock).toBe(true);

    const mismatch = await createQuote(reserveStock, buyerA, 4, key);
    expect(mismatch.status).toBe(400);
    expect((mismatch.data as { message: string }).message).toContain('different quote parameters');
  });

  test('并发预占不会超卖，旧 create_order 也不能穿透 reservation', async () => {
    const [a, b] = await Promise.all([
      createQuote(contentionStock, buyerA, 4),
      createQuote(contentionStock, buyerB, 4),
    ]);
    const successes = [a, b].filter((result) => result.status === 200);
    const failures = [a, b].filter((result) => result.status >= 400);
    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);
    expect((failures[0].data as { message: string }).message).toContain('insufficient available stock');

    const winnerQuote = successes[0].data as QuoteResult;
    const winner = a.status === 200 ? buyerA : buyerB;
    const other = a.status === 200 ? buyerB : buyerA;
    expect(await availability(contentionStock.variantId)).toMatchObject({
      on_hand: 5, reserved: 4, available: 1,
    });

    const blockedLegacy = await rpc('create_order', { idempotency_key: crypto.randomUUID(),
      items: [{ variant_id: contentionStock.variantId, quantity: 2 }],
      address: TEST_ADDRESS,
    }, other.token);
    expect(blockedLegacy.status).toBe(400);
    expect((blockedLegacy.data as { message: string }).message).toContain('insufficient available stock');

    const oneAvailable = await rpc('create_order', { idempotency_key: crypto.randomUUID(),
      items: [{ variant_id: contentionStock.variantId, quantity: 1 }],
      address: TEST_ADDRESS,
    }, other.token);
    expect(oneAvailable.status).toBe(200);
    expect(await availability(contentionStock.variantId)).toMatchObject({
      on_hand: 5, reserved: 5, available: 0,
    });
    await rpc('cancel_order', { order_id: (oneAvailable.data as { id: string }).id }, other.token);
    await rpc('cancel_checkout_quote', { quote_id: winnerQuote.id }, winner.token);
    expect(await availability(contentionStock.variantId)).toMatchObject({
      on_hand: 5, reserved: 0, available: 5,
    });
  });
});

describe('Quote 转单与支付确认', () => {
  test('转单不扣库存；支付捕获原子消费预占且重放不重复扣减', async () => {
    const quoted = await createQuote(paymentStock, buyerA, 2);
    expect(quoted.status).toBe(200);
    const quote = quoted.data as QuoteResult;

    const converted = await rpc('create_order_from_quote', { quote_id: quote.id }, buyerA.token);
    const replayedConversion = await rpc('create_order_from_quote', { quote_id: quote.id }, buyerA.token);
    expect(converted.status).toBe(200);
    const order = converted.data as { id: string; total: number; financial_status: string };
    expect((replayedConversion.data as { id: string }).id).toBe(order.id);
    expect(await availability(paymentStock.variantId)).toMatchObject({
      on_hand: 5, reserved: 2, available: 3,
    });

    const addressChange = await rpc('update_order_address', {
      order_id: order.id, address: { ...TEST_ADDRESS, line1: '不可改价的新地址' },
    }, buyerA.token);
    expect(addressChange.status).toBe(400);
    expect((addressChange.data as { message: string }).message).toContain('quoted order snapshot is immutable');

    const { data: orderItems } = await api(
      `/rest/v1/order_items?order_id=eq.${order.id}&select=id`, { token: buyerA.token },
    );
    const prematureFulfillment = await rpc('create_fulfillment', { idempotency_key: crypto.randomUUID(),
      order_id: order.id,
      items: [{ order_item_id: (orderItems as { id: string }[])[0].id, quantity: 1 }],
    }, admin.token);
    expect(prematureFulfillment.status).toBe(400);
    expect((prematureFulfillment.data as { message: string }).message).toContain('must be paid');

    const intent = await rpc('create_payment_intent', {
      order_id: order.id,
      provider: 'paypal',
      idempotency_key: `intent-${crypto.randomUUID()}`,
    }, undefined, true);
    expect(intent.status).toBe(200);
    expect((intent.data as { expires_at: string }).expires_at).toBe(quote.expires_at);

    const captureKey = `event-${crypto.randomUUID()}`;
    const captureBody = {
      payment_intent_id: (intent.data as { id: string }).id,
      provider_reference: `provider-${crypto.randomUUID()}`,
      idempotency_key: captureKey,
    };
    const captured = await rpc('capture_payment_intent', captureBody, undefined, true);
    const captureReplay = await rpc('capture_payment_intent', captureBody, undefined, true);
    expect(captured.status).toBe(200);
    expect((captureReplay.data as { id: string }).id).toBe((captured.data as { id: string }).id);

    expect(await availability(paymentStock.variantId)).toMatchObject({
      on_hand: 3, reserved: 0, available: 3,
    });
    const finishedQuote = await rpc('get_checkout_quote', { quote_id: quote.id }, buyerA.token);
    expect((finishedQuote.data as QuoteResult).status).toBe('completed');
    expect((finishedQuote.data as QuoteResult).shipping_address).toEqual({});
    const linkedQuote = await rpc('get_order_checkout_quote', { order_id: order.id }, buyerA.token);
    expect((linkedQuote.data as QuoteResult).id).toBe(quote.id);

    const { data: storedOrder } = await api(
      `/rest/v1/orders?id=eq.${order.id}&select=financial_status`, { token: buyerA.token },
    );
    expect((storedOrder as { financial_status: string }[])[0].financial_status).toBe('paid');
    const { data: movements } = await api(
      `/rest/v1/inventory_movements?order_id=eq.${order.id}&reason=eq.order&select=delta`,
      { service: true },
    );
    expect(movements).toEqual([{ delta: -2 }]);
  });

  test('取消 converted quote 只释放 reservation，不虚增 on_hand', async () => {
    const quoted = await createQuote(cancelStock, buyerA, 3);
    const quote = quoted.data as QuoteResult;
    const converted = await rpc('create_order_from_quote', { quote_id: quote.id }, buyerA.token);
    const orderId = (converted.data as { id: string }).id;
    expect(await availability(cancelStock.variantId)).toMatchObject({
      on_hand: 5, reserved: 3, available: 2,
    });

    const cancelled = await rpc('cancel_order', {
      order_id: orderId, reason: '取消预占订单',
    }, buyerA.token);
    expect(cancelled.status).toBe(200);
    expect(await availability(cancelStock.variantId)).toMatchObject({
      on_hand: 5, reserved: 0, available: 5,
    });
    const cancelledQuote = await rpc('get_checkout_quote', { quote_id: quote.id }, buyerA.token);
    expect((cancelledQuote.data as QuoteResult).status).toBe('cancelled');
    const { data: movements } = await api(
      `/rest/v1/inventory_movements?order_id=eq.${orderId}&select=id`, { service: true },
    );
    expect(movements).toEqual([]);
  });

  test('转单时锁促销并落账，取消后释放 usage 与 reservation', async () => {
    const { data: beforeRows } = await api(
      '/rest/v1/promotions?code=eq.WELCOME10&select=used_count', { service: true },
    );
    const usedBefore = Number((beforeRows as { used_count: number }[])[0].used_count);
    const quoted = await createQuote(promoStock, buyerB, 5, undefined, {
      discount_code: 'welcome10',
    });
    expect(quoted.status).toBe(200);
    const quote = quoted.data as QuoteResult & {
      discount_total: number;
      promotions: Array<{ code: string; amount: number }>;
    };
    expect(Number(quote.discount_total)).toBeCloseTo(5);
    expect(quote.promotions[0].code).toBe('WELCOME10');

    const converted = await rpc('create_order_from_quote', { quote_id: quote.id }, buyerB.token);
    expect(converted.status).toBe(200);
    const order = converted.data as { id: string; discount_code: string; discount_total: number };
    expect(order.discount_code).toBe('WELCOME10');
    expect(Number(order.discount_total)).toBeCloseTo(5);
    const { data: duringRows } = await api(
      '/rest/v1/promotions?code=eq.WELCOME10&select=used_count', { service: true },
    );
    expect(Number((duringRows as { used_count: number }[])[0].used_count)).toBe(usedBefore + 1);

    await rpc('cancel_order', { order_id: order.id, reason: '促销预占取消' }, buyerB.token);
    const { data: afterRows } = await api(
      '/rest/v1/promotions?code=eq.WELCOME10&select=used_count', { service: true },
    );
    expect(Number((afterRows as { used_count: number }[])[0].used_count)).toBe(usedBefore);
    expect(await availability(promoStock.variantId)).toMatchObject({
      on_hand: 5, reserved: 0, available: 5,
    });
  });

  test('手工支付同样消费 reservation', async () => {
    const quoted = await createQuote(pricingStock, buyerA, 1);
    const quote = quoted.data as QuoteResult;
    const converted = await rpc('create_order_from_quote', { quote_id: quote.id }, buyerA.token);
    const orderId = (converted.data as { id: string }).id;
    const paid = await rpc('mark_order_paid', {
      order_id: orderId, provider: 'manual', provider_ref: `cash-${crypto.randomUUID()}`,
    }, admin.token);
    expect(paid.status).toBe(200);
    expect(await availability(pricingStock.variantId)).toMatchObject({
      on_hand: 4, reserved: 0, available: 4,
    });
    const storedQuote = await rpc('get_checkout_quote', { quote_id: quote.id }, buyerA.token);
    expect((storedQuote.data as QuoteResult).status).toBe('completed');
    const ledger = await rpc('get_order_ledger', { order_id: orderId }, buyerA.token);
    const intents = (ledger.data as { payment_intents: Array<{ status: string }> }).payment_intents;
    expect(intents).toEqual([]);
  });
});

describe('过期释放与重新报价', () => {
  test('worker 释放 open quote，并取消已转单但未支付的过期订单', async () => {
    const open = await createQuote(expiryStock, buyerB, 5, undefined, { ttl_seconds: 60 });
    const openQuote = open.data as QuoteResult;
    expect(await availability(expiryStock.variantId)).toMatchObject({ reserved: 5, available: 0 });

    const unauthorized = await rpc('expire_checkout_quotes', {
      max_quotes: 10, as_of: new Date(Date.now() + 120_000).toISOString(),
    }, buyerB.token);
    expect(unauthorized.status).toBe(403);

    const expiredOpen = await rpc('expire_checkout_quotes', {
      max_quotes: 10, as_of: new Date(Date.now() + 120_000).toISOString(),
    }, undefined, true);
    expect(expiredOpen.status).toBe(200);
    const openAfter = await rpc('get_checkout_quote', { quote_id: openQuote.id }, buyerB.token);
    expect((openAfter.data as QuoteResult).status).toBe('expired');
    expect((openAfter.data as QuoteResult).shipping_address).toEqual({});
    expect(await availability(expiryStock.variantId)).toMatchObject({ reserved: 0, available: 5 });

    const convertedRaw = await createQuote(expiryStock, buyerB, 2, undefined, { ttl_seconds: 60 });
    const convertedQuote = convertedRaw.data as QuoteResult;
    const converted = await rpc('create_order_from_quote', {
      quote_id: convertedQuote.id,
    }, buyerB.token);
    const orderId = (converted.data as { id: string }).id;
    await rpc('expire_checkout_quotes', {
      max_quotes: 10, as_of: new Date(Date.now() + 120_000).toISOString(),
    }, undefined, true);

    const { data: orders } = await api(
      `/rest/v1/orders?id=eq.${orderId}&select=status,financial_status`, { token: buyerB.token },
    );
    expect((orders as { status: string; financial_status: string }[])[0]).toMatchObject({
      status: 'cancelled', financial_status: 'pending',
    });
    const convertedAfter = await rpc('get_checkout_quote', {
      quote_id: convertedQuote.id,
    }, buyerB.token);
    expect((convertedAfter.data as QuoteResult).status).toBe('expired');
    expect(await availability(expiryStock.variantId)).toMatchObject({
      on_hand: 5, reserved: 0, available: 5,
    });
  });

  test('商品价格变化会拒绝旧 quote 转单，要求重新报价', async () => {
    const fixture = await createStockFixture('repricing');
    const quoted = await createQuote(fixture, buyerA, 1);
    const quote = quoted.data as QuoteResult;
    await api(`/rest/v1/product_variants?id=eq.${fixture.variantId}`, {
      service: true, method: 'PATCH', body: { price: 11 },
    });

    const conversion = await rpc('create_order_from_quote', { quote_id: quote.id }, buyerA.token);
    expect(conversion.status).toBe(400);
    expect((conversion.data as { message: string }).message).toContain('pricing changed');
    expect(await availability(fixture.variantId)).toMatchObject({
      on_hand: 5, reserved: 1, available: 4,
    });
    await rpc('cancel_checkout_quote', { quote_id: quote.id }, buyerA.token);
    expect(await availability(fixture.variantId)).toMatchObject({
      on_hand: 5, reserved: 0, available: 5,
    });
  });
});

// Retained from the original review; grouped by business domain.
describe('修复：库存口径与回补仓', () => {
  const resources = new Cleanup();
  let mugId: string;
  beforeAll(async () => { mugId = (await stockedProduct(admin, { label: 'locations', cleanup })).variantId; });
  afterEach(() => resources.run());
  test('in_stock 只看默认仓：非默认仓有货不算有货', async () => {
    // 探针商品：无任何库存行
    const slug = `stock-probe-${crypto.randomUUID()}`;
    const { data: prod } = await api('/rest/v1/products?select=id', {
      service: true, method: 'POST',
      body: { slug, name: '库存探针', status: 'draft' },
    });
    const productId = (prod as { id: string }[])[0].id;
    resources.defer(() => archiveProduct(productId));
    const { data: variant } = await api('/rest/v1/product_variants?select=id', {
      service: true, method: 'POST',
      body: { product_id: productId, sku: `PROBE-${productId}`, price: 1 },
    });
    const probeVariant = (variant as { id: string }[])[0].id;
    const published = await api(`/rest/v1/products?id=eq.${productId}`, {
      service: true, method: 'PATCH', body: { status: 'active' },
    });
    expect(published.status).toBe(200);

    const listing = async () => {
      const { data } = await api(`/rest/v1/product_listing?slug=eq.${slug}&select=in_stock`);
      return (data as { in_stock: boolean }[])[0].in_stock;
    };
    expect(await listing()).toBe(false);

    // 非默认仓有货 → 仍 false（口径与下单扣减一致）
    const { data: loc } = await api('/rest/v1/locations?select=id', {
      service: true, method: 'POST', body: { code: `WH-PROBE-${crypto.randomUUID()}`, name: '探针仓' },
    });
    const locId = (loc as { id: string }[])[0].id;
    resources.defer(() => checked(api(`/rest/v1/locations?id=eq.${locId}`, { service: true, method: 'PATCH', body: { is_active: false } })));
    await api('/rest/v1/inventory_levels', {
      service: true, method: 'POST', body: { variant_id: probeVariant, location_id: locId, on_hand: 10 },
    });
    expect(await listing()).toBe(false);

    // 默认仓有货 → true
    const { data: defLoc } = await api('/rest/v1/locations?is_default=eq.true&select=id', { service: true });
    await api('/rest/v1/inventory_levels', {
      service: true, method: 'POST',
      body: { variant_id: probeVariant, location_id: (defLoc as { id: string }[])[0].id, on_hand: 1 },
    });
    expect(await listing()).toBe(true);

    // Resources are retired in afterEach, even when an assertion fails.
  });

  test('未支付订单在原始仓预占；切换默认仓后取消只释放预占', async () => {
    const u = await signup();
    const { data: locs } = await api('/rest/v1/locations?select=id,code,is_default', { service: true });
    const whSh = (locs as { id: string; is_default: boolean }[]).find((l) => l.is_default)!;

    // 建仓 B 并放马克杯库存 10
    const { data: locB } = await api('/rest/v1/locations?select=id', {
      service: true, method: 'POST', body: { code: `WH-B-${crypto.randomUUID()}`, name: '仓B' },
    });
    const locBId = (locB as { id: string }[])[0].id;
    resources.defer(() => checked(api(`/rest/v1/locations?id=eq.${locBId}`, { service: true, method: 'PATCH', body: { is_active: false } })));
    await api('/rest/v1/inventory_levels', {
      service: true, method: 'POST', body: { variant_id: mugId, location_id: locBId, on_hand: 10 },
    });

    const levelAt = async (locId: string) => {
      const { data } = await api(
        `/rest/v1/inventory_levels?variant_id=eq.${mugId}&location_id=eq.${locId}&select=on_hand`,
        { service: true });
      return Number((data as { on_hand: number }[])[0].on_hand);
    };
    const setDefault = async (locId: string, on: boolean) => {
      await checked(api(`/rest/v1/locations?id=eq.${locId}`, {
        service: true, method: 'PATCH', body: { is_default: on },
      }));
    };

    try {
      // 切换默认仓到 B 后下单：在 B 预占但不提前扣减
      await setDefault(whSh.id, false);
      await setDefault(locBId, true);
      const { data: o } = await rpc('create_order', {
        idempotency_key: crypto.randomUUID(), items: [{ variant_id: mugId, quantity: 2 }], address: TEST_ADDRESS,
      }, u.token);
      expect(await levelAt(locBId)).toBe(10);
      expect(await availability(mugId)).toMatchObject({ on_hand: 10, reserved: 2, available: 8 });

      // 默认仓切回 WH-SH 后取消：不产生回补流水。
      await setDefault(locBId, false);
      await setDefault(whSh.id, true);
      await rpc('cancel_order', { order_id: (o as { id: string }).id }, u.token);
      expect(await levelAt(locBId)).toBe(10);

      const { data: moves } = await api(
        `/rest/v1/inventory_movements?order_id=eq.${(o as { id: string }).id}&select=location_id`,
        { service: true });
      expect(moves).toEqual([]);
    } finally {
      // 无论成败都恢复默认仓，保护后续测试文件
      await setDefault(locBId, false);
      await setDefault(whSh.id, true);
    }

    // The immutable movements reference B: retire it, do not attempt DELETE.
  });

  test('同一时刻只能有一个默认仓', async () => {
    const { data } = await api('/rest/v1/locations', {
      service: true, method: 'POST', body: { code: `WH-DUP-${crypto.randomUUID()}`, name: '重复默认仓', is_default: true },
    });
    expect((data as { code: string }).code).toBe('23505');  // unique_violation
  });
});
