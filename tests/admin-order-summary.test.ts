import { afterAll, beforeAll, expect, test } from 'bun:test';
import { AdminBackend } from '../mcp/src/backend';
import { API, ANON_KEY, checked, rpc, signup, makeAdmin, type TestUser } from './helpers';
import { mcpSession, toolData } from './support/mcp';
import { stockedProduct } from './support/catalog';
import { Cleanup } from './support/cleanup';
import { fixtureOrder } from './payment-fixtures';
import { testDatabase } from './database-concurrency';
import { withRollback } from '../scripts/lib/transactions';

const db = testDatabase(),
  cleanup = new Cleanup();
let admin: TestUser, buyer: TestUser, session: Awaited<ReturnType<typeof mcpSession>>;
interface Summary {
  order_count: string;
  order_total_amount: string;
  status_counts: Record<string, string>;
  financial_status_counts: Record<string, string>;
  fulfillment_status_counts: Record<string, string>;
}
const summary = (start_at: string, end_at: string) =>
  toolData<Summary>(session.client, 'get_admin_order_summary', { start_at, end_at });
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

test('真实订单 cohort 含未付款、取消和零元，状态变化不改变原始金额；微秒区间边界', async () => {
  const p = await stockedProduct(admin, { price: 12.35, trackInventory: false, cleanup });
  const free = await stockedProduct(admin, { price: 0, trackInventory: false, cleanup });
  const first = await fixtureOrder(p, buyer),
    second = await fixtureOrder(p, buyer, 2),
    third = await fixtureOrder(free, buyer);
  const rows = await db<Array<{ at: string; after: string }>>`select
    to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at,
    to_char((created_at+interval '1 microsecond') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as after
    from public.orders where id in (${first.id}::uuid,${second.id}::uuid,${third.id}::uuid) order by created_at`;
  expect(await summary(rows[0].at, rows[1].at)).toMatchObject({
    order_count: '1',
    order_total_amount: '12.35',
  });
  const before = await summary(rows[0].at, rows[2].after);
  expect(before).toMatchObject({
    order_count: '3',
    order_total_amount: '37.05',
    status_counts: { open: '3' },
    financial_status_counts: { pending: '2', paid: '1' },
    fulfillment_status_counts: { unfulfilled: '3' },
  });
  await checked(rpc('cancel_order', { order_id: first.id }, admin.token));
  await checked(
    rpc('mark_order_paid', { order_id: second.id, idempotency_key: crypto.randomUUID() }, admin.token),
  );
  await checked(
    rpc(
      'refund_order',
      { order_id: second.id, amount: 3.25, idempotency_key: crypto.randomUUID() },
      admin.token,
    ),
  );
  await checked(
    rpc(
      'create_fulfillment',
      {
        order_id: second.id,
        items: [{ order_item_id: second.itemId, quantity: 1 }],
        idempotency_key: crypto.randomUUID(),
      },
      admin.token,
    ),
  );
  const after = await summary(rows[0].at, rows[2].after);
  expect(after).toMatchObject({
    order_count: '3',
    order_total_amount: '37.05',
    status_counts: { open: '2', cancelled: '1' },
    financial_status_counts: { pending: '1', partially_refunded: '1', paid: '1' },
    fulfillment_status_counts: { unfulfilled: '2', partially_fulfilled: '1' },
  });
  expect(Object.keys(after).sort()).toEqual(
    [
      'start_at',
      'end_at',
      'currency',
      'time_basis',
      'order_count',
      'order_total_amount',
      'status_counts',
      'financial_status_counts',
      'fulfillment_status_counts',
    ].sort(),
  );
});

test('空结果、时区偏移、31 天边界和 RPC 独立权限', async () => {
  const range = { start_at: '1903-01-01T00:00:00Z', end_at: '1903-02-01T00:00:00Z' };
  const empty = await summary(range.start_at, range.end_at);
  expect(empty).toMatchObject({
    order_count: '0',
    order_total_amount: '0.00',
    status_counts: {},
    financial_status_counts: {},
    fulfillment_status_counts: {},
  });
  expect(await summary('1903-01-01T09:00:00+09:00', '1903-02-01T09:00:00+09:00')).toEqual(empty);
  expect(await checked<Summary>(rpc('get_admin_order_summary', range, undefined, true))).toEqual(empty);
  for (const token of [undefined, buyer.token])
    expect((await rpc('get_admin_order_summary', range, token)).data).toMatchObject({ code: '42501' });
  for (const args of [
    { ...range, start_at: null },
    { ...range, end_at: 'infinity' },
    { ...range, end_at: range.start_at },
    { ...range, start_at: range.end_at },
    { ...range, end_at: '1903-02-01T00:00:00.000001Z' },
  ])
    expect((await rpc('get_admin_order_summary', args, admin.token)).data).toMatchObject({ code: '22023' });
});

test('隔离容量夹具：10000 个订单精确汇总，10001 拒绝截断', async () => {
  // Reporting-only synthetic volume, always rolled back; not a test of order writers.
  await withRollback(db, async (tx) => {
    await tx`set local session_replication_role=replica`;
    await tx`insert into public.orders(order_number,customer_id,email,subtotal,total,shipping_address,created_at,payment_expires_at)
      overriding system value
      select -9000000000000000000+i,${buyer.customerId}::uuid,'private@example.com',9999999999.99,9999999999.99,
        '{"country":"US"}'::jsonb,'1904-01-01'::timestamptz + case when i=10001 then interval '1 day' else interval '0' end,
        '1904-01-01'::timestamptz + case when i=10001 then interval '1 day' else interval '0' end + interval '15 minutes'
      from generate_series(1,10001) i`;
    await tx`set local session_replication_role=origin`;
    await tx`select set_config('request.jwt.claims','{"role":"service_role"}',true)`;
    const [row] = await tx`select public.get_admin_order_summary('1904-01-01','1904-01-02') as data`;
    expect(row.data).toMatchObject({
      order_count: '10000',
      order_total_amount: '99999999999900.00',
      status_counts: { open: '10000' },
    });
    await expect(
      tx.savepoint(async (sp) => {
        await sp`select public.get_admin_order_summary('1904-01-01','1904-01-03')`;
      }),
    ).rejects.toMatchObject({ errno: 'PT422' });
  });
});
