import { afterAll, beforeAll, expect, test } from 'bun:test';
import { AdminBackend } from '../mcp/src/backend';
import { API, ANON_KEY, api, checked, command, rpc, signup, makeAdmin, type TestUser } from './helpers';
import { mcpSession, toolData } from './support/mcp';
import { stockedProduct, archiveProduct } from './support/catalog';
import { fixtureOrder } from './payment-fixtures';
import { staleAfterCommit, testDatabase } from './database-concurrency';

const db = testDatabase();
let admin: TestUser, buyer: TestUser, product: Awaited<ReturnType<typeof stockedProduct>>;
let session: Awaited<ReturnType<typeof mcpSession>>;
beforeAll(async () => {
  admin = await signup();
  buyer = await signup();
  await makeAdmin(admin.userId);
  product = await stockedProduct(admin, { trackInventory: false });
  session = await mcpSession(
    new AdminBackend({ url: API, anonKey: ANON_KEY, accessToken: admin.token }),
    true,
  );
});
afterAll(async () => {
  try {
    if (product) await archiveProduct(product.productId);
  } finally {
    await session?.close();
    await db.close();
  }
});
const order = () => fixtureOrder(product, buyer);
const write = (id: string, expected_admin_note: string | null, admin_note: string | null) =>
  rpc('update_order_admin_note', { order_id: id, changes: { expected_admin_note, admin_note } }, admin.token);
const row = async (id: string) =>
  (await checked<Record<string, unknown>[]>(api(`/rest/v1/orders?id=eq.${id}`, { service: true })))[0];
interface Page {
  items: Array<{ id: string; actor_id: string | null; type: string }>;
  next_cursor: string | null;
}
const list = (id: string, args: Record<string, unknown> = {}) =>
  toolData<Page>(session.client, 'list_admin_order_events', { order_id: id, ...args });

test('备注原子替换、null/空串区分、相同值不写入；商业快照及客户可见内容不变', async () => {
  const o = await order();
  await checked(
    command(
      'mark_order_paid',
      { order_id: o.id, idempotency_key: crypto.randomUUID(), provider: 'manual' },
      admin.token,
    ),
  );
  const before = await row(o.id);
  const events = await list(o.id);
  const note = '  Internal 🧪\nDo not disclose  ';
  expect(
    await toolData<{ id: string; admin_note: string }>(session.client, 'update_order_admin_note', {
      order_id: o.id,
      changes: { expected_admin_note: null, admin_note: note },
    }),
  ).toEqual({ id: o.id, admin_note: note });
  const after = await row(o.id);
  expect(after).toEqual({ ...before, admin_note: note, updated_at: after.updated_at });
  await checked(write(o.id, note, note));
  expect(await row(o.id)).toEqual(after);
  expect((await write(o.id, null, 'overwrite')).data).toMatchObject({ code: 'PT409' });
  expect(
    await checked<Record<string, unknown>>(rpc('get_customer_order', { order_id: o.id }, buyer.token)),
  ).not.toHaveProperty('admin_note');
  expect(await list(o.id)).toEqual(events);
  const [outbox] =
    await db`select count(*)::integer as n from commerce.outbox_events where aggregate_id=${o.id}::uuid and payload::text like ${`%${note.trim().split('\n')[0]}%`}`;
  expect(outbox.n).toBe(0);
  await checked(write(o.id, note, ''));
  expect((await write(o.id, null, 'wrong null')).data).toMatchObject({ code: 'PT409' });
  await checked(write(o.id, '', null));
  expect((await row(o.id)).admin_note).toBeNull();
  const boundary = '🧪'.repeat(10000);
  await checked(write(o.id, null, boundary));
  expect((await write(o.id, boundary, boundary + 'x')).data).toMatchObject({ code: '22023' });
  await checked(write(o.id, boundary, null));
});

test('旧直写、行锁、RR 旧快照和两个管理请求竞争不能覆盖当前不同备注', async () => {
  const o = await order();
  await checked(
    api(`/rest/v1/orders?id=eq.${o.id}`, { service: true, method: 'PATCH', body: { admin_note: 'legacy' } }),
  );
  expect((await write(o.id, null, 'stale')).data).toMatchObject({ code: 'PT409' });
  await db.begin(async (sql) => {
    await sql`update public.orders set admin_note='held' where id=${o.id}::uuid`;
    expect((await write(o.id, 'legacy', 'competing')).data).toMatchObject({ code: '55P03' });
  });
  const stale = await staleAfterCommit(
    db,
    async (sql) => {
      await sql`select set_config('request.jwt.claims',${JSON.stringify({ sub: admin.userId, role: 'authenticated' })},true)`;
      await sql`select public.update_order_admin_note(${o.id}::uuid,'{"expected_admin_note":"held","admin_note":"stale"}'::jsonb)`;
    },
    () => checked(write(o.id, 'held', 'latest')),
  );
  expect(stale.error?.errno).toBe('40001');
  const results = await Promise.all([write(o.id, 'latest', 'one'), write(o.id, 'latest', 'two')]);
  expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  expect(['PT409', '55P03']).toContain(
    (results.find((r) => r.status !== 200)!.data as { code: string }).code,
  );
  expect((await row(o.id)).admin_note).toBe(
    (results.find((r) => r.status === 200)!.data as { admin_note: string }).admin_note,
  );
});

test('事件大整数游标无精度损失，订单/类型 AND 过滤；未知事件载荷不泄露', async () => {
  const a = await order(),
    b = await order();
  const base = 9007199254740992n + BigInt(crypto.getRandomValues(new Uint32Array(1))[0]) * 10n;
  const ids = [base, base + 1n, base + 2n].map(String);
  for (const [i, id] of ids.entries()) {
    await db`insert into public.order_events(id,order_id,actor_id,type,data) overriding system value values(${id}::bigint,${a.id}::uuid,${i === 1 ? null : admin.userId}::uuid,'custom.test','{"secret":"hidden-payload","email":"private@example.test"}')`;
  }
  await db`insert into public.order_events(id,order_id,type) overriding system value values(${String(base + 3n)}::bigint,${b.id}::uuid,'custom.test'),(${String(base + 4n)}::bigint,${a.id}::uuid,'Custom.Test')`;
  const first = await list(a.id, { page_size: 2, type_filter: 'custom.test' });
  expect(first.items.map((e) => e.id)).toEqual([ids[2], ids[1]]);
  expect(first.next_cursor).toBe(ids[1]);
  expect(first.items[1].actor_id).toBeNull();
  expect(Object.keys(first.items[0]).sort()).toEqual(
    ['id', 'order_id', 'actor_id', 'type', 'created_at'].sort(),
  );
  expect(JSON.stringify(first)).not.toContain('hidden-payload');
  const last = await list(a.id, { page_size: 2, type_filter: 'custom.test', after_id: first.next_cursor });
  expect(last.items.map((e) => e.id)).toEqual([ids[0]]);
  expect(last.next_cursor).toBeNull();
  expect((await list(a.id, { type_filter: 'Custom.Test' })).items.map((e) => e.id)).toEqual([
    String(base + 4n),
  ]);
  expect(await list(crypto.randomUUID())).toEqual({ items: [], next_cursor: null });
});

test('RPC 独立鉴权、严格参数及不存在订单；客户不能使用管理工具', async () => {
  const o = await order();
  for (const token of [undefined, buyer.token]) {
    expect((await rpc('list_admin_order_events', { order_id: o.id }, token)).data).toMatchObject({
      code: '42501',
    });
    expect(
      (
        await rpc(
          'update_order_admin_note',
          { order_id: o.id, changes: { expected_admin_note: null, admin_note: 'x' } },
          token,
        )
      ).data,
    ).toMatchObject({ code: '42501' });
  }
  for (const changes of [
    null,
    [],
    {},
    { admin_note: null },
    { expected_admin_note: null },
    { expected_admin_note: 1, admin_note: null },
    { expected_admin_note: null, admin_note: false },
    { expected_admin_note: null, admin_note: null, status: 'paid' },
  ])
    expect(
      (await rpc('update_order_admin_note', { order_id: o.id, changes }, admin.token)).data,
    ).toMatchObject({ code: '22023' });
  for (const args of [
    { page_size: 0 },
    { page_size: 101 },
    { page_size: null },
    { order_id: null },
    { type_filter: '' },
    ...['0', '01', '-1', '1.5', '9223372036854775808'].map((after_id) => ({ after_id })),
  ])
    expect(
      (await rpc('list_admin_order_events', { order_id: o.id, ...args }, admin.token)).data,
    ).toMatchObject({ code: '22023' });
  expect((await write(crypto.randomUUID(), null, 'x')).data).toMatchObject({ code: 'PT404' });
  expect(
    await checked<{ id: string; admin_note: null }>(
      rpc(
        'update_order_admin_note',
        { order_id: o.id, changes: { expected_admin_note: null, admin_note: null } },
        undefined,
        true,
      ),
    ),
  ).toEqual({ id: o.id, admin_note: null });
  expect(await checked<Page>(rpc('list_admin_order_events', { order_id: o.id }, undefined, true))).toEqual(
    await list(o.id),
  );
});
