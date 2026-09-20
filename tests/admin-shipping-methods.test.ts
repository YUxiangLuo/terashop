import { afterAll, beforeAll, expect, test } from 'bun:test';
import { AdminBackend } from '../mcp/src/backend';
import { API, ANON_KEY, api, checked, rpc, signup, makeAdmin, TEST_ADDRESS, type TestUser } from './helpers';
import { mcpSession, toolData } from './support/mcp';
import { Cleanup } from './support/cleanup';
import { stockedProduct } from './support/catalog';
import { disablePromotion } from './support/promotions';
import { staleAfterCommit, testDatabase } from './database-concurrency';

interface Shipping {
  id: string;
  revision: number;
  price: number;
  free_above: number | null;
  countries: string[];
  is_active: boolean;
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
const read = (shipping_method_id: string) =>
  toolData<Shipping>(session.client, 'get_admin_shipping_method', { shipping_method_id });
const edit = (s: Shipping, changes: Record<string, unknown>) =>
  toolData<Shipping>(session.client, 'update_shipping_method', {
    shipping_method_id: s.id,
    expected_revision: s.revision,
    changes,
  });
async function create(changes: Record<string, unknown> = {}, id: string = crypto.randomUUID()) {
  const s = await toolData<Shipping>(session.client, 'create_shipping_method', {
    shipping_method_id: id,
    changes: { name: 'Test shipping', price: 7.25, ...changes },
  });
  cleanup.defer(() =>
    checked(
      api(`/rest/v1/shipping_methods?id=eq.${s.id}`, {
        service: true,
        method: 'PATCH',
        body: { is_active: false },
      }),
    ),
  );
  return s;
}

test('MCP 配送创建默认停用、UUID 非 upsert；省略、清空与零门槛不同', async () => {
  const initial = await create();
  expect(initial).toMatchObject({ is_active: false, price: 7.25, free_above: null, countries: [] });
  expect(await edit(initial, {})).toEqual(initial);
  expect(await edit(initial, { price: 7.25, countries: [] })).toEqual(initial);
  const changed = await edit(initial, { countries: [' jp ', 'ca'], free_above: 0, is_active: true });
  expect(changed).toMatchObject({ countries: ['JP', 'CA'], free_above: 0, is_active: true });
  expect(changed.revision).toBeGreaterThan(initial.revision);
  const preserved = await edit(changed, { description: 'Domestic policy' });
  expect(preserved).toMatchObject({ countries: ['JP', 'CA'], free_above: 0 });
  const cleared = await edit(preserved, { countries: [], free_above: null, is_active: false });
  expect(cleared).toMatchObject({ countries: [], free_above: null, is_active: false });
  expect(
    (
      await rpc(
        'create_shipping_method',
        { shipping_method_id: initial.id, changes: { name: 'Duplicate', price: 1 } },
        admin.token,
      )
    ).data,
  ).toMatchObject({ code: '23505' });
  expect(await read(initial.id)).toEqual(cleared);
  expect(await read(crypto.randomUUID())).toBeNull();
});

test('UUID 分页独立于 display position；字面搜索、国家含无限制范围、筛选 AND', async () => {
  const prefix = crypto.randomUUID(),
    ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()].sort();
  await create({ name: `${prefix}%_A`, position: 30, countries: ['JP'], is_active: true }, ids[0]);
  await create({ name: `${prefix}%_B`, position: 20 }, ids[1]);
  await create({ name: `${prefix}XXC`, position: 10, countries: ['CA'], is_active: true }, ids[2]);
  const list = (args: object = {}) =>
    toolData<{ items: Shipping[]; next_cursor: string | null }>(
      session.client,
      'list_admin_shipping_methods',
      { search: prefix, ...args },
    );
  const first = await list({ page_size: 1 });
  expect(first.items.map((s) => s.id)).toEqual([ids[0]]);
  expect(first.next_cursor).toBe(ids[0]);
  const rest = await list({ after_id: first.next_cursor });
  expect(rest.items.map((s) => s.id)).toEqual(ids.slice(1));
  expect(rest.next_cursor).toBeNull();
  expect((await list({ search: `${prefix}%_` })).items.map((s) => s.id)).toEqual(ids.slice(0, 2));
  expect((await list({ country: ' jp ' })).items.map((s) => s.id)).toEqual(ids.slice(0, 2));
  expect((await list({ country: 'JP', active: false })).items.map((s) => s.id)).toEqual([ids[1]]);
});

test('旧表写入推进 revision；同版本竞争及 RR 旧快照不能覆盖新配置', async () => {
  const s = await create();
  await checked(
    api(`/rest/v1/shipping_methods?id=eq.${s.id}`, {
      token: admin.token,
      method: 'PATCH',
      body: { name: 'Legacy', revision: 999 },
    }),
  );
  const fresh = await read(s.id);
  expect(fresh.revision).toBe(s.revision + 1);
  expect(
    (
      await rpc(
        'update_shipping_method',
        { shipping_method_id: s.id, expected_revision: s.revision, changes: { price: 2 } },
        admin.token,
      )
    ).data,
  ).toMatchObject({ code: 'PT409' });
  const results = await Promise.all(
    [3.01, 5.02].map((price) =>
      rpc(
        'update_shipping_method',
        { shipping_method_id: s.id, expected_revision: fresh.revision, changes: { price } },
        admin.token,
      ),
    ),
  );
  expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  expect(['PT409', '55P03']).toContain(
    (results.find((r) => r.status !== 200)!.data as { code: string }).code,
  );
  const current = await read(s.id);
  const stale = await staleAfterCommit(
    db,
    async (sql) => {
      await sql`select set_config('request.jwt.claims',${JSON.stringify({ sub: admin.userId, role: 'authenticated' })},true)`;
      await sql`select public.update_shipping_method(${s.id}::uuid,${current.revision}::integer,'{"price":1}'::jsonb)`;
    },
    () => edit(current, { price: 8.03 }),
  );
  expect(stale.error?.errno).toBe('40001');
  expect((await read(s.id)).price).toBe(8.03);
});

test('RPC 权限及严格字段/金额校验；失败创建无残留', async () => {
  const s = await create();
  for (const token of [undefined, buyer.token]) {
    for (const [name, args] of [
      ['get_admin_shipping_method', { shipping_method_id: s.id }],
      ['list_admin_shipping_methods', {}],
      [
        'create_shipping_method',
        { shipping_method_id: crypto.randomUUID(), changes: { name: 'Denied', price: 2 } },
      ],
      ['update_shipping_method', { shipping_method_id: s.id, expected_revision: s.revision, changes: {} }],
    ] as const)
      expect((await rpc(name, args, token)).data).toMatchObject({ code: '42501' });
  }
  for (const changes of [
    { revision: 1 },
    { id: s.id },
    { name: null },
    { name: '  ' },
    { countries: null },
    { countries: [1] },
    { countries: ['USA'] },
    { countries: ['*'] },
    { price: '2' },
    { price: -0.01 },
    { price: 1.005 },
    { price: 10000000000 },
    { free_above: -0.01 },
    { free_above: 2.001 },
    { position: 0.5 },
    { is_active: null },
  ]) {
    const failed = await rpc(
      'update_shipping_method',
      { shipping_method_id: s.id, expected_revision: s.revision, changes },
      admin.token,
    );
    expect(failed.data).toMatchObject({ code: '22023' });
    expect(await read(s.id)).toEqual(s);
  }
  const missing = crypto.randomUUID();
  expect(
    (
      await rpc(
        'create_shipping_method',
        { shipping_method_id: missing, changes: { name: 'Rollback', price: 2.001 } },
        admin.token,
      )
    ).data,
  ).toMatchObject({ code: '22023' });
  expect(await read(missing)).toBeNull();
  expect((await edit(s, { price: 9999999999.99 })).price).toBe(9999999999.99);
});

test('免运费使用折后商品总额含等号；配置变更使旧报价失效但不重写订单金额', async () => {
  const product = await stockedProduct(admin, { price: 11.25, cleanup });
  const code = `SHIP-${crypto.randomUUID()}`;
  const promotion = await toolData<{ id: string }>(session.client, 'create_promotion', {
    promotion_id: crypto.randomUUID(),
    changes: {
      name: 'Shipping threshold test',
      type: 'order_fixed',
      params: { amount: 3.01 },
      code,
      is_active: true,
      per_customer_limit: 3,
    },
  });
  cleanup.defer(() => disablePromotion(promotion.id));
  let s = await create({ price: 4.01, free_above: 19.5, countries: ['AQ'], is_active: true });
  const args = {
    items: [{ variant_id: product.variantId, quantity: 2 }],
    address: { ...TEST_ADDRESS, country: 'AQ' },
    shipping_method_id: s.id,
    discount_code: code,
  };
  const preview = (overrides: object = {}) =>
    checked<{ subtotal: number; discount_total: number; shipping_total: number }>(
      rpc('price_checkout', { ...args, ...overrides }, buyer.token),
    );
  expect(await preview()).toMatchObject({ subtotal: 22.5, discount_total: 3.01, shipping_total: 4.01 });
  expect((await preview({ discount_code: null })).shipping_total).toBe(0);
  s = await edit(s, { free_above: 19.49 });
  expect((await preview()).shipping_total).toBe(0);
  s = await edit(s, { free_above: 19.5 });
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
  s = await edit(s, { price: 6.11, free_above: null, name: 'New pricing' });
  expect((await preview()).shipping_total).toBe(6.11);
  expect((await rpc('create_order_from_quote', { quote_id: quote.id }, buyer.token)).data).toMatchObject({
    code: 'P0001',
    message: 'checkout quote pricing changed; create a new quote',
  });
  expect(
    await checked<Record<string, unknown>>(rpc('get_order_pricing', { order_id: order.id }, buyer.token)),
  ).toEqual(snapshot);
  s = await edit(s, { countries: ['JP'] });
  expect((await rpc('price_checkout', args, buyer.token)).data).toMatchObject({
    code: 'P0001',
    message: 'shipping method not available for this country',
  });
  s = await edit(s, { countries: [] });
  expect((await preview()).shipping_total).toBe(6.11);
  s = await edit(s, { free_above: 0 });
  expect((await preview()).shipping_total).toBe(0);
  s = await edit(s, { is_active: false });
  expect((await rpc('price_checkout', args, buyer.token)).data).toMatchObject({
    code: 'P0001',
    message: 'shipping method not available',
  });
});
