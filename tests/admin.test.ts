import { describe, test, expect, beforeAll, beforeEach, afterAll, afterEach } from 'bun:test';
import { api, rpc, signup, makeAdmin, stockOf, checked, TEST_ADDRESS, type ApiOptions, type TestUser } from './helpers';
import { fixtureOrder, type FixtureOrder } from './payment-fixtures';
import { stockedProduct, type CatalogFixture } from './support/catalog';
import { Cleanup } from './support/cleanup';

let admin: TestUser, customer: TestUser, product: CatalogFixture;
const cleanup = new Cleanup(), resources = new Cleanup();
afterEach(() => resources.run());
const rawApi = (path: string, opts: ApiOptions) => api(path, { ...opts, returning: 'minimal' });
beforeAll(async () => {
  admin = await signup(); await makeAdmin(admin.userId);
  product = await stockedProduct(admin, { cleanup });
});
beforeEach(async () => { customer = await signup(); });
afterAll(() => cleanup.run());

const fulfill = (order: FixtureOrder, quantity: number, tracking = 'SF001') => rpc('create_fulfillment', {
  order_id: order.id, items: [{ order_item_id: order.itemId, quantity }], carrier: 'Example carrier', tracking_number: tracking,
}, admin.token);
async function givenOrder({ paid = false, fulfilled = 0 } = {}) {
  const order = await fixtureOrder(product, customer, 3, false);
  if (paid) await checked(rpc('mark_order_paid', { order_id: order.id, provider: 'manual' }, admin.token));
  if (fulfilled) await checked(fulfill(order, fulfilled));
  return order;
}
const state = async (order: FixtureOrder) => (await checked<Array<Record<string, unknown>>>(api(
  `/rest/v1/orders?id=eq.${order.id}&select=status,financial_status,fulfillment_status,completed_at`, { token: customer.token },
)))[0];

// Every test constructs the exact lifecycle state it exercises. Running a
// single case, or shuffling this file, must not require earlier tests to pass.
describe('权限边界', () => {
  test('非 admin 不能 set_user_role', async () => {
    const result = await rpc('set_user_role', { user_id: customer.userId, role: 'admin' }, customer.token);
    expect(result.data).toMatchObject({ message: 'admin only' });
  });
  test('admin 可用 set_user_role 管理角色', async () => {
    expect(await checked(rpc('set_user_role', { user_id: customer.userId, role: 'customer' }, admin.token)))
      .toMatchObject({ role: 'customer' });
  });
  test('非 admin 不能 mark_order_paid / create_fulfillment / adjust_inventory', async () => {
    const order = await givenOrder();
    for (const [name, body] of [
      ['mark_order_paid', { order_id: order.id }],
      ['create_fulfillment', { order_id: order.id, items: [{ order_item_id: order.itemId, quantity: 1 }] }],
      ['adjust_inventory', { variant_id: product.variantId, delta: 10 }],
    ] as const) expect((await rpc(name, body, customer.token)).data).toMatchObject({ message: 'admin only' });
  });
  test('非 admin 不能写商品/折扣/运费', async () => {
    for (const [table, body] of [
      ['products', { slug: crypto.randomUUID(), name: 'unauthorized' }],
      ['promotions', { name: 'unauthorized', type: 'order_fixed', params: { amount: 1 } }],
      ['shipping_methods', { name: 'unauthorized', price: 1 }],
    ] as const) {
      const result = await api(`/rest/v1/${table}`, { token: customer.token, method: 'POST', body });
      expect(result.status).toBe(403); expect(result.data).toMatchObject({ code: '42501' });
    }
  });
});

describe('发货（履约）', () => {
  test('即时订单也必须先支付再履约', async () => {
    const result = await fulfill(await givenOrder(), 1);
    expect(result.status).toBe(400);
    expect(result.data).toMatchObject({ message: 'order must be paid before fulfillment' });
  });
  test('mark_order_paid → paid + payments 记录 + 事件', async () => {
    const order = await givenOrder();
    expect(await checked(rpc('mark_order_paid', {
      order_id: order.id, provider: 'manual', provider_ref: `cash-${crypto.randomUUID()}`,
    }, admin.token))).toMatchObject({ financial_status: 'paid' });
    const pays = await checked<Array<Record<string, unknown>>>(api(
      `/rest/v1/payments?order_id=eq.${order.id}&select=provider,kind,status,amount`, { token: customer.token },
    ));
    expect(pays).toEqual([{ provider: 'manual', kind: 'charge', status: 'succeeded', amount: order.total }]);
  });
  test('超发被拒绝', async () => {
    expect((await fulfill(await givenOrder({ paid: true }), 4)).data)
      .toMatchObject({ message: expect.stringContaining('exceeds remaining') });
  });
  test('不能发其他订单的 item', async () => {
    const order = await givenOrder({ paid: true }), other = await givenOrder();
    const result = await rpc('create_fulfillment', {
      order_id: order.id, items: [{ order_item_id: other.itemId, quantity: 1 }],
    }, admin.token);
    expect(result.data).toMatchObject({ message: expect.stringContaining('does not belong to this order') });
  });
  test('部分发货 → partially_fulfilled', async () => {
    const order = await givenOrder({ paid: true });
    expect(await checked(fulfill(order, 2))).toMatchObject({ status: 'shipped' });
    expect(await state(order)).toMatchObject({ fulfillment_status: 'partially_fulfilled', status: 'open' });
  });
  test('累计超发同样被拒绝（2 已发，再发 2 > 3）', async () => {
    expect((await fulfill(await givenOrder({ paid: true, fulfilled: 2 }), 2)).data)
      .toMatchObject({ message: expect.stringContaining('exceeds remaining') });
  });
  test('已发货的订单不能取消、不能改地址', async () => {
    const order = await givenOrder({ paid: true, fulfilled: 2 });
    expect((await rpc('cancel_order', { order_id: order.id }, customer.token)).data)
      .toMatchObject({ message: expect.stringContaining('refund flow') });
    expect((await rpc('update_order_address', { order_id: order.id, address: TEST_ADDRESS }, customer.token)).data)
      .toMatchObject({ message: expect.stringContaining('paid orders') });
  });
  test('买家可读自己订单的物流信息', async () => {
    const order = await givenOrder({ paid: true, fulfilled: 2 });
    const rows = await checked(api(`/rest/v1/fulfillments?order_id=eq.${order.id}&select=carrier,tracking_number,status`, { token: customer.token }));
    expect(rows).toEqual([{ carrier: 'Example carrier', tracking_number: 'SF001', status: 'shipped' }]);
  });
});

describe('支付标记与订单完成', () => {
  test('payments.raw 对买家不可见', async () => {
    const order = await givenOrder({ paid: true });
    expect((await api(`/rest/v1/payments?order_id=eq.${order.id}&select=id,raw`, { token: customer.token })).data)
      .toMatchObject({ code: '42501' });
  });
  test('重复标记支付被拒绝', async () => {
    const order = await givenOrder({ paid: true });
    expect((await rpc('mark_order_paid', { order_id: order.id }, admin.token)).data)
      .toMatchObject({ message: expect.stringContaining('not pending') });
  });
  test('已支付订单不能走 cancel，只能退款流程', async () => {
    const order = await givenOrder({ paid: true });
    expect((await rpc('cancel_order', { order_id: order.id }, customer.token)).data)
      .toMatchObject({ message: expect.stringContaining('refund flow') });
  });
  test('发完剩余数量 → 已支付+已发完 → 自动 completed', async () => {
    const order = await givenOrder({ paid: true, fulfilled: 2 });
    await checked(fulfill(order, 1, 'SF002'));
    expect(await state(order)).toMatchObject({ fulfillment_status: 'fulfilled', status: 'completed', completed_at: expect.any(String) });
  });
  test('订单事件链完整', async () => {
    const order = await givenOrder({ paid: true, fulfilled: 2 });
    await checked(fulfill(order, 1, 'SF002'));
    const rows = await checked<Array<{ type: string }>>(api(
      `/rest/v1/order_events?order_id=eq.${order.id}&select=type&order=id`, { token: customer.token },
    ));
    expect(rows.map(row => row.type)).toEqual(['order_created', 'inventory_reservation_consumed', 'payment_received', 'fulfillment_created', 'fulfillment_created']);
  });
});

describe('库存管理', () => {
  test('adjust_inventory 入库并记流水', async () => {
    const before = await stockOf(product.sku);
    expect(await checked(rpc('adjust_inventory', {
      variant_id: product.variantId, delta: 10, reason: 'restock', note: '补货',
    }, admin.token))).toMatchObject({ on_hand: before + 10 });
    const rows = await checked<Array<Record<string, unknown>>>(api(
      `/rest/v1/inventory_movements?variant_id=eq.${product.variantId}&select=delta,on_hand_after,reason,note&order=id`, { service: true },
    ));
    expect(rows.at(-1)).toMatchObject({ delta: 10, on_hand_after: before + 10, reason: 'restock', note: '补货' });
  });
  test('adjust_inventory 扣成负数被拒绝（约束兜底）', async () => {
    const before = await stockOf(product.sku);
    expect((await rpc('adjust_inventory', { variant_id: product.variantId, delta: -99999, reason: 'adjust' }, admin.token)).data)
      .toMatchObject({ code: '23514' });
    expect(await stockOf(product.sku)).toBe(before);
  });
  test('delta 为 0 被拒绝', async () => {
    expect((await rpc('adjust_inventory', { variant_id: product.variantId, delta: 0, reason: 'adjust' }, admin.token)).data)
      .toMatchObject({ message: expect.stringContaining('non-zero') });
  });
});

// Retained from the original review; grouped by business domain.
describe('修复：管理端写路径收拢', () => {
  let orderId: string, mugId: string;
  beforeEach(async () => {
    const owner = customer;
    const order = await fixtureOrder(product, owner, 1, false);
    orderId = order.id; mugId = product.variantId;
    resources.defer(() => checked(rpc('cancel_order', { order_id: order.id }, owner.token)));
  });

  test('admin 不能直改 orders 的金额/状态字段（42501）', async () => {
    const r = await rawApi(`/rest/v1/orders?id=eq.${orderId}`, {
      token: admin.token, method: 'PATCH', body: { total: 0.01, financial_status: 'paid' },
    });
    expect(r.status).toBe(403);
    expect((r.data as { code: string }).code).toBe('42501');

    // 未被改掉
    const { data } = await api(`/rest/v1/orders?id=eq.${orderId}&select=total,financial_status`, { service: true });
    const o = (data as { total: number; financial_status: string }[])[0];
    expect(Number(o.total)).toBeGreaterThan(1);
    expect(o.financial_status).toBe('pending');
  });

  test('admin 可以直改 admin_note（备注是允许直改的列）', async () => {
    const r = await rawApi(`/rest/v1/orders?id=eq.${orderId}`, {
      token: admin.token, method: 'PATCH', body: { admin_note: '客户要求延迟发货' },
    });
    expect(r.status).toBe(204);
    const { data } = await api(`/rest/v1/orders?id=eq.${orderId}&select=admin_note`, { service: true });
    expect((data as { admin_note: string }[])[0].admin_note).toBe('客户要求延迟发货');
  });

  test('admin 直插 payments / fulfillments 被拒（必须走 RPC）', async () => {
    const p = await rawApi('/rest/v1/payments', {
      token: admin.token, method: 'POST',
      body: { order_id: orderId, kind: 'charge', status: 'succeeded', amount: 1 },
    });
    expect(p.status).toBe(403);

    const f = await rawApi('/rest/v1/fulfillments', {
      token: admin.token, method: 'POST',
      body: { order_id: orderId, items: [{ order_item_id: '00000000-0000-0000-0000-000000000000', quantity: 999 }] },
    });
    expect(f.status).toBe(403);
  });

  test('admin 直改 inventory_levels 被拒（必须走 adjust_inventory 记流水）', async () => {
    const r = await rawApi(`/rest/v1/inventory_levels?variant_id=eq.${mugId}`, {
      token: admin.token, method: 'PATCH', body: { on_hand: 9999 },
    });
    expect(r.status).toBe(403);
  });
});

// Retained from the original review; grouped by business domain.
test('不能降级最后一个 admin', async () => {
    const solo = await signup();
    const admins = await checked<Array<{ id: string }>>(api('/rest/v1/profiles?role=eq.admin&select=id', { service: true }));
    // Restore EVERY original administrator, including after assertion failure.
    resources.defer(() => checked(api(`/rest/v1/profiles?id=eq.${solo.userId}`, { service: true, method: 'PATCH', body: { role: 'customer' } })));
    for (const admin of admins) resources.defer(() => makeAdmin(admin.id));
    await makeAdmin(solo.userId);
    for (const admin of admins) await checked(api(`/rest/v1/profiles?id=eq.${admin.id}`, {
      service: true, method: 'PATCH', body: { role: 'customer' },
    }));
    const result = await rpc('set_user_role', { user_id: solo.userId, role: 'customer' }, solo.token);
    expect(result.status).toBe(400);
    expect(result.data).toMatchObject({ message: 'cannot demote the last admin' });
  });
