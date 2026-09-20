import { describe, test, expect, beforeAll, beforeEach, afterAll, afterEach } from 'bun:test';
import { api, rpc, signup, makeAdmin, shippingByName, stockOf, TEST_ADDRESS, installTestTax, checked, type TestUser } from './helpers';
import { Cleanup } from './support/cleanup';
import { stockedProduct } from './support/catalog';
import { disablePromotion as disablePromo } from './support/promotions';
import { withRollback } from '../scripts/lib/transactions';
import { testDatabase } from './database-concurrency';

// Amount/tax regressions from the original review; each case owns its state.
const resources = new Cleanup(), fixtures = new Cleanup();
const database = testDatabase();
let admin: TestUser, mugId: string;
beforeAll(async () => {
  fixtures.defer(await installTestTax());
  admin = await signup(); await makeAdmin(admin.userId);
  mugId = (await stockedProduct(admin, { price: 9.9, cleanup: fixtures })).variantId;
});
afterEach(() => resources.run());
afterAll(async () => { try { await fixtures.run(); } finally { await database.close(); } });

// Retained from the original review; grouped by business domain.
describe('修复：改地址重算税与运法校验', () => {
  test('有测试税率的 US → CA 必须取消重下，原税额与地址快照不变', async () => {
    const u = await signup();
    const { data: o } = await rpc('create_order', { idempotency_key: crypto.randomUUID(),
      items: [{ variant_id: mugId, quantity: 1 }], address: TEST_ADDRESS,
    }, u.token);
    const order = o as { id: string; tax_total: number; total: number };
    let cleanupOrderId = order.id;
    resources.defer(() => checked(rpc('cancel_order', { order_id: cleanupOrderId }, u.token)));
    expect(Number(order.tax_total)).toBeCloseTo(1.29);   // 9.9 × 13%

    const edit = await rpc('update_order_address', {
      order_id: order.id,
      address: { recipient_name: 'John', phone: '1', country: 'CA', line1: '1 Infinite Loop, CA' },
    }, u.token);
    expect(edit.status).toBe(400);
    expect(edit.data).toMatchObject({ message: expect.stringContaining('immutable') });
    const [unchanged] = await checked<Array<{ shipping_address: { country: string }; tax_total: number; total: number }>>(api(
      `/rest/v1/orders?id=eq.${order.id}&select=shipping_address,tax_total,total`, { token: u.token },
    ));
    expect(unchanged.shipping_address.country).toBe('US');
    expect(Number(unchanged.tax_total)).toBeCloseTo(1.29);
    await checked(rpc('cancel_order', { order_id: order.id }, u.token));
    const replacement = await checked<{ id: string; shipping_address: { country: string }; tax_total: number; total: number }>(rpc('create_order', { idempotency_key: crypto.randomUUID(),
      items: [{ variant_id: mugId, quantity: 1 }],
      address: { recipient_name: 'John', phone: '1', country: 'CA', line1: '1 Infinite Loop, CA' },
    }, u.token));
    cleanupOrderId = replacement.id;
    expect(replacement.shipping_address.country).toBe('CA');
    expect(Number(replacement.tax_total)).toBe(0);
    expect(Number(replacement.total)).toBeCloseTo(9.9);
  });

  test('改地址后原运法不支持新国家 → 拒绝', async () => {
    const u = await signup();
    const intl = await shippingByName('Regional shipping');       // 仅 CA/JP/SG
    const { data: o } = await rpc('create_order', { idempotency_key: crypto.randomUUID(),
      items: [{ variant_id: mugId, quantity: 1 }],
      address: { recipient_name: 'John', phone: '1', country: 'CA', line1: '1 Infinite Loop' },
      shipping_method_id: intl,
    }, u.token);

    resources.defer(() => checked(rpc('cancel_order', { order_id: (o as { id: string }).id }, u.token)));
    const { data } = await rpc('update_order_address', {
      order_id: (o as { id: string }).id, address: TEST_ADDRESS,
    }, u.token);
    expect((data as { message: string }).message).toBe('shipping method not available for this country');
  });

  test('税率可配置对运费计税（include_shipping）', async () => {
    const { data: created } = await api('/rest/v1/tax_rates?select=id', {
      service: true, method: 'POST',
      body: { name: '德国增值税', country: 'DE', rate: 0.19, include_shipping: true },
    });
    const rateId = (created as { id: string }[])[0].id;
    resources.defer(() => checked(api(`/rest/v1/tax_rates?id=eq.${rateId}`, { service: true, method: 'PATCH', body: { is_active: false } })));
    const ship = await shippingByName('Standard shipping');

    const { data } = await rpc('price_checkout', {
      items: [{ variant_id: mugId, quantity: 1 }],
      address: { recipient_name: 'Max', phone: '1', country: 'DE', line1: 'Berliner Str. 1' },
      shipping_method_id: ship,
    });
    const p = data as { shipping_total: number; tax_total: number; total: number };
    expect(Number(p.shipping_total)).toBeCloseTo(8);       // 9.9 < 99 不包邮
    expect(Number(p.tax_total)).toBeCloseTo(3.4);          // (9.9 + 8) × 19% = 3.40
    expect(Number(p.total)).toBeCloseTo(21.3);


  });
});

describe('修复：退款闭环', () => {
  let owner: TestUser;
  let orderId: string;
  let orderItemId: string;
  let mugId: string, sku: string;
  const fixtures = new Cleanup();
  beforeAll(async () => {
    const product = await stockedProduct(admin, { price: 9.9, cleanup: fixtures });
    mugId = product.variantId; sku = product.sku;
    const [promotion] = await checked<Array<{ id: string }>>(api('/rest/v1/promotions?select=id', {
      service: true, method: 'POST', body: {
        name: 'Refund quantity fixture', type: 'item_percentage', params: { percent: 30, min_quantity: 3 },
        apply_scope: 'selected', stackable: true,
      },
    }));
    fixtures.defer(() => disablePromo(promotion.id));
    await checked(api('/rest/v1/promotion_targets', {
      service: true, method: 'POST', body: { promotion_id: promotion.id, product_id: product.productId },
    }));
  });
  afterAll(() => fixtures.run());

  beforeEach(async () => {
    owner = await signup();
    // Each case starts paid but unrefunded; no preceding test supplies state.
    // 商品净额 20.79、商品税 2.70；另留 8 运费，验证商品退完不自动退配送费。
    const { data: o } = await rpc('create_order', { idempotency_key: crypto.randomUUID(),
      items: [{ variant_id: mugId, quantity: 3 }], address: TEST_ADDRESS,
      shipping_method_id: await shippingByName('Standard shipping'),
    }, owner.token);
    orderId = (o as { id: string }).id;
    const { data: items } = await api(`/rest/v1/order_items?order_id=eq.${orderId}&select=id`, { token: owner.token });
    orderItemId = (items as { id: string }[])[0].id;
    await checked(rpc('mark_order_paid', { idempotency_key: crypto.randomUUID(), order_id: orderId, provider: 'manual' }, admin.token));
  });

  test('非 admin 不能退款', async () => {
    const { data } = await rpc('refund_order', { idempotency_key: crypto.randomUUID(), order_id: orderId }, owner.token);
    expect((data as { message: string }).message).toBe('admin only');
  });

  test('按行部分退款：净额与对应税按数量分摊，推进 partially_refunded', async () => {
    const { data } = await rpc('refund_order', { idempotency_key: crypto.randomUUID(),
      order_id: orderId, items: [{ order_item_id: orderItemId, quantity: 1 }], reason: '破损一件',
    }, admin.token);
    expect((data as { financial_status: string }).financial_status).toBe('partially_refunded');

    const ledger = await checked<{ transactions: Array<{ kind: string; amount: number }> }>(rpc(
      'get_order_ledger', { order_id: orderId }, owner.token,
    ));
    expect(Number(ledger.transactions.find(transaction => transaction.kind === 'refund')?.amount))
      .toBeCloseTo(7.83);  // 商品 20.79/3 + 税 2.70/3

    const { data: items } = await api(
      `/rest/v1/order_items?id=eq.${orderItemId}&select=refunded_quantity,refunded_amount`, { service: true });
    const it = (items as { refunded_quantity: number; refunded_amount: number }[])[0];
    expect(it.refunded_quantity).toBe(1);
    expect(Number(it.refunded_amount)).toBeCloseTo(6.93);
  });

  test('超量退同一行被拒', async () => {
    await checked(rpc('refund_order', { idempotency_key: crypto.randomUUID(), order_id: orderId, items: [{ order_item_id: orderItemId, quantity: 1 }] }, admin.token));
    const { data } = await rpc('refund_order', { idempotency_key: crypto.randomUUID(),
      order_id: orderId, items: [{ order_item_id: orderItemId, quantity: 3 }], // 已退1，最多再退2
    }, admin.token);
    expect((data as { message: string }).message).toContain('quantity exceeds available');
  });

  test('退完该行取剩余全部（无舍入误差）', async () => {
    await checked(rpc('refund_order', { idempotency_key: crypto.randomUUID(), order_id: orderId, items: [{ order_item_id: orderItemId, quantity: 1 }] }, admin.token));
    await rpc('refund_order', { idempotency_key: crypto.randomUUID(),
      order_id: orderId, items: [{ order_item_id: orderItemId, quantity: 2 }],
    }, admin.token);
    const { data: items } = await api(
      `/rest/v1/order_items?id=eq.${orderItemId}&select=refunded_quantity,refunded_amount`, { service: true });
    const it = (items as { refunded_quantity: number; refunded_amount: number }[])[0];
    expect(it.refunded_quantity).toBe(3);
    expect(Number(it.refunded_amount)).toBeCloseTo(20.79);  // 6.93 + 13.86，行净额退尽
  });

  test('自定义金额超额被拒；退剩余差额 → refunded', async () => {
    await checked(rpc('refund_order', { idempotency_key: crypto.randomUUID(), order_id: orderId, items: [{ order_item_id: orderItemId, quantity: 3 }] }, admin.token));
    const over = await rpc('refund_order', { idempotency_key: crypto.randomUUID(), order_id: orderId, amount: 999 }, admin.token);
    expect((over.data as { message: string }).message).toContain('exceeds available refundable balance');

    // 商品净额和对应税已退尽；剩余运费以显式未分配金额退款，不猜测组成。
    const { data } = await rpc('refund_order', { idempotency_key: crypto.randomUUID(), order_id: orderId, reason: '剩余金额退款' }, admin.token);
    expect((data as { financial_status: string }).financial_status).toBe('refunded');

    // 已全额退款的订单不再可退（状态守卫先于余额检查触发）
    const again = await rpc('refund_order', { idempotency_key: crypto.randomUUID(), order_id: orderId }, admin.token);
    expect((again.data as { message: string }).message).toContain('not refundable');
  });

  test('restock=true 释放未发货库存并记 cancel 流水', async () => {
    const before = await stockOf(sku);
    const u = await signup();
    const { data: o } = await rpc('create_order', {
      idempotency_key: crypto.randomUUID(), items: [{ variant_id: mugId, quantity: 2 }], address: TEST_ADDRESS,
    }, u.token);
    const oid = (o as { id: string }).id;
    await rpc('mark_order_paid', { idempotency_key: crypto.randomUUID(), order_id: oid }, admin.token);
    const { data: items } = await api(`/rest/v1/order_items?order_id=eq.${oid}&select=id`, { token: u.token });

    await rpc('refund_order', { idempotency_key: crypto.randomUUID(),
      order_id: oid, items: [{ order_item_id: (items as { id: string }[])[0].id, quantity: 2 }],
      restock: true, reason: '七天无理由',
    }, admin.token);

    expect(await stockOf(sku)).toBe(before);   // 下单扣2 → 退回补2
    const { data: moves } = await api(
      `/rest/v1/inventory_movements?order_id=eq.${oid}&reason=eq.cancel&select=delta`, { service: true });
    expect((moves as { delta: number }[])[0].delta).toBe(2);
  });

  test('未支付订单不能退款', async () => {
    const u = await signup();
    const { data: o } = await rpc('create_order', {
      idempotency_key: crypto.randomUUID(), items: [{ variant_id: mugId, quantity: 1 }], address: TEST_ADDRESS,
    }, u.token);
    const { data } = await rpc('refund_order', { idempotency_key: crypto.randomUUID(), order_id: (o as { id: string }).id }, admin.token);
    expect((data as { message: string }).message).toContain('not refundable');
  });
});

// Retained from the original review; grouped by business domain.
test('payment_transactions.amount 不允许负数（方向由 kind 表达）', async () => {
    const u = await signup();
    const { data: o } = await rpc('create_order', {
      idempotency_key: crypto.randomUUID(), items: [{ variant_id: mugId, quantity: 1 }], address: TEST_ADDRESS,
    }, u.token);
    resources.defer(() => checked(rpc('cancel_order', { order_id: (o as { id: string }).id }, u.token)));
    await expect(withRollback(database, sql => sql`
      insert into commerce.payment_transactions(order_id,provider,kind,status,amount,currency)
      values (${(o as { id: string }).id}::uuid,'manual','refund','succeeded',-5,'USD')
    `)).rejects.toMatchObject({ errno: '23514', constraint: 'payment_transactions_amount_check' });
  });
