import { afterAll, beforeAll, expect, test } from 'bun:test';
import { AdminBackend } from '../mcp/src/backend';
import { API, ANON_KEY, api, checked, rpc, signup, makeAdmin, type TestUser } from './helpers';
import { mcpSession, toolData } from './support/mcp';
import { Cleanup } from './support/cleanup';
import { staleAfterCommit, testDatabase } from './database-concurrency';

interface Definition {
  id: string;
  revision: number;
  owner_type: string;
  namespace: string;
  key: string;
  type: string;
  access: string;
  validations: object;
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
const read = (definition_id: string) =>
  toolData<Definition>(session.client, 'get_admin_metafield_definition', { definition_id });
const edit = (d: Definition, changes: object) =>
  toolData<Definition>(session.client, 'update_metafield_definition', {
    definition_id: d.id,
    expected_revision: d.revision,
    changes,
  });
async function create(changes: object = {}) {
  const d = await toolData<Definition>(session.client, 'create_metafield_definition', {
    definition_id: crypto.randomUUID(),
    changes: {
      owner_type: 'shop',
      key: crypto.randomUUID(),
      name: 'Test definition',
      type: 'number',
      ...changes,
    },
  });
  cleanup.defer(() =>
    checked(api(`/rest/v1/metafield_definitions?id=eq.${d.id}`, { service: true, method: 'DELETE' })),
  );
  return d;
}
async function value(
  d: Pick<Definition, 'owner_type' | 'namespace' | 'key' | 'type'>,
  v: unknown,
  owner: string = crypto.randomUUID(),
) {
  const [row] = await checked<Array<{ id: string }>>(
    api('/rest/v1/metafields', {
      service: true,
      method: 'POST',
      body: {
        owner_type: d.owner_type,
        owner_id: owner,
        namespace: d.namespace,
        key: d.key,
        type: d.type,
        value: v,
      },
    }),
  );
  cleanup.defer(() =>
    checked(api(`/rest/v1/metafields?id=eq.${row.id}`, { service: true, method: 'DELETE' })),
  );
  return row.id;
}

test('默认私有、非 upsert、无变化不推进版本；校验对象整组替换', async () => {
  let d = await create();
  expect(d).toMatchObject({ access: 'admin', namespace: 'custom', revision: 1, validations: {} });
  expect(await edit(d, {})).toEqual(d);
  d = await edit(d, { validations: { min: 2, max: 9 }, position: -3 });
  expect(d.validations).toEqual({ min: 2, max: 9 });
  d = await edit(d, { validations: { min: 4 } });
  expect(d.validations).toEqual({ min: 4 });
  d = await edit(d, { type: 'text', validations: {} });
  expect(d).toMatchObject({ type: 'text', validations: {} });
  expect(
    (
      await rpc(
        'create_metafield_definition',
        {
          definition_id: d.id,
          changes: { owner_type: 'shop', key: crypto.randomUUID(), name: 'Duplicate', type: 'text' },
        },
        admin.token,
      )
    ).data,
  ).toMatchObject({ code: '23505' });
});

test('已有值使不兼容类型/规则变更整体回滚，包括同时发布；兼容边界值可发布和收回', async () => {
  let d = await create();
  const owner = crypto.randomUUID();
  await value(d, 7, owner);
  for (const changes of [
    { type: 'text' },
    { validations: { min: 8 } },
    { validations: { max: 6 } },
    { validations: { choices: [6, 8] } },
  ]) {
    expect(
      (
        await rpc(
          'update_metafield_definition',
          { definition_id: d.id, expected_revision: d.revision, changes: { ...changes, access: 'public' } },
          admin.token,
        )
      ).data,
    ).toMatchObject({ code: 'P0001' });
    expect(await read(d.id)).toEqual(d);
  }
  const visible = () =>
    checked<Array<{ value: number }>>(api(`/rest/v1/metafields?owner_id=eq.${owner}&key=eq.${d.key}`));
  expect(await visible()).toEqual([]);
  d = await edit(d, { access: 'public', validations: { min: 7, max: 7, choices: [7] } });
  expect((await visible()).map((v) => v.value)).toEqual([7]);
  d = await edit(d, { access: 'admin' });
  expect(await visible()).toEqual([]);
  const identity = { owner_type: 'shop', namespace: 'custom', key: crypto.randomUUID(), type: 'number' };
  await value(identity, 7);
  const id = crypto.randomUUID();
  expect(
    (
      await rpc(
        'create_metafield_definition',
        {
          definition_id: id,
          changes: { ...identity, name: 'Must rollback', access: 'public', validations: { max: 6 } },
        },
        admin.token,
      )
    ).data,
  ).toMatchObject({ code: 'P0001' });
  expect(await read(id)).toBeNull();
});

test('版本保护旧入口与同版本并发；旧 RR 快照不能忽略刚提交的字段值', async () => {
  let d = await create();
  await checked(
    api(`/rest/v1/metafield_definitions?id=eq.${d.id}`, {
      token: admin.token,
      method: 'PATCH',
      body: { name: 'Legacy', revision: 999 },
    }),
  );
  expect((await read(d.id)).revision).toBe(d.revision + 1);
  expect(
    (
      await rpc(
        'update_metafield_definition',
        { definition_id: d.id, expected_revision: d.revision, changes: { name: 'Stale' } },
        admin.token,
      )
    ).data,
  ).toMatchObject({ code: 'PT409' });
  d = await read(d.id);
  const results = await Promise.all(
    ['A', 'B'].map((name) =>
      rpc(
        'update_metafield_definition',
        { definition_id: d.id, expected_revision: d.revision, changes: { name } },
        admin.token,
      ),
    ),
  );
  expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  expect(['PT409', '55P03']).toContain(
    (results.find((r) => r.status !== 200)!.data as { code: string }).code,
  );
  d = await read(d.id);
  const stale = await staleAfterCommit(
    db,
    async (sql) => {
      await sql`select set_config('request.jwt.claims',${JSON.stringify({ sub: admin.userId, role: 'authenticated' })},true)`;
      await sql`select public.update_metafield_definition(${d.id}::uuid,${d.revision}::integer,'{"validations":{"max":6}}'::jsonb)`;
    },
    () => value(d, 7),
  );
  expect(stale.error?.errno).toBe('40001');
  expect(await read(d.id)).toEqual(d);
});

test('RPC 权限、身份不可修改、未知/无效校验拒绝；客户定义不能公开', async () => {
  const d = await create();
  for (const token of [undefined, buyer.token]) {
    expect(
      (
        await rpc(
          'create_metafield_definition',
          {
            definition_id: crypto.randomUUID(),
            changes: { owner_type: 'shop', key: 'x', name: 'Denied', type: 'text' },
          },
          token,
        )
      ).data,
    ).toMatchObject({ code: '42501' });
    expect(
      (
        await rpc(
          'update_metafield_definition',
          { definition_id: d.id, expected_revision: d.revision, changes: {} },
          token,
        )
      ).data,
    ).toMatchObject({ code: '42501' });
  }
  for (const changes of [
    { owner_type: 'product' },
    { namespace: 'other' },
    { key: 'other' },
    { revision: 1 },
    { name: null },
    { validations: null },
    { validations: { regex: '.*' } },
    { validations: { min: '2' } },
    { validations: { min: 3, max: 2 } },
    { validations: { choices: ['7'] } },
    { type: 'list_text', validations: { choices: ['x'] } },
  ]) {
    expect(
      (
        await rpc(
          'update_metafield_definition',
          { definition_id: d.id, expected_revision: d.revision, changes },
          admin.token,
        )
      ).data,
    ).toMatchObject({ code: '22023' });
    expect(await read(d.id)).toEqual(d);
  }
  let customer = await create({ owner_type: 'customer', type: 'text' });
  await value(customer, 'private', buyer.customerId);
  expect(
    (
      await rpc(
        'update_metafield_definition',
        { definition_id: customer.id, expected_revision: customer.revision, changes: { access: 'public' } },
        admin.token,
      )
    ).data,
  ).toMatchObject({ code: '23514' });
  customer = await edit(customer, { access: 'customer' });
  expect(
    (
      await checked<Array<{ value: string }>>(
        api(`/rest/v1/metafields?owner_id=eq.${buyer.customerId}&key=eq.${customer.key}`, {
          token: buyer.token,
        }),
      )
    ).map((v) => v.value),
  ).toEqual(['private']);
  const other = await signup();
  expect(
    await checked<unknown[]>(
      api(`/rest/v1/metafields?owner_id=eq.${buyer.customerId}&key=eq.${customer.key}`, {
        token: other.token,
      }),
    ),
  ).toEqual([]);
});
