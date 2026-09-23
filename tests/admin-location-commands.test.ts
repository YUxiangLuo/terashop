import { afterAll, beforeAll, expect, test } from 'bun:test';
import { AdminBackend } from '../mcp/src/backend';
import { API, ANON_KEY, api, checked, rpc, signup, makeAdmin, type TestUser } from './helpers';
import { mcpSession, toolData } from './support/mcp';
import { Cleanup } from './support/cleanup';
import { testDatabase } from './database-concurrency';
import { withRollback } from '../scripts/lib/transactions';

interface Location {
  id: string;
  code: string;
  name: string;
  revision: number;
  is_active: boolean;
  is_default: boolean;
  address: unknown;
}
const db = testDatabase(),
  cleanup = new Cleanup();
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
const read = (location_id: string) =>
  toolData<Location>(session.client, 'get_admin_location', { location_id });
async function create(changes: Record<string, unknown> = {}) {
  const id = crypto.randomUUID();
  const result = await toolData<Location>(session.client, 'create_location', {
    location_id: id,
    changes: { code: id, name: 'Warehouse', is_active: true, ...changes },
  });
  cleanup.defer(() => checked(api(`/rest/v1/locations?id=eq.${id}`, { service: true, method: 'DELETE' })));
  return result;
}

test('仓库 MCP 创建/编辑/启停及地址清空；旧表写入推进不可伪造版本', async () => {
  const warehouse = await create({ address: { city: 'Tokyo' } });
  expect(warehouse).toMatchObject({ is_active: true, is_default: false, address: { city: 'Tokyo' } });
  const noop = await toolData<Location>(session.client, 'update_location', {
    location_id: warehouse.id,
    expected_revision: warehouse.revision,
    changes: {},
  });
  expect(noop.revision).toBe(warehouse.revision);
  const edited = await toolData<Location>(session.client, 'update_location', {
    location_id: warehouse.id,
    expected_revision: warehouse.revision,
    changes: { address: null, is_active: false, name: 'Edited' },
  });
  expect(edited).toMatchObject({ code: warehouse.code, name: 'Edited', address: null, is_active: false });
  expect(edited.revision).toBeGreaterThan(warehouse.revision);
  await checked(
    api(`/rest/v1/locations?id=eq.${warehouse.id}`, {
      token: admin.token,
      method: 'PATCH',
      body: { name: 'Direct', revision: 1 },
    }),
  );
  const direct = await read(warehouse.id);
  expect(direct.revision).toBeGreaterThan(edited.revision);
  expect(
    (
      await rpc(
        'update_location',
        { location_id: warehouse.id, expected_revision: edited.revision, changes: { name: 'Lost' } },
        admin.token,
      )
    ).data,
  ).toMatchObject({ code: 'PT409' });
  expect(
    await toolData<Location>(session.client, 'update_location', {
      location_id: warehouse.id,
      expected_revision: direct.revision,
      changes: { is_active: true },
    }),
  ).toMatchObject({ is_active: true, is_default: false });
  expect(
    (
      await rpc(
        'create_location',
        { location_id: warehouse.id, changes: { code: warehouse.code, name: 'Duplicate' } },
        admin.token,
      )
    ).data,
  ).toMatchObject({ code: '23505' });
});

test('默认仓原子切换、旧默认校验、并发竞争与停用保护', async () => {
  const [original] = await checked<Location[]>(
    api('/rest/v1/locations?is_active=eq.true&is_default=eq.true', { service: true }),
  );
  const first = await create(),
    second = await create(),
    inactive = await create({ is_active: false });
  try {
    const args = {
      location_id: first.id,
      expected_revision: first.revision,
      expected_default_id: original.id,
    };
    expect(
      (await rpc('set_default_location', { ...args, expected_default_id: crypto.randomUUID() }, admin.token))
        .data,
    ).toMatchObject({ code: 'PT409' });
    expect(
      (
        await rpc(
          'set_default_location',
          { ...args, location_id: inactive.id, expected_revision: inactive.revision },
          admin.token,
        )
      ).data,
    ).toMatchObject({ code: 'PT409' });
    const selected = await toolData<Location>(session.client, 'set_default_location', args);
    expect(selected.is_default).toBe(true);
    expect((await read(original.id)).is_default).toBe(false);
    expect(
      (
        await rpc(
          'update_location',
          {
            location_id: first.id,
            expected_revision: selected.revision,
            changes: { is_active: false, name: 'Must rollback' },
          },
          admin.token,
        )
      ).data,
    ).toMatchObject({ code: 'PT409' });
    expect(await read(first.id)).toEqual(selected);
    const originalNow = await read(original.id);
    const results = await Promise.all(
      [second, originalNow].map((target) =>
        rpc(
          'set_default_location',
          {
            location_id: target.id,
            expected_revision: target.revision,
            expected_default_id: first.id,
          },
          admin.token,
        ),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(['55P03', 'PT409']).toContain(
      (results.find((r) => r.status !== 200)!.data as { code: string }).code,
    );
    const defaults = await checked<Location[]>(
      api('/rest/v1/locations?is_active=eq.true&is_default=eq.true', { service: true }),
    );
    expect(defaults.map((l) => l.id)).toEqual([results[0].status === 200 ? second.id : original.id]);
  } finally {
    await db.begin(async (sql) => {
      await sql`update public.locations set is_default=false where id in (${first.id}::uuid,${second.id}::uuid)`;
      await sql`update public.locations set is_default=true where id=${original.id}::uuid`;
    });
  }
});

test('首次选择默认仓及旧停用默认标记恢复，配置锁拒绝并发旧写路径', async () => {
  const target = await create({ is_active: false });
  await checked(
    api(`/rest/v1/locations?id=eq.${target.id}`, {
      service: true,
      method: 'PATCH',
      body: { is_default: true },
    }),
  );
  const legacy = await read(target.id);
  expect(
    await toolData<Location>(session.client, 'update_location', {
      location_id: target.id,
      expected_revision: legacy.revision,
      changes: { is_active: true },
    }),
  ).toMatchObject({ is_active: true, is_default: false });
  await withRollback(db, async (sql) => {
    await sql`update public.locations set is_default=false where is_default`;
    await sql`select set_config('request.jwt.claims',${JSON.stringify({ sub: admin.userId, role: 'authenticated' })},true)`;
    const [row] = await sql`select revision from public.locations where id=${target.id}::uuid`;
    const selected = (
      await sql`select public.set_default_location(${target.id}::uuid,${row.revision}::integer) dto`
    )[0].dto;
    expect(selected.is_default).toBe(true);
    expect(
      (
        await rpc(
          'update_location',
          { location_id: target.id, expected_revision: row.revision, changes: { name: 'Blocked' } },
          admin.token,
        )
      ).data,
    ).toMatchObject({ code: '55P03' });
  });
  expect((await read(target.id)).is_default).toBe(false);
});

test('仓库命令独立校验权限和字段白名单，失败创建不残留', async () => {
  const target = await create();
  for (const token of [undefined, buyer.token])
    for (const [name, args] of [
      [
        'create_location',
        { location_id: crypto.randomUUID(), changes: { code: crypto.randomUUID(), name: 'Denied' } },
      ],
      ['update_location', { location_id: target.id, expected_revision: target.revision, changes: {} }],
      ['set_default_location', { location_id: target.id, expected_revision: target.revision }],
    ] as const)
      expect((await rpc(name, args, token)).data).toMatchObject({ code: '42501' });
  for (const extra of [
    { revision: 99 },
    { is_default: true },
    { name: null },
    { code: ' ' },
    { is_active: 'false' },
  ]) {
    const id = crypto.randomUUID();
    expect(
      (
        await rpc(
          'create_location',
          { location_id: id, changes: { code: id, name: 'Invalid', ...extra } },
          admin.token,
        )
      ).data,
    ).toMatchObject({ code: '22023' });
    expect(await toolData(session.client, 'get_admin_location', { location_id: id })).toBeNull();
  }
});
