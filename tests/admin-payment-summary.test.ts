import { afterAll, beforeAll, expect, test } from 'bun:test';
import { AdminBackend } from '../mcp/src/backend';
import { API, ANON_KEY, checked, rpc, signup, makeAdmin, type TestUser } from './helpers';
import { mcpSession, toolData } from './support/mcp';
import { stockedProduct, archiveProduct } from './support/catalog';
import { fixtureOrder } from './payment-fixtures';
import { testDatabase } from './database-concurrency';
import { withRollback } from '../scripts/lib/transactions';

const db = testDatabase();
let admin: TestUser, buyer: TestUser, product: Awaited<ReturnType<typeof stockedProduct>>;
let session: Awaited<ReturnType<typeof mcpSession>>;
const summary = (start_at: string, end_at: string) =>
  toolData<Record<string, string>>(session.client, 'get_admin_payment_summary', { start_at, end_at });
beforeAll(async () => {
  admin = await signup();
  buyer = await signup();
  await makeAdmin(admin.userId);
  product = await stockedProduct(admin, { trackInventory: false });
  session = await mcpSession(new AdminBackend({ url: API, anonKey: ANON_KEY, accessToken: admin.token }));
});
afterAll(async () => {
  try {
    if (product) await archiveProduct(product.productId);
  } finally {
    await session?.close();
    await db.close();
  }
});

test('真实手工收款/退款：按账本时间而非下单时间，微秒左闭右开，退款窗口可为负', async () => {
  const order = await fixtureOrder(product, buyer);
  await checked(
    rpc('mark_order_paid', { order_id: order.id, idempotency_key: crypto.randomUUID() }, admin.token),
  );
  await checked(
    rpc(
      'refund_order',
      { order_id: order.id, amount: 3.25, idempotency_key: crypto.randomUUID() },
      admin.token,
    ),
  );
  const rows = await db<
    Array<{ kind: string; at: string; after: string }>
  >`select kind,to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at,
    to_char((created_at+interval '1 microsecond') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as after
    from commerce.payment_transactions where order_id=${order.id}::uuid order by created_at`;
  expect(rows.map((r) => r.kind)).toEqual(['capture', 'refund']);
  const both = await summary(rows[0].at, rows[1].after);
  expect(both).toMatchObject({
    currency: 'USD',
    time_basis: 'payment_transactions.created_at',
    capture_count: '1',
    refund_count: '1',
    captured_amount: '10.00',
    refunded_amount: '3.25',
    net_amount: '6.75',
  });
  expect(Object.keys(both).sort()).toEqual(
    [
      'start_at',
      'end_at',
      'currency',
      'time_basis',
      'capture_count',
      'refund_count',
      'captured_amount',
      'refunded_amount',
      'net_amount',
    ].sort(),
  );
  expect(await summary(rows[0].at, rows[1].at)).toMatchObject({
    capture_count: '1',
    refund_count: '0',
    net_amount: '10.00',
  });
  expect(await summary(rows[1].at, rows[1].after)).toMatchObject({
    capture_count: '0',
    refund_count: '1',
    net_amount: '-3.25',
  });
});

test('空区间、精确 31 天、时区偏移等价；权限及无效时间范围由 RPC 独立校验', async () => {
  const range = { start_at: '1901-01-01T00:00:00Z', end_at: '1901-02-01T00:00:00Z' };
  const empty = await summary(range.start_at, range.end_at);
  expect(empty).toMatchObject({
    capture_count: '0',
    refund_count: '0',
    captured_amount: '0.00',
    refunded_amount: '0.00',
    net_amount: '0.00',
  });
  expect(await summary('1901-01-01T09:00:00+09:00', '1901-02-01T09:00:00+09:00')).toEqual(empty);
  expect(
    await checked<Record<string, string>>(rpc('get_admin_payment_summary', range, undefined, true)),
  ).toEqual(empty);
  for (const token of [undefined, buyer.token])
    expect((await rpc('get_admin_payment_summary', range, token)).data).toMatchObject({ code: '42501' });
  for (const args of [
    { ...range, start_at: null },
    { ...range, end_at: 'infinity' },
    { ...range, end_at: range.start_at },
    { ...range, start_at: range.end_at },
    { ...range, end_at: '1901-02-01T00:00:00.000001Z' },
  ])
    expect((await rpc('get_admin_payment_summary', args, admin.token)).data).toMatchObject({ code: '22023' });
});

test('报表隔离夹具：排除非成功/非收退款，10000 条准确求和，10001 条拒绝截断结果', async () => {
  // Reporting-only bulk fixture, never committed. Bypass transactional writers only
  // while constructing synthetic volume; restore triggers before testing the RPC.
  await withRollback(db, async (tx) => {
    await tx`set local session_replication_role=replica`;
    const orderId = crypto.randomUUID();
    await tx`insert into commerce.payment_transactions(order_id,provider,kind,status,amount,currency,created_at)
      select ${orderId}::uuid,'manual','capture','succeeded',9999999999.99,'USD','1902-01-01'::timestamptz
      from generate_series(1,10000)`;
    await tx`insert into commerce.payment_transactions(order_id,provider,kind,status,amount,currency,created_at)
      values (${orderId}::uuid,'manual','capture','pending',50,'USD','1902-01-01'),
        (${orderId}::uuid,'manual','refund','failed',40,'USD','1902-01-01'),
        (${orderId}::uuid,'manual','authorization','succeeded',30,'USD','1902-01-01'),
        (${orderId}::uuid,'manual','capture','succeeded',1,'USD','1902-01-02')`;
    await tx`set local session_replication_role=origin`;
    await tx`select set_config('request.jwt.claims','{"role":"service_role"}',true)`;
    const [row] = await tx`select public.get_admin_payment_summary('1902-01-01','1902-01-02') as data`;
    expect(row.data).toMatchObject({
      capture_count: '10000',
      refund_count: '0',
      captured_amount: '99999999999900.00',
      net_amount: '99999999999900.00',
    });
    // Savepoint lets the intentional error coexist with guaranteed fixture rollback.
    await expect(
      tx.savepoint(async (sp) => {
        await sp`select public.get_admin_payment_summary('1902-01-01','1902-01-03')`;
      }),
    ).rejects.toMatchObject({ errno: 'PT422' });
  });
});
