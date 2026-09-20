import { afterAll, beforeAll, expect, test } from 'bun:test';
import { AdminBackend } from '../mcp/src/backend';
import { API, ANON_KEY, api, checked, rpc, signup, makeAdmin, TEST_ADDRESS, type TestUser } from './helpers';
import { mcpSession, toolData } from './support/mcp';
import { Cleanup } from './support/cleanup';
import { stockedProduct } from './support/catalog';
import { disablePromotion } from './support/promotions';
import { heldTransactionRace, staleAfterCommit, testDatabase } from './database-concurrency';

interface Promotion {
  id: string;
  revision: number;
  is_active: boolean;
  used_count: number;
  params: Record<string, unknown>;
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
const read = (promotion_id: string) =>
  toolData<Promotion>(session.client, 'get_admin_promotion', { promotion_id });
const targets = (promotion_id: string) =>
  toolData<{ items: Record<string, unknown>[]; next_cursor: string | null }>(
    session.client,
    'list_admin_promotion_targets',
    { promotion_id, page_size: 100 },
  );
const edit = (p: Promotion, changes: Record<string, unknown>) =>
  toolData<Promotion>(session.client, 'update_promotion', {
    promotion_id: p.id,
    expected_revision: p.revision,
    changes,
  });
async function create(changes: Record<string, unknown> = {}) {
  const p = await toolData<Promotion>(session.client, 'create_promotion', {
    promotion_id: crypto.randomUUID(),
    changes: { name: 'Test promotion', type: 'free_shipping', params: {}, ...changes },
  });
  cleanup.defer(() => disablePromotion(p.id));
  return p;
}

test('MCP 创建默认停用，UUID 非 upsert；版本化编辑、启停与 nullable 清空', async () => {
  const initial = await create();
  expect(initial).toMatchObject({ is_active: false, revision: 1, used_count: 0 });
  expect(await edit(initial, {})).toEqual(initial);
  const code = `MCP-${crypto.randomUUID()}`;
  const changed = await edit(initial, {
    type: 'order_percentage',
    params: { percent: 17, threshold: 43 },
    code: code.toLowerCase(),
    usage_limit: 9,
    starts_at: '2100-01-01',
    ends_at: '2100-02-01',
    is_active: true,
  });
  expect(changed).toMatchObject({
    code: code.toUpperCase(),
    usage_limit: 9,
    params: { percent: 17, threshold: 43 },
    is_active: true,
  });
  expect(changed.revision).toBeGreaterThan(initial.revision);
  const cleared = await edit(changed, {
    code: null,
    usage_limit: null,
    starts_at: null,
    ends_at: null,
    is_active: false,
  });
  expect(cleared).toMatchObject({
    code: null,
    usage_limit: null,
    starts_at: null,
    ends_at: null,
    is_active: false,
  });
  expect(
    (
      await rpc(
        'create_promotion',
        { promotion_id: initial.id, changes: { name: 'Duplicate', type: 'free_shipping', params: {} } },
        admin.token,
      )
    ).data,
  ).toMatchObject({ code: '23505' });
  expect(await read(initial.id)).toEqual(cleared);
});

test('原子配置买赠两类目标；失败全回滚，清空不扩大，显式恢复 same_as_apply', async () => {
  const a = await stockedProduct(admin, { price: 20, cleanup }),
    b = await stockedProduct(admin, { price: 7, cleanup });
  let p = await create({
    type: 'buy_x_get_y',
    params: { buy: 2, get: 1 },
    is_active: true,
    targets: [
      { role: 'apply', product_id: a.productId },
      { role: 'get', variant_id: b.variantId },
    ],
  });
  expect(p).toMatchObject({ apply_scope: 'selected', get_scope: 'selected' });
  const preview = () =>
    checked<{ discount_total: number }>(
      rpc(
        'price_checkout',
        {
          items: [
            { variant_id: a.variantId, quantity: 3 },
            { variant_id: b.variantId, quantity: 1 },
          ],
          address: TEST_ADDRESS,
        },
        buyer.token,
      ),
    );
  expect((await preview()).discount_total).toBe(7);
  const before = await targets(p.id);
  const failed = await rpc(
    'update_promotion',
    {
      promotion_id: p.id,
      expected_revision: p.revision,
      changes: {
        name: 'Must rollback',
        params: { buy: 1, get: 1 },
        targets: [{ role: 'apply', variant_id: crypto.randomUUID() }],
      },
    },
    admin.token,
  );
  expect(failed.data).toMatchObject({ code: '23503' });
  expect(await read(p.id)).toEqual(p);
  expect(await targets(p.id)).toEqual(before);
  p = await edit(p, { targets: [{ role: 'apply', product_id: a.productId }] });
  expect(p).toMatchObject({ get_scope: 'selected' });
  expect((await preview()).discount_total).toBe(0);
  p = await edit(p, { get_scope: 'same_as_apply' });
  expect((await preview()).discount_total).toBe(20);
  p = await edit(p, { targets: [] });
  expect(p).toMatchObject({ apply_scope: 'selected' });
  expect((await preview()).discount_total).toBe(0);
  p = await edit(p, { apply_scope: 'all' });
  expect((await preview()).discount_total).toBe(7);
  await edit(p, { is_active: false });
});

test('旧表/目标写入推进不可伪造版本；并发编辑只成功一个，RR 旧快照不能漏目标', async () => {
  const product = await stockedProduct(admin, { onHand: 0, cleanup });
  const p = await create({ type: 'item_percentage', params: { percent: 10 } });
  await checked(
    api(`/rest/v1/promotions?id=eq.${p.id}`, {
      token: admin.token,
      method: 'PATCH',
      body: { name: 'Legacy', revision: 1 },
    }),
  );
  const direct = await read(p.id);
  expect(direct.revision).toBeGreaterThan(p.revision);
  await checked(
    api('/rest/v1/promotion_targets', {
      token: admin.token,
      method: 'POST',
      body: { promotion_id: p.id, product_id: product.productId },
    }),
  );
  const withTarget = await read(p.id);
  expect(withTarget.revision).toBeGreaterThan(direct.revision);
  expect(
    (
      await rpc(
        'update_promotion',
        { promotion_id: p.id, expected_revision: direct.revision, changes: { targets: [] } },
        admin.token,
      )
    ).data,
  ).toMatchObject({ code: 'PT409' });
  const results = await Promise.all(
    ['One', 'Two'].map((name) =>
      rpc(
        'update_promotion',
        { promotion_id: p.id, expected_revision: withTarget.revision, changes: { name } },
        admin.token,
      ),
    ),
  );
  expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  expect(['PT409', '55P03']).toContain(
    (results.find((r) => r.status !== 200)!.data as { code: string }).code,
  );
  const current = await read(p.id);
  const stale = await staleAfterCommit(
    db,
    async (sql) => {
      await sql`select set_config('request.jwt.claims',${JSON.stringify({ sub: admin.userId, role: 'authenticated' })},true)`;
      await sql`select public.update_promotion(${p.id}::uuid,${current.revision}::integer,'{"targets":[]}'::jsonb)`;
    },
    async () => {
      await checked(
        api('/rest/v1/promotion_targets', {
          token: admin.token,
          method: 'POST',
          body: { promotion_id: p.id, variant_id: product.variantId },
        }),
      );
    },
  );
  expect(stale.error?.errno).toBe('40001');
  expect((await targets(p.id)).items).toHaveLength(2);
});

test('促销并发编辑使旧报价转单回滚；新单使用新规则，用量推进版本并保护已占用名额', async () => {
  const product = await stockedProduct(admin, { cleanup });
  const code = `EDIT-${crypto.randomUUID()}`.toUpperCase();
  const p = await create({
    code,
    type: 'order_fixed',
    params: { amount: 3 },
    is_active: true,
    per_customer_limit: 3,
    usage_limit: 3,
  });
  let edited!: Promotion;
  const orderArgs = {
    items: [{ variant_id: product.variantId, quantity: 1 }],
    discount_code: code,
    address: TEST_ADDRESS,
    idempotency_key: crypto.randomUUID(),
  };
  const rejected = await heldTransactionRace(
    db,
    async (sql) => {
      await sql`select set_config('request.jwt.claims',${JSON.stringify({ sub: admin.userId, role: 'authenticated' })},true)`;
      edited = (
        await sql`select public.update_promotion(${p.id}::uuid,${p.revision}::integer,'{"params":{"amount":5}}'::jsonb) dto`
      )[0].dto;
      expect((await read(p.id)).params).toEqual({ amount: 3 });
    },
    () => rpc('create_order', orderArgs, buyer.token),
  );
  expect(rejected.data).toMatchObject({
    code: 'P0001',
    message: 'checkout quote pricing changed; create a new quote',
  });
  expect((await read(p.id)).used_count).toBe(0);
  // The failed convenience command rolled back its quote, reservation and key.
  const first = await checked<{ id: string; discount_total: number }>(
    rpc('create_order', orderArgs, buyer.token),
  );
  cleanup.defer(() => checked(rpc('cancel_order', { order_id: first.id }, buyer.token)));
  expect(first.discount_total).toBe(5);
  expect((await read(p.id)).revision).toBeGreaterThan(edited.revision);
  expect(
    (
      await rpc(
        'update_promotion',
        { promotion_id: p.id, expected_revision: edited.revision, changes: { name: 'Stale' } },
        admin.token,
      )
    ).data,
  ).toMatchObject({ code: 'PT409' });
  const second = await checked<{ id: string }>(
    rpc(
      'create_order',
      {
        items: [{ variant_id: product.variantId, quantity: 1 }],
        discount_code: code,
        address: TEST_ADDRESS,
        idempotency_key: crypto.randomUUID(),
      },
      buyer.token,
    ),
  );
  cleanup.defer(() => checked(rpc('cancel_order', { order_id: second.id }, buyer.token)));
  const current = await read(p.id);
  expect(current.used_count).toBe(2);
  expect(
    (
      await rpc(
        'update_promotion',
        {
          promotion_id: p.id,
          expected_revision: current.revision,
          changes: { name: 'Rollback', usage_limit: 1 },
        },
        admin.token,
      )
    ).data,
  ).toMatchObject({ code: '23514' });
  expect(await read(p.id)).toEqual(current);
  expect((await edit(current, { is_active: false })).used_count).toBe(2);
});

test('RPC 权限、字段白名单与原子失败创建；目标和规则校验不能绕过 MCP', async () => {
  const p = await create();
  for (const token of [undefined, buyer.token]) {
    expect(
      (
        await rpc(
          'create_promotion',
          {
            promotion_id: crypto.randomUUID(),
            changes: { name: 'Denied', type: 'free_shipping', params: {} },
          },
          token,
        )
      ).data,
    ).toMatchObject({ code: '42501' });
    expect(
      (
        await rpc(
          'update_promotion',
          { promotion_id: p.id, expected_revision: p.revision, changes: {} },
          token,
        )
      ).data,
    ).toMatchObject({ code: '42501' });
  }
  for (const changes of [
    { used_count: 0 },
    { revision: 1 },
    { id: p.id },
    { params: [] },
    { name: null },
    { priority: 0.5 },
    { usage_limit: '3' },
    { is_active: null },
    { type: 'order_fixed' },
    { starts_at: 'infinity' },
    { targets: null },
    { targets: [null] },
    { targets: [{ role: 'apply' }] },
    { targets: [{ role: 'apply', product_id: p.id, variant_id: p.id }] },
    { targets: [{ role: 'apply', product_id: p.id, id: p.id }] },
    { targets: Array.from({ length: 101 }, () => ({ role: 'apply', product_id: p.id })) },
    { targets: [{ role: 'apply', product_id: p.id }], apply_scope: 'all' },
  ])
    expect(
      (
        await rpc(
          'update_promotion',
          { promotion_id: p.id, expected_revision: p.revision, changes },
          admin.token,
        )
      ).data,
    ).toMatchObject({ code: '22023' });
  expect(await read(p.id)).toEqual(p);
  const id = crypto.randomUUID();
  expect(
    (
      await rpc(
        'create_promotion',
        {
          promotion_id: id,
          changes: {
            name: 'Rollback',
            type: 'item_percentage',
            params: { percent: 15 },
            is_active: true,
            targets: [{ role: 'apply', product_id: crypto.randomUUID() }],
          },
        },
        admin.token,
      )
    ).data,
  ).toMatchObject({ code: '23503' });
  expect(await read(id)).toBeNull();
  expect(
    (await rpc('update_promotion', { promotion_id: id, expected_revision: 1, changes: {} }, admin.token))
      .data,
  ).toMatchObject({ code: 'PT404' });
});
