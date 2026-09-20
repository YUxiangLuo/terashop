import { afterAll, beforeAll, expect, test } from 'bun:test';
import { AdminBackend } from '../mcp/src/backend';
import { API, ANON_KEY, api, checked, rpc, signup, makeAdmin, TEST_ADDRESS, type TestUser } from './helpers';
import { mcpSession, toolData } from './support/mcp';
import { Cleanup } from './support/cleanup';
import { stockedProduct } from './support/catalog';
import { staleAfterCommit, testDatabase } from './database-concurrency';

interface Tax {
  id: string;
  revision: number;
  rate: number;
  country: string;
  is_active: boolean;
  include_shipping: boolean;
}
const cleanup = new Cleanup(),
  db = testDatabase();
let admin: TestUser, buyer: TestUser, session: Awaited<ReturnType<typeof mcpSession>>;
beforeAll(async () => {
  admin = await signup();
  buyer = await signup();
  await makeAdmin(admin.userId);
  session = await mcpSession(
    new AdminBackend({ url: API, anonKey: ANON_KEY, accessToken: admin.token }),
    true,
  );
});
afterAll(async () => {
  try {
    await cleanup.run();
  } finally {
    await session?.close();
    await db.close();
  }
});
const read = (tax_rate_id: string) => toolData<Tax>(session.client, 'get_admin_tax_rate', { tax_rate_id });
const edit = (t: Tax, changes: Record<string, unknown>) =>
  toolData<Tax>(session.client, 'update_tax_rate', {
    tax_rate_id: t.id,
    expected_revision: t.revision,
    changes,
  });
async function create(changes: Record<string, unknown> = {}, id: string = crypto.randomUUID()) {
  const t = await toolData<Tax>(session.client, 'create_tax_rate', {
    tax_rate_id: id,
    changes: { name: 'Fictional tax', country: 'ZZ', rate: 0.1375, ...changes },
  });
  cleanup.defer(() =>
    checked(
      api(`/rest/v1/tax_rates?id=eq.${t.id}`, { service: true, method: 'PATCH', body: { is_active: false } }),
    ),
  );
  return t;
}

test('MCP 税率默认停用；规范化、精确小数、无变化和非 upsert', async () => {
  const t = await create({ country: ' jp ' });
  expect(t).toMatchObject({ country: 'JP', rate: 0.1375, is_active: false, include_shipping: false });
  expect(await edit(t, {})).toEqual(t);
  expect(await edit(t, { country: ' jp ', rate: 0.1375 })).toEqual(t);
  const zero = await edit(t, { rate: 0, include_shipping: true });
  expect(zero).toMatchObject({ rate: 0, include_shipping: true, country: 'JP' });
  expect(zero.revision).toBe(t.revision + 1);
  expect((await edit(zero, { rate: 1 })).rate).toBe(1);
  expect(
    (
      await rpc(
        'create_tax_rate',
        { tax_rate_id: t.id, changes: { name: 'Duplicate', country: '*', rate: 0.1 } },
        admin.token,
      )
    ).data,
  ).toMatchObject({ code: '23505' });
  expect(await read(crypto.randomUUID())).toBeNull();
});

test('列表 UUID 分页、字面搜索；国家精确匹配不混入兜底', async () => {
  const prefix = crypto.randomUUID(),
    ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()].sort();
  await create({ name: `${prefix}%_A`, country: 'JP' }, ids[0]);
  await create({ name: `${prefix}%_B`, country: '*' }, ids[1]);
  await create({ name: `${prefix}XXC`, country: 'JP' }, ids[2]);
  const list = (args: object = {}) =>
    toolData<{ items: Tax[]; next_cursor: string | null }>(session.client, 'list_admin_tax_rates', {
      search: prefix,
      ...args,
    });
  const first = await list({ page_size: 1 });
  expect(first.items.map((t) => t.id)).toEqual([ids[0]]);
  expect(first.next_cursor).toBe(ids[0]);
  const rest = await list({ after_id: first.next_cursor });
  expect(rest.items.map((t) => t.id)).toEqual(ids.slice(1));
  expect(rest.next_cursor).toBeNull();
  expect((await list({ search: `${prefix}%_`, country: ' jp ' })).items.map((t) => t.id)).toEqual([ids[0]]);
  expect((await list({ country: '*' })).items.map((t) => t.id)).toEqual([ids[1]]);
  expect((await list({ active: true })).items).toEqual([]);
});

test('旧入口推进版本，陈旧编辑及 RR 快照拒绝；并发启用同国仅一个成功', async () => {
  const t = await create();
  await checked(
    api(`/rest/v1/tax_rates?id=eq.${t.id}`, {
      token: admin.token,
      method: 'PATCH',
      body: { name: 'Legacy edit', revision: 999 },
    }),
  );
  const current = await read(t.id);
  expect(current.revision).toBe(t.revision + 1);
  expect(
    (
      await rpc(
        'update_tax_rate',
        { tax_rate_id: t.id, expected_revision: t.revision, changes: { rate: 0.2 } },
        admin.token,
      )
    ).data,
  ).toMatchObject({ code: 'PT409' });
  const stale = await staleAfterCommit(
    db,
    async (sql) => {
      await sql`select set_config('request.jwt.claims',${JSON.stringify({ sub: admin.userId, role: 'authenticated' })},true)`;
      await sql`select public.update_tax_rate(${t.id}::uuid,${current.revision}::integer,'{"rate":0.4}'::jsonb)`;
    },
    () => edit(current, { rate: 0.2 }),
  );
  expect(stale.error?.errno).toBe('40001');
  expect((await read(t.id)).rate).toBe(0.2);
  const a = await create({ country: 'QX' }),
    b = await create({ country: 'QX' });
  const results = await Promise.all(
    [a, b].map((tax) =>
      rpc(
        'update_tax_rate',
        { tax_rate_id: tax.id, expected_revision: tax.revision, changes: { is_active: true } },
        admin.token,
      ),
    ),
  );
  expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  expect(results.find((r) => r.status !== 200)!.data).toMatchObject({ code: '23505' });
  const loser = results[0].status === 200 ? b : a;
  expect(await read(loser.id)).toEqual(loser);
});

test('RPC 权限、字段白名单与精度校验不可绕过；失败创建回滚', async () => {
  const t = await create();
  for (const token of [undefined, buyer.token]) {
    for (const [name, args] of [
      ['get_admin_tax_rate', { tax_rate_id: t.id }],
      ['list_admin_tax_rates', {}],
      [
        'create_tax_rate',
        { tax_rate_id: crypto.randomUUID(), changes: { name: 'Denied', country: 'JP', rate: 0 } },
      ],
      ['update_tax_rate', { tax_rate_id: t.id, expected_revision: t.revision, changes: {} }],
    ] as const)
      expect((await rpc(name, args, token)).data).toMatchObject({ code: '42501' });
  }
  for (const changes of [
    { revision: 1 },
    { country: null },
    { country: 'USA' },
    { name: ' ' },
    { rate: '0.1' },
    { rate: null },
    { rate: -0.0001 },
    { rate: 1.0001 },
    { rate: 0.12345 },
    { include_shipping: null },
  ]) {
    expect(
      (
        await rpc(
          'update_tax_rate',
          { tax_rate_id: t.id, expected_revision: t.revision, changes },
          admin.token,
        )
      ).data,
    ).toMatchObject({ code: '22023' });
    expect(await read(t.id)).toEqual(t);
  }
  for (const changes of [
    { name: 'Missing country', rate: 0.1 },
    { name: 'Bad precision', country: '*', rate: 0.12345 },
  ]) {
    const id = crypto.randomUUID();
    expect((await rpc('create_tax_rate', { tax_rate_id: id, changes }, admin.token)).data).toMatchObject({
      code: '22023',
    });
    expect(await read(id)).toBeNull();
  }
});

test('国家优先而非叠加；零税率与停用不同，运费计税及报价/订单快照', async () => {
  const product = await stockedProduct(admin, { price: 11.25, cleanup });
  const fallback = await create({ country: '*', rate: 0.07, is_active: true });
  let specific = await create({ country: 'AQ', rate: 0.13, is_active: true });
  const shipping = await toolData<{ id: string }>(session.client, 'create_shipping_method', {
    shipping_method_id: crypto.randomUUID(),
    changes: { name: 'Tax fixture', price: 4.01, is_active: true },
  });
  cleanup.defer(() =>
    checked(
      api(`/rest/v1/shipping_methods?id=eq.${shipping.id}`, {
        service: true,
        method: 'PATCH',
        body: { is_active: false },
      }),
    ),
  );
  const args = {
    items: [{ variant_id: product.variantId, quantity: 2 }],
    address: { ...TEST_ADDRESS, country: 'AQ' },
    shipping_method_id: shipping.id,
  };
  interface Price {
    tax_total: number;
    tax_context: { status: string; rule: { tax_rate_id: string } | null };
  }
  const preview = () => checked<Price>(rpc('price_checkout', args, buyer.token));
  expect(await preview()).toMatchObject({
    tax_total: 2.93,
    tax_context: { rule: { tax_rate_id: specific.id } },
  });
  specific = await edit(specific, { include_shipping: true });
  expect((await preview()).tax_total).toBe(3.45); // (22.50 + 4.01) × 0.13, rounded once.
  const order = await checked<{ id: string }>(
    rpc('create_order', { ...args, idempotency_key: crypto.randomUUID() }, buyer.token),
  );
  cleanup.defer(() => checked(rpc('cancel_order', { order_id: order.id }, buyer.token)));
  const quote = await checked<{ id: string }>(
    rpc('create_checkout_quote', { ...args, idempotency_key: crypto.randomUUID() }, buyer.token),
  );
  cleanup.defer(() => checked(rpc('cancel_checkout_quote', { quote_id: quote.id }, buyer.token)));
  const snapshot = await checked<Record<string, unknown>>(
    rpc('get_order_pricing', { order_id: order.id }, buyer.token),
  );
  specific = await edit(specific, { rate: 0 });
  expect(await preview()).toMatchObject({
    tax_total: 0,
    tax_context: { status: 'calculated', rule: { tax_rate_id: specific.id } },
  });
  expect((await rpc('create_order_from_quote', { quote_id: quote.id }, buyer.token)).data).toMatchObject({
    code: 'P0001',
    message: 'checkout quote pricing changed; create a new quote',
  });
  specific = await edit(specific, { is_active: false });
  expect(await preview()).toMatchObject({
    tax_total: 1.58,
    tax_context: { rule: { tax_rate_id: fallback.id } },
  });
  await edit(fallback, { is_active: false });
  expect(await preview()).toMatchObject({ tax_total: 0, tax_context: { status: 'no_rule', rule: null } });
  expect(
    await checked<Record<string, unknown>>(rpc('get_order_pricing', { order_id: order.id }, buyer.token)),
  ).toEqual(snapshot);
});
