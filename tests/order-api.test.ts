import { afterAll, beforeAll, expect, test } from 'bun:test';
import { api, checked, command, makeAdmin, rpc, signup, type TestUser } from './helpers';
import { stockedProduct, archiveProduct } from './support/catalog';
import { fixtureOrder, type FixtureOrder } from './payment-fixtures';
import { testDatabase } from './database-concurrency';
import { withRollback } from '../scripts/lib/transactions';
import { AdminBackend } from '../mcp/src/backend';
import { mcpSession, toolData } from './support/mcp';
import { API, ANON_KEY } from './helpers';

let admin: TestUser, buyer: TestUser, other: TestUser;
let product: Awaited<ReturnType<typeof stockedProduct>>;
const orders: FixtureOrder[] = [];
interface Summary { id: string; order_number: string; financial_status: string; total: number }
interface Page { items: Summary[]; next_cursor: string | null }
beforeAll(async () => {
  [admin,buyer,other] = await Promise.all([signup(),signup(),signup()]);
  await makeAdmin(admin.userId);
  product = await stockedProduct(admin, { trackInventory: false });
  for (let i = 0; i < 3; i++) {
    const order = await fixtureOrder(product,buyer,i + 1,i !== 1); orders.push(order);
    if (i !== 1) await checked(command('cancel_order', { order_id: order.id },buyer.token));
    else {
      const args = { idempotency_key: crypto.randomUUID(), order_id: order.id, provider: 'manual' };
      const paid = await checked<{ order_number: string; admin_note: null }>(command('mark_order_paid', args,admin.token));
      expect(paid.order_number).toMatch(/^[1-9][0-9]*$/);
      expect(paid.admin_note).toBeNull();
      expect(await checked<typeof paid>(command('mark_order_paid', args,admin.token))).toEqual(paid);
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
  expect(typeof first.items[0].order_number).toBe('string');
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
  const session = await mcpSession(new AdminBackend({ url: API, anonKey: ANON_KEY, accessToken: admin.token }));
  try {
    expect(await toolData<Page>(session.client, 'list_admin_orders', { customer_id: buyer.customerId, page_size: 2 })).toEqual(managed);
    const next = await toolData<Page>(session.client, 'list_admin_orders', {
      customer_id: buyer.customerId, page_size: 2, after_order_number: managed.next_cursor,
    });
    expect(next.items.map(o => o.id)).toEqual([orders[0].id]);
    expect(next.next_cursor).toBeNull();
  } finally { await session.close(); }
});

test('订单号覆盖 bigint 边界，按数值排序并精确翻页，详情保留字符串', async () => {
  const db = testDatabase();
  try {
    await withRollback(db, async tx => {
      // Synthetic read fixtures only. Do not advance the shared identity sequence.
      await tx`set local session_replication_role=replica`;
      const customerId = crypto.randomUUID();
      const numbers = ['9223372036854775807', '9007199254740993', '9007199254740992', '10', '9', '0', '-9007199254740993', '-9223372036854775808'];
      for (const number of numbers) {
        await tx`insert into public.orders(order_number,customer_id,email,subtotal,total,shipping_address,payment_expires_at)
          overriding system value values (${number}::bigint,${customerId}::uuid,'fixture@example.com',1,1,'{"country":"US"}',now()+interval '15 minutes')`;
      }
      await tx`set local session_replication_role=origin`;
      await tx`select set_config('request.jwt.claims','{"role":"service_role"}',true)`;
      let cursor: string | null = null;
      for (let i = 0; i < numbers.length; i++) {
        const [row]: { data: Page }[] = await tx`select public.list_admin_orders(page_size=>1,customer_id=>${customerId}::uuid,after_order_number=>${cursor}::text) data`;
        expect(row.data.items).toHaveLength(1);
        expect(row.data.items[0].order_number).toBe(numbers[i]);
        expect(row.data.next_cursor).toBe(i === numbers.length - 1 ? null : numbers[i]);
        const [detail] = await tx`select public.get_admin_order(${row.data.items[0].id}::uuid) data`;
        expect(detail.data.order_number).toBe(numbers[i]);
        const [ledger] = await tx`select public.get_order_ledger(${row.data.items[0].id}::uuid) data`;
        expect(ledger.data.order.order_number).toBe(numbers[i]);
        cursor = row.data.next_cursor;
      }
      for (const invalid of ['01', '-0', '+1', ' 1', '1\n', '1.5', '1e3', '', '9223372036854775808', '-9223372036854775809']) {
        await expect(tx.savepoint(async sp => {
          await sp`select public.list_admin_orders(after_order_number=>${invalid})`;
        })).rejects.toMatchObject({ errno: invalid.endsWith('808') || invalid.endsWith('809') ? '22003' : '22023' });
      }
    });
  } finally { await db.close(); }
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
