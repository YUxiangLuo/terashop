import { afterAll, beforeAll, expect, test } from 'bun:test';
import { AdminBackend } from '../mcp/src/backend';
import { API, ANON_KEY, checked, rpc, signup, makeAdmin, TEST_ADDRESS, type TestUser } from './helpers';
import { mcpSession, toolData } from './support/mcp';
import { stockedProduct } from './support/catalog';
import { Cleanup } from './support/cleanup';
import { testDatabase } from './database-concurrency';
import { withRollback } from '../scripts/lib/transactions';
import { fixtureOrder, fixtureIntent, settleIntent } from './payment-fixtures';

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
    await sql`update commerce.checkout_quotes set status='expired',cancel_reason='worker expiry' where id=${ids[1]}::uuid`;
    await sql`set local role authenticated`;
    const expired = (await sql`select public.cancel_checkout_quote(${ids[1]}::uuid,'replacement') dto`)[0]
      .dto;
    expect(expired).toMatchObject({ status: 'expired', cancel_reason: 'worker expiry', is_reserved: false });
    // A time-expired quote still stored open is cancelled, not a terminal-state replay.
    const cancelled = (await sql`select public.cancel_checkout_quote(${ids[0]}::uuid) dto`)[0].dto;
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      cancel_reason: 'checkout cancelled',
      is_reserved: false,
    });
  });
});

test('MCP 取消 open/converted 报价仅释放预占，重复取消保留原原因，写开关与身份不旁路', async () => {
  const p = await stockedProduct(admin, { price: 8.25, onHand: 9, cleanup });
  const write = await mcpSession(
    new AdminBackend({ url: API, anonKey: ANON_KEY, accessToken: admin.token }),
    true,
  );
  const customer = await mcpSession(
    new AdminBackend({ url: API, anonKey: ANON_KEY, accessToken: buyer.token }),
    true,
  );
  try {
    for (const converted of [false, true]) {
      const q = await checked<{ id: string }>(
        rpc(
          'create_checkout_quote',
          {
            items: [{ variant_id: p.variantId, quantity: 2 }],
            address: TEST_ADDRESS,
            idempotency_key: crypto.randomUUID(),
          },
          buyer.token,
        ),
      );
      cleanup.defer(() => checked(rpc('cancel_checkout_quote', { quote_id: q.id }, admin.token)));
      const args = { quote_id: q.id, reason: converted ? '😀'.repeat(500) : 'Customer requested cancellation' };
      await expect(
        session.client.callTool({ name: 'cancel_checkout_quote', arguments: args }),
      ).rejects.toThrow('Tool cancel_checkout_quote not found');
      const denied = await customer.client.callTool({ name: 'cancel_checkout_quote', arguments: args });
      expect(denied.isError).toBe(true);
      expect(JSON.stringify(denied)).toContain('ADMIN_REQUIRED');
      const stranger = await signup();
      expect((await rpc('cancel_checkout_quote', args, stranger.token)).status).toBeGreaterThanOrEqual(400);
      expect(
        await toolData(session.client, 'get_inventory_availability', { variant_id: p.variantId }),
      ).toMatchObject({ on_hand: 9, reserved: 2, available: 7 });
      // Convert AFTER the operator has seen an unconverted quote: cancellation still includes the order.
      expect(await toolData(session.client, 'get_admin_checkout_quote', { quote_id: q.id })).toMatchObject({
        order_id: null,
      });
      const order = converted
        ? await checked<{ id: string }>(rpc('create_order_from_quote', { quote_id: q.id }, buyer.token))
        : null;
      const result = await toolData<Record<string, unknown>>(write.client, 'cancel_checkout_quote', args);
      expect(result).toMatchObject({
        id: q.id,
        status: 'cancelled',
        is_reserved: false,
        cancel_reason: args.reason,
        order_id: order?.id ?? null,
      });
      expect(result).not.toHaveProperty('customer_id');
      expect(result).not.toHaveProperty('stored_status');
      expect(
        await toolData<typeof result>(write.client, 'cancel_checkout_quote', {
          ...args,
          reason: 'replacement',
        }),
      ).toEqual(result);
      expect(
        await toolData(session.client, 'get_inventory_availability', { variant_id: p.variantId }),
      ).toMatchObject({ on_hand: 9, reserved: 0, available: 9 });
      if (order) {
        expect(await toolData(session.client, 'get_admin_order', { order_id: order.id })).toMatchObject({
          status: 'cancelled',
        });
        expect(await toolData(session.client, 'get_order_ledger', { order_id: order.id })).toMatchObject({
          transactions: [],
        });
      }
    }
    expect(
      (
        await write.client.callTool({
          name: 'cancel_checkout_quote',
          arguments: { quote_id: crypto.randomUUID() },
        })
      ).isError,
    ).toBe(true);
  } finally {
    await customer.close();
    await write.close();
  }
});

test('MCP 取消与 Capture 准备竞争，未知 Capture 及完成后不允许取消', async () => {
  const p = await stockedProduct(admin, { price: 7.25, onHand: 9, cleanup });
  const write = await mcpSession(
    new AdminBackend({ url: API, anonKey: ANON_KEY, accessToken: admin.token }),
    true,
  );
  try {
    for (const race of [false, true]) {
      const order = await fixtureOrder(p, buyer);
      const intent = await fixtureIntent(order, buyer);
      const prepare = () =>
        rpc(
          'prepare_paypal_capture',
          { payment_intent_id: intent.id, actor_id: buyer.userId },
          undefined,
          true,
        );
      const cancel = () =>
        write.client.callTool({ name: 'cancel_checkout_quote', arguments: { quote_id: order.quoteId } });
      const [prepared, cancelled] = race
        ? await Promise.all([prepare(), cancel()])
        : [await prepare(), await cancel()];
      expect(Number(prepared.status === 200) + Number(!cancelled.isError)).toBe(1);
      if (prepared.status === 200) {
        expect(cancelled.isError).toBe(true);
        expect(
          await toolData(session.client, 'get_admin_checkout_quote', { quote_id: order.quoteId }),
        ).toMatchObject({ stored_status: 'converted', is_reserved: true });
        // The durable dispatch marker remains even without a provider response.
        expect((await cancel()).isError).toBe(true);
        await settleIntent(intent);
        expect((await cancel()).isError).toBe(true);
        expect(
          await toolData(session.client, 'get_admin_checkout_quote', { quote_id: order.quoteId }),
        ).toMatchObject({ stored_status: 'completed', is_reserved: false });
      } else {
        expect(await toolData(session.client, 'get_admin_order', { order_id: order.id })).toMatchObject({
          status: 'cancelled',
        });
      }
    }
  } finally {
    await write.close();
  }
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
