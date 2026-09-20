import { afterAll, beforeAll, expect, test } from 'bun:test';
import { api, checked, command, makeAdmin, rpc, signup, type TestUser } from './helpers';
import { stockedProduct, archiveProduct } from './support/catalog';
import { fixtureOrder, type FixtureOrder } from './payment-fixtures';

let admin: TestUser, buyer: TestUser, other: TestUser;
let product: Awaited<ReturnType<typeof stockedProduct>>;
const orders: FixtureOrder[] = [];
interface Summary { id: string; order_number: number; financial_status: string; total: number }
interface Page { items: Summary[]; next_cursor: number | null }
beforeAll(async () => {
  [admin,buyer,other] = await Promise.all([signup(),signup(),signup()]);
  await makeAdmin(admin.userId);
  product = await stockedProduct(admin, { trackInventory: false });
  for (let i = 0; i < 3; i++) {
    const order = await fixtureOrder(product,buyer,i + 1,i !== 1); orders.push(order);
    if (i !== 1) await checked(command('cancel_order', { order_id: order.id },buyer.token));
    else {
      await checked(command('mark_order_paid', { idempotency_key: crypto.randomUUID(), order_id: order.id, provider: 'manual' },admin.token));
      await checked(command('create_fulfillment', { order_id: order.id, items: [{ order_item_id: order.itemId, quantity: 1 }],
        idempotency_key: crypto.randomUUID(), carrier: 'Test carrier', tracking_number: 'TRACK' },admin.token));
    }
  }
  await checked(api(`/rest/v1/orders?id=eq.${orders[1].id}`, { service: true, method: 'PATCH', body: { admin_note: 'internal only' } }));
});
afterAll(async () => { if (product) await archiveProduct(product.productId); });

test('客户订单游标不跨客户，筛选与后台读取一致，列表不返回详情或内部字段', async () => {
  const first = await checked<Page>(rpc('list_customer_orders', { page_size: 2 },buyer.token));
  expect(first.items.map(o => o.id)).toEqual([orders[2].id,orders[1].id]);
  expect(first.next_cursor).toBe(first.items[1].order_number);
  expect(Object.keys(first.items[0]).sort()).toEqual(['id','order_number','status','financial_status','fulfillment_status','currency','total','created_at'].sort());
  const last = await checked<Page>(rpc('list_customer_orders', { page_size: 2, after_order_number: first.next_cursor },buyer.token));
  expect(last.items.map(o => o.id)).toEqual([orders[0].id]); expect(last.next_cursor).toBeNull();
  expect(await checked<Page>(rpc('list_customer_orders', {},other.token))).toEqual({ items: [], next_cursor: null });
  expect(await checked<Page>(rpc('list_customer_orders', {},admin.token))).toEqual({ items: [], next_cursor: null });
  const paid = await checked<Page>(rpc('list_customer_orders', { financial_status_filter: 'paid', fulfillment_status_filter: 'partially_fulfilled' },buyer.token));
  expect(paid.items.map(o => o.id)).toEqual([orders[1].id]); expect(paid.items[0].total).toBe(20);
  expect((await checked<Page>(rpc('list_customer_orders', { status_filter: 'cancelled', financial_status_filter: 'paid' },buyer.token))).items).toEqual([]);
  const managed = await checked<Page>(rpc('list_admin_orders', { customer_id: buyer.customerId, page_size: 2 },admin.token));
  expect(managed.items.map(o => o.id)).toEqual(first.items.map(o => o.id));
  expect(managed.items[0]).toMatchObject({ customer_id: buyer.customerId, email: buyer.email });
  expect(await checked<Page>(rpc('list_admin_orders', { customer_id: crypto.randomUUID() },admin.token))).toEqual({ items: [], next_cursor: null });
});

test('订单详情读取历史价格与关系化履约，客户永远不取得 admin_note', async () => {
  await checked(api(`/rest/v1/product_variants?id=eq.${product.variantId}`, { service: true, method: 'PATCH', body: { price: 77 } }));
  const customer = await checked<Record<string, unknown>>(rpc('get_customer_order', { order_id: orders[1].id },buyer.token));
  expect(customer).toMatchObject({ id: orders[1].id, total: 20, financial_status: 'paid',
    pricing: { lines: [{ id: orders[1].itemId, quantity: 2, unit_price: 10, line_total: 20 }] },
    fulfillments: [{ carrier: 'Test carrier', tracking_number: 'TRACK', lines: [{ order_item_id: orders[1].itemId, quantity: 1 }] }] });
  expect(customer).not.toHaveProperty('admin_note'); expect(customer).not.toHaveProperty('payment_intents');
  const managed = await checked<Record<string, unknown>>(rpc('get_admin_order', { order_id: orders[1].id },admin.token));
  expect(managed).toEqual({ ...customer, admin_note: 'internal only' });
  for (const token of [other.token,admin.token]) {
    expect(await checked<unknown>(rpc('get_customer_order', { order_id: orders[1].id },token))).toBeNull();
  }
  expect(await checked<unknown>(rpc('get_admin_order', { order_id: crypto.randomUUID() },admin.token))).toBeNull();
  expect(await checked<unknown>(rpc('get_admin_order', { order_id: orders[1].id },undefined,true))).toEqual(managed);
});

test('订单查询拒绝越权、非法筛选及匿名化账号，不能由请求指定客户归属', async () => {
  for (const name of ['get_admin_order','list_admin_orders','get_customer_order','list_customer_orders']) {
    expect((await rpc(name,name.startsWith('get') ? { order_id: orders[0].id } : {})).data).toMatchObject({ code: '42501' });
  }
  for (const name of ['get_admin_order','list_admin_orders']) {
    expect((await rpc(name,name.startsWith('get') ? { order_id: orders[0].id } : {},buyer.token)).data).toMatchObject({ code: '42501' });
  }
  for (const args of [{ page_size: 0 },{ page_size: 101 },{ page_size: null },{ status_filter: 'bad' },
    { financial_status_filter: 'bad' },{ fulfillment_status_filter: 'bad' }]) {
    expect((await rpc('list_customer_orders',args,buyer.token)).status).toBe(400);
    expect((await rpc('list_admin_orders',args,admin.token)).status).toBe(400);
  }
  expect((await rpc('list_customer_orders',{ customer_id: buyer.customerId },other.token)).status).toBeGreaterThanOrEqual(400);
  await checked(command('anonymize_customer',{ customer_id: buyer.customerId },admin.token));
  expect((await rpc('list_customer_orders',{},buyer.token)).data).toMatchObject({ code: '42501' });
  expect((await rpc('get_customer_order',{ order_id: orders[1].id },buyer.token)).data).toMatchObject({ code: '42501' });
  expect((await checked<Page>(rpc('list_admin_orders',{ customer_id: buyer.customerId },admin.token))).items).toHaveLength(3);
});
