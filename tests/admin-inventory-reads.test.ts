import { afterAll, beforeAll, expect, test } from 'bun:test';
import { AdminBackend } from '../mcp/src/backend';
import { API, ANON_KEY, api, checked, rpc, signup, makeAdmin, type TestUser } from './helpers';
import { mcpSession, toolData } from './support/mcp';
import { Cleanup } from './support/cleanup';
import { stockedProduct } from './support/catalog';
import { testDatabase } from './database-concurrency';
import { withRollback } from '../scripts/lib/transactions';

interface Location {
  id: string;
  is_active: boolean;
  is_default: boolean;
  code: string;
}
interface Movement {
  id: string;
  delta: number;
  on_hand_after: number;
  location_id: string;
  reason: string;
}
interface Page<T> {
  items: T[];
  next_cursor: string | null;
}
const db = testDatabase(),
  cleanup = new Cleanup();
let admin: TestUser, buyer: TestUser, session: Awaited<ReturnType<typeof mcpSession>>;
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

test('仓库分页、停用过滤及字面搜索，详情不存在返回 null', async () => {
  const marker = crypto.randomUUID(),
    ids = [crypto.randomUUID(), crypto.randomUUID()].sort();
  for (let i = 0; i < 2; i++) {
    await checked(
      api('/rest/v1/locations', {
        service: true,
        method: 'POST',
        body: {
          id: ids[i],
          code: `${marker}-${i}`,
          name: i ? '50%_off' : 'Other',
          is_active: i === 0,
        },
      }),
    );
    cleanup.defer(() =>
      checked(api(`/rest/v1/locations?id=eq.${ids[i]}`, { service: true, method: 'DELETE' })),
    );
  }
  const first = await toolData<Page<Location>>(session.client, 'list_admin_locations', {
    search: marker,
    page_size: 1,
  });
  expect(first.items.map((l) => l.id)).toEqual([ids[0]]);
  expect(first.next_cursor).toBe(ids[0]);
  const second = await toolData<Page<Location>>(session.client, 'list_admin_locations', {
    search: marker,
    after_id: first.next_cursor,
    page_size: 1,
  });
  expect(second.items.map((l) => l.id)).toEqual([ids[1]]);
  expect(second.next_cursor).toBeNull();
  expect(
    (
      await toolData<Page<Location>>(session.client, 'list_admin_locations', {
        search: marker,
        active: false,
      })
    ).items.map((l) => l.id),
  ).toEqual([ids[1]]);
  const literal = await toolData<Page<Location>>(session.client, 'list_admin_locations', { search: '%_' });
  expect(literal.items.some((l) => l.id === ids[0])).toBe(false);
  expect(literal.items.some((l) => l.id === ids[1])).toBe(true);
  expect(await toolData(session.client, 'get_admin_location', { location_id: ids[1] })).toMatchObject({
    id: ids[1],
    is_active: false,
    is_default: false,
  });
  expect(
    await toolData(session.client, 'get_admin_location', { location_id: crypto.randomUUID() }),
  ).toBeNull();
});

test('库存流水按 ID 倒序分页，组合过滤且历史库存不冒充当前可用量', async () => {
  const product = await stockedProduct(admin, { onHand: 13, cleanup });
  for (const delta of [7, -3])
    await checked(
      rpc(
        'adjust_inventory',
        { variant_id: product.variantId, delta, idempotency_key: crypto.randomUUID() },
        admin.token,
      ),
    );
  const args = { variant_id: product.variantId, page_size: 2 };
  const first = await toolData<Page<Movement>>(session.client, 'list_admin_inventory_movements', args);
  expect(first.items.map((m) => [m.delta, m.on_hand_after])).toEqual([
    [-3, 17],
    [7, 20],
  ]);
  expect(first.items.every((m) => typeof m.id === 'string')).toBe(true);
  expect(first.next_cursor).toBe(first.items[1].id);
  const last = await toolData<Page<Movement>>(session.client, 'list_admin_inventory_movements', {
    ...args,
    after_id: first.next_cursor,
  });
  expect(last.items.map((m) => [m.delta, m.on_hand_after])).toEqual([[13, 13]]);
  expect(last.next_cursor).toBeNull();
  const filtered = await toolData<Page<Movement>>(session.client, 'list_admin_inventory_movements', {
    ...args,
    location_id: first.items[0].location_id,
    reason_filter: 'restock',
  });
  expect(filtered.items.map((m) => m.id)).toEqual([last.items[0].id]);
  for (const filter of [{ location_id: crypto.randomUUID() }, { order_id: crypto.randomUUID() }])
    expect(
      await toolData<Page<Movement>>(session.client, 'list_admin_inventory_movements', {
        ...args,
        ...filter,
      }),
    ).toEqual({ items: [], next_cursor: null });
  await withRollback(db, async (sql) => {
    await sql`insert into public.inventory_movements(id,variant_id,location_id,delta,on_hand_after,reason)
      overriding system value values (9007199254740993,${product.variantId}::uuid,${first.items[0].location_id}::uuid,1,18,'adjust'),
      (9007199254740994,${product.variantId}::uuid,${first.items[0].location_id}::uuid,2,20,'adjust')`;
    await sql`select set_config('request.jwt.claims',${JSON.stringify({ sub: admin.userId, role: 'authenticated' })},true)`;
    await sql`set local role authenticated`;
    const page = (
      await sql`select public.list_admin_inventory_movements(page_size=>1,variant_id=>${product.variantId}::uuid) dto`
    )[0].dto;
    expect(page.items[0].id).toBe('9007199254740994');
    expect(page.next_cursor).toBe('9007199254740994');
    const next = (
      await sql`select public.list_admin_inventory_movements(page_size=>1,variant_id=>${product.variantId}::uuid,after_id=>${page.next_cursor}) dto`
    )[0].dto;
    expect(next.items[0].id).toBe('9007199254740993');
  });
});

test('仓库与流水 RPC 拒绝普通用户，校验分页、筛选与 bigint 边界', async () => {
  for (const token of [undefined, buyer.token])
    for (const name of ['get_admin_location', 'list_admin_locations', 'list_admin_inventory_movements'])
      expect(
        (await rpc(name, name === 'get_admin_location' ? { location_id: crypto.randomUUID() } : {}, token))
          .data,
      ).toMatchObject({ code: '42501' });
  for (const args of [
    { page_size: null },
    { page_size: 101 },
    { after_id: '9223372036854775808' },
    { after_id: '0' },
    { after_id: '01' },
    { after_id: '-1' },
    { after_id: '' },
    { reason_filter: 'transfer' },
  ])
    expect((await rpc('list_admin_inventory_movements', args, admin.token)).data).toMatchObject({
      code: '22023',
    });
  for (const args of [{ page_size: 0 }, { page_size: null }, { search: 'x'.repeat(201) }])
    expect((await rpc('list_admin_locations', args, admin.token)).data).toMatchObject({ code: '22023' });
  expect(
    await checked<Page<Movement>>(rpc('list_admin_inventory_movements', { after_id: '1' }, admin.token)),
  ).toEqual({ items: [], next_cursor: null });
  expect(
    (await rpc('list_admin_inventory_movements', { after_id: '9223372036854775807' }, undefined, true))
      .status,
  ).toBe(200);
});
