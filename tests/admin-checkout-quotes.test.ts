import { afterAll, beforeAll, expect, test } from 'bun:test';
import { AdminBackend } from '../mcp/src/backend';
import { API, ANON_KEY, checked, rpc, signup, makeAdmin, TEST_ADDRESS, type TestUser } from './helpers';
import { mcpSession, toolData } from './support/mcp';
import { stockedProduct } from './support/catalog';
import { Cleanup } from './support/cleanup';
import { testDatabase } from './database-concurrency';
import { withRollback } from '../scripts/lib/transactions';
import { fixtureOrder } from './payment-fixtures';

const db = testDatabase(),
  cleanup = new Cleanup();
let admin: TestUser, buyer: TestUser, session: Awaited<ReturnType<typeof mcpSession>>;
interface Row {
  id: string;
  customer_id: string;
  order_id: string | null;
  status: string;
  stored_status: string;
  is_reserved: boolean;
}
interface Page {
  items: Row[];
  next_cursor: string | null;
}
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

test('管理员发现未转单报价并读快照，分页按 UUID、筛选按 AND，列表不泄漏地址和备注', async () => {
  const p = await stockedProduct(admin, { price: 12.35, trackInventory: false, cleanup });
  const quotes: string[] = [];
  for (let i = 0; i < 3; i++) {
    const q = await checked<{ id: string }>(
      rpc(
        'create_checkout_quote',
        {
          items: [{ variant_id: p.variantId, quantity: i + 1 }],
          address: TEST_ADDRESS,
          note: 'PRIVATE NOTE',
          idempotency_key: crypto.randomUUID(),
        },
        buyer.token,
      ),
    );
    quotes.push(q.id);
    cleanup.defer(() => checked(rpc('cancel_checkout_quote', { quote_id: q.id }, admin.token)));
  }
  const original = await checked<Omit<Row, 'customer_id' | 'stored_status'> & Record<string, unknown>>(
    rpc('get_checkout_quote', { quote_id: quotes[0] }, buyer.token),
  );
  const detail = await toolData<Row & Record<string, unknown>>(session.client, 'get_admin_checkout_quote', {
    quote_id: quotes[0],
  });
  const customerId = await checked<string>(rpc('current_customer_id', {}, buyer.token));
  expect(detail).toEqual({ ...original, customer_id: customerId, stored_status: 'open' });
  expect(detail.customer_id).not.toBe(buyer.userId);
  expect((await rpc('get_admin_checkout_quote', { quote_id: quotes[0] }, buyer.token)).data).toMatchObject({
    code: '42501',
  });
  expect(
    (await rpc('list_admin_checkout_quotes', { customer_id_filter: customerId }, buyer.token)).data,
  ).toMatchObject({ code: '42501' });
  expect(detail).toMatchObject({
    status: 'open',
    is_reserved: true,
    customer_note: 'PRIVATE NOTE',
    total: 12.35,
  });
  const filters = { customer_id_filter: detail.customer_id, has_order: false, status_filter: 'open' };
  const first = await toolData<Page>(session.client, 'list_admin_checkout_quotes', {
    ...filters,
    page_size: 2,
  });
  const sorted = [...quotes].sort();
  expect(first.items.map((x) => x.id)).toEqual(sorted.slice(0, 2));
  expect(first.next_cursor).toBe(sorted[1]);
  expect(Object.keys(first.items[0]).sort()).toEqual(
    [
      'id',
      'customer_id',
      'order_id',
      'stored_status',
      'status',
      'is_reserved',
      'currency',
      'total',
      'expires_at',
      'created_at',
      'updated_at',
    ].sort(),
  );
  expect(JSON.stringify(first)).not.toContain('PRIVATE NOTE');
  const last = await toolData<Page>(session.client, 'list_admin_checkout_quotes', {
    ...filters,
    page_size: 2,
    after_id: first.next_cursor,
  });
  expect(last.items.map((x) => x.id)).toEqual(sorted.slice(2));
  expect(last.next_cursor).toBeNull();
  const order = await checked<{ id: string }>(
    rpc('create_order_from_quote', { quote_id: quotes[0] }, buyer.token),
  );
  const linked = await toolData<Page>(session.client, 'list_admin_checkout_quotes', {
    customer_id_filter: detail.customer_id,
    has_order: true,
    status_filter: 'converted',
  });
  expect(linked.items).toHaveLength(1);
  expect(linked.items[0]).toMatchObject({
    id: quotes[0],
    order_id: order.id,
    stored_status: 'converted',
    status: 'converted',
    is_reserved: true,
  });
  expect(
    (await toolData<Page>(session.client, 'list_admin_checkout_quotes', { ...filters, has_order: true }))
      .items,
  ).toEqual([]);
  await checked(rpc('cancel_order', { order_id: order.id }, admin.token));
  expect(
    await toolData<Row>(session.client, 'get_admin_checkout_quote', { quote_id: quotes[0] }),
  ).toMatchObject({ stored_status: 'cancelled', status: 'cancelled', is_reserved: false });
  expect(
    await toolData(session.client, 'get_admin_checkout_quote', { quote_id: crypto.randomUUID() }),
  ).toBeNull();
});

test('零元订单已完成报价不再表示预留，详情与列表一致', async () => {
  const p = await stockedProduct(admin, { price: 0, trackInventory: false, cleanup });
  const order = await fixtureOrder(p, buyer);
  const quote = await checked<{ id: string }>(
    rpc('get_order_checkout_quote', { order_id: order.id }, buyer.token),
  );
  const detail = await toolData<Row>(session.client, 'get_admin_checkout_quote', { quote_id: quote.id });
  expect(detail).toMatchObject({
    stored_status: 'completed',
    status: 'completed',
    is_reserved: false,
    order_id: order.id,
  });
  const page = await toolData<Page>(session.client, 'list_admin_checkout_quotes', {
    customer_id_filter: detail.customer_id,
    status_filter: 'completed',
    has_order: true,
  });
  expect(page.items.map((x) => x.id)).toEqual([quote.id]);
});

test('有效过期在精确边界切换，不等待 Worker，也不修改存储状态', async () => {
  await withRollback(db, async (sql) => {
    const customer = crypto.randomUUID();
    await sql`insert into public.customers(id,full_name) values (${customer}::uuid,'quote boundary')`;
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    for (let i = 0; i < ids.length; i++) {
      await sql`insert into commerce.checkout_quotes(id,customer_id,idempotency_key,request_hash,pricing_hash,
        currency,subtotal,total,shipping_address,created_at,expires_at)
        values (${ids[i]}::uuid,${customer}::uuid,${ids[i]},${'a'.repeat(64)},${'b'.repeat(64)},
          'USD',0,0,'{}',now()-interval '5 minutes',now()+(${i - 1} * interval '1 microsecond'))`;
    }
    await sql`select set_config('request.jwt.claims',${JSON.stringify({ sub: admin.userId, role: 'authenticated' })},true)`;
    await sql`set local role authenticated`;
    const page = (
      await sql`select public.list_admin_checkout_quotes(customer_id_filter=>${customer}::uuid,status_filter=>'expired') dto`
    )[0].dto as Page;
    expect(page.items.map((x) => x.id).sort()).toEqual(ids.slice(0, 2).sort());
    for (const id of ids.slice(0, 2)) {
      const detail = (await sql`select public.get_admin_checkout_quote(${id}::uuid) dto`)[0].dto;
      expect(detail).toMatchObject({ stored_status: 'open', status: 'expired', is_reserved: false });
    }
    const live = (await sql`select public.get_admin_checkout_quote(${ids[2]}::uuid) dto`)[0].dto;
    expect(live).toMatchObject({ stored_status: 'open', status: 'open', is_reserved: true });
    await sql`reset role`;
    expect(
      (
        await sql`select distinct status from commerce.checkout_quotes where customer_id=${customer}::uuid`
      ).map((x: { status: string }) => x.status),
    ).toEqual(['open']);
  });
});

test('RPC 自身拒绝匿名和客户；无效筛选不能退化为全店读取', async () => {
  for (const token of [undefined, buyer.token]) {
    for (const [name, args] of [
      ['get_admin_checkout_quote', { quote_id: crypto.randomUUID() }],
      ['list_admin_checkout_quotes', {}],
    ] as const) {
      expect((await rpc(name, args, token)).status).toBeGreaterThanOrEqual(400);
    }
  }
  for (const args of [
    { page_size: 0 },
    { page_size: 101 },
    { page_size: null },
    { status_filter: '' },
    { status_filter: 'paid' },
  ]) {
    expect((await rpc('list_admin_checkout_quotes', args, admin.token)).data).toMatchObject({
      code: '22023',
    });
  }
  expect(
    await toolData<Page>(session.client, 'list_admin_checkout_quotes', {
      customer_id_filter: crypto.randomUUID(),
    }),
  ).toEqual({ items: [], next_cursor: null });
});
