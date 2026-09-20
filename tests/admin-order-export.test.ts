import { afterAll, beforeAll, expect, test } from 'bun:test';
import { AdminBackend } from '../mcp/src/backend';
import { API, ANON_KEY, checked, rpc, signup, makeAdmin, type TestUser } from './helpers';
import { mcpSession, toolData } from './support/mcp';
import { stockedProduct } from './support/catalog';
import { Cleanup } from './support/cleanup';
import { fixtureOrder } from './payment-fixtures';
import { testDatabase } from './database-concurrency';

const db = testDatabase(),
  cleanup = new Cleanup();
let admin: TestUser, buyer: TestUser, session: Awaited<ReturnType<typeof mcpSession>>;
interface Page {
  items: Array<Record<string, string>>;
  next_cursor: string | null;
}
const read = (args: Record<string, unknown>) => toolData<Page>(session.client, 'export_admin_orders', args);
beforeAll(async () => {
  admin = await signup();
  buyer = await signup();
  await makeAdmin(admin.userId);
  session = await mcpSession(new AdminBackend({ url: API, anonKey: ANON_KEY, accessToken: admin.token }));
});
afterAll(async () => {
  try {
    await cleanup.run();
  } finally {
    await session?.close();
    await db.close();
  }
});

test('真实订单 UUID 分页无重复，字段白名单、字符串金额及取消状态，微秒边界', async () => {
  const p = await stockedProduct(admin, { price: 12.35, trackInventory: false, cleanup });
  const orders = [
    await fixtureOrder(p, buyer),
    await fixtureOrder(p, buyer, 2),
    await fixtureOrder(p, buyer, 3),
  ];
  await checked(rpc('cancel_order', { order_id: orders[1].id }, admin.token));
  const times = await db<Array<{ at: string; after: string }>>`select
    to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at,
    to_char((created_at+interval '1 microsecond') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as after
    from public.orders where id in (${orders[0].id}::uuid,${orders[1].id}::uuid,${orders[2].id}::uuid) order by created_at`;
  const range = { start_at: times[0].at, end_at: times[2].after };
  const first = await read({ ...range, page_size: 2 });
  const last = await read({ ...range, page_size: 2, after_id: first.next_cursor });
  const items = [...first.items, ...last.items];
  expect(items.map((x) => x.id)).toEqual(orders.map((x) => x.id).sort());
  expect(first.next_cursor).toBe(first.items[1].id);
  expect(last.next_cursor).toBeNull();
  expect(Object.keys(items[0]).sort()).toEqual(
    [
      'id',
      'order_number',
      'status',
      'financial_status',
      'fulfillment_status',
      'currency',
      'subtotal',
      'discount_total',
      'shipping_total',
      'tax_total',
      'total',
      'created_at',
      'updated_at',
    ].sort(),
  );
  expect(items.find((x) => x.id === orders[1].id)).toMatchObject({
    status: 'cancelled',
    total: '24.70',
    subtotal: '24.70',
    discount_total: '0.00',
    shipping_total: '0.00',
    tax_total: '0.00',
  });
  expect(items.every((x) => typeof x.order_number === 'string')).toBe(true);
  expect(JSON.stringify(items)).not.toContain(buyer.email);
  expect((await read({ start_at: times[0].at, end_at: times[1].at })).items.map((x) => x.id)).toEqual([
    orders[0].id,
  ]);
  expect((await read({ ...range, after_id: items[2].id })).items).toEqual([]);
  expect(
    await checked<Page>(rpc('export_admin_orders', { ...range, page_size: 2 }, undefined, true)),
  ).toEqual(first);
});

test('空导出、时区偏移与范围/页大小/权限独立校验，不允许自选敏感字段', async () => {
  const range = { start_at: '1905-01-01T00:00:00Z', end_at: '1905-02-01T00:00:00Z' };
  const empty = await read(range);
  expect(empty).toMatchObject({ items: [], next_cursor: null });
  expect(await read({ start_at: '1905-01-01T09:00:00+09:00', end_at: '1905-02-01T09:00:00+09:00' })).toEqual(
    empty,
  );
  for (const token of [undefined, buyer.token])
    expect((await rpc('export_admin_orders', range, token)).data).toMatchObject({ code: '42501' });
  for (const patch of [
    { page_size: 0 },
    { page_size: 101 },
    { page_size: null },
    { start_at: null },
    { end_at: 'infinity' },
    { end_at: range.start_at },
    { start_at: range.end_at },
    { end_at: '1905-02-01T00:00:00.000001Z' },
  ])
    expect((await rpc('export_admin_orders', { ...range, ...patch }, admin.token)).data).toMatchObject({
      code: '22023',
    });
  const invalid = await session.client.callTool({
    name: 'export_admin_orders',
    arguments: { ...range, fields: ['email'] },
  });
  expect(invalid.isError).toBe(true);
});
