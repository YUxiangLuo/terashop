import { afterAll, beforeAll, expect, test } from 'bun:test';
import { AdminBackend } from '../mcp/src/backend';
import { API, ANON_KEY, api, checked, rpc, signup, makeAdmin, type TestUser } from './helpers';
import { mcpSession, toolData } from './support/mcp';
import { Cleanup } from './support/cleanup';
import { staleAfterCommit, testDatabase } from './database-concurrency';

interface Entry {
  id: string;
  definition_id: string;
  revision: number;
  handle: string;
  values: unknown;
  status: string;
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
async function definition(access = 'public') {
  const id = crypto.randomUUID();
  cleanup.defer(() =>
    checked(api(`/rest/v1/metaobject_definitions?id=eq.${id}`, { service: true, method: 'DELETE' })),
  );
  await toolData(session.client, 'create_metaobject_definition', {
    definition_id: id,
    changes: {
      type: id,
      name: 'Entry schema',
      access,
      fields: [
        { key: 'n', type: 'number', required: true, validations: { min: 2, max: 9 } },
        { key: 'extra', type: 'json' },
      ],
    },
  });
  return id;
}
const read = (id: string) => toolData<Entry>(session.client, 'get_admin_metaobject', { metaobject_id: id });
const create = (definition_id: string, changes: object = {}) =>
  toolData<Entry>(session.client, 'create_metaobject', {
    metaobject_id: crypto.randomUUID(),
    changes: {
      definition_id,
      handle: crypto.randomUUID(),
      values: { n: 4, extra: { a: 1, b: 2 } },
      ...changes,
    },
  });
const edit = (e: Entry, changes: object) =>
  toolData<Entry>(session.client, 'update_metaobject', {
    metaobject_id: e.id,
    expected_revision: e.revision,
    changes,
  });
const update = (e: Entry, changes: object) =>
  rpc('update_metaobject', { metaobject_id: e.id, expected_revision: e.revision, changes }, admin.token);

test('默认草稿，值整组替换、省略保留与 no-op；重复 UUID/handle 不覆盖，handle 冲突整笔回滚', async () => {
  const d = await definition();
  let e = await create(d);
  expect(e).toMatchObject({ status: 'draft', is_public: false, revision: 1 });
  expect(await edit(e, {})).toEqual(e);
  e = await edit(e, { values: { n: 7 } });
  expect(e.values).toEqual({ n: 7 });
  expect(e.revision).toBe(2);
  e = await edit(e, { handle: 'Renamed' });
  expect(e.values).toEqual({ n: 7 });
  expect(await edit(e, { handle: 'Renamed', values: { n: 7 } })).toEqual(e);
  for (const id of [e.id, crypto.randomUUID()])
    expect(
      (
        await rpc(
          'create_metaobject',
          {
            metaobject_id: id,
            changes: { definition_id: d, handle: e.handle, values: { n: 9 } },
          },
          admin.token,
        )
      ).data,
    ).toMatchObject({ code: '23505' });
  const other = await create(d);
  expect((await update(e, { handle: other.handle, values: { n: 8 }, status: 'active' })).data).toMatchObject({
    code: '23505',
  });
  expect(await read(e.id)).toEqual(e);
  const otherDefinition = await definition();
  expect((await create(otherDefinition, { handle: e.handle })).handle).toBe(e.handle);
});

test('发布/撤回与实际匿名读取、Metafield 引用一致；定义停用/私有使 active 条目不可公开', async () => {
  const d = await definition();
  let e = await create(d);
  const [fieldDefinition] = await checked<Array<{ id: string }>>(
    api('/rest/v1/metafield_definitions', {
      service: true,
      method: 'POST',
      body: {
        owner_type: 'shop',
        key: e.id,
        name: 'Reference',
        type: 'metaobject_reference',
        access: 'public',
      },
    }),
  );
  cleanup.defer(() =>
    checked(
      api(`/rest/v1/metafield_definitions?id=eq.${fieldDefinition.id}`, { service: true, method: 'DELETE' }),
    ),
  );
  const [field] = await checked<Array<{ id: string }>>(
    api('/rest/v1/metafields', {
      service: true,
      method: 'POST',
      body: {
        owner_type: 'shop',
        owner_id: crypto.randomUUID(),
        key: e.id,
        type: 'metaobject_reference',
        value: e.id,
      },
    }),
  );
  cleanup.defer(() =>
    checked(api(`/rest/v1/metafields?id=eq.${field.id}`, { service: true, method: 'DELETE' })),
  );
  const visible = async (expected: boolean) => {
    expect(await checked<unknown[]>(api(`/rest/v1/metaobjects?id=eq.${e.id}&select=id`))).toEqual(
      expected ? [{ id: e.id }] : [],
    );
    expect(await checked<unknown[]>(api(`/rest/v1/metafields?id=eq.${field.id}&select=id`))).toEqual(
      expected ? [{ id: field.id }] : [],
    );
  };
  await visible(false);
  e = await edit(e, { status: 'active' });
  expect(e).toMatchObject({ is_public: true });
  await visible(true);
  const published = e;
  e = await edit(e, { status: 'draft' });
  await visible(false);
  expect((await update(published, { status: 'active' })).data).toMatchObject({ code: 'PT409' });
  e = await edit(e, { status: 'active', values: { n: 8 } });
  await visible(true);
  for (const body of [{ is_active: false }, { is_active: true, access: 'admin' }]) {
    await checked(
      api(`/rest/v1/metaobject_definitions?id=eq.${d}`, { service: true, method: 'PATCH', body }),
    );
    await visible(false);
    expect(await read(e.id)).toMatchObject({ revision: e.revision, status: 'active', is_public: false });
  }
  const directActive = await create(await definition(), { status: 'active' });
  expect(directActive).toMatchObject({ is_public: true, status: 'active' });
});

test('完整校验含草稿；无效修改/发布原子回滚，失败创建不留行，RPC 独立鉴权及身份不变', async () => {
  const d = await definition(),
    e = await create(d);
  for (const changes of [
    { values: {} },
    { values: { n: '4' } },
    { values: { n: 10 }, status: 'active' },
    { values: null },
    { values: [] },
    { definition_id: d },
    { revision: 100 },
    { handle: ' ' },
    { status: 'published' },
  ]) {
    expect((await update(e, changes)).status).not.toBe(200);
    expect(await read(e.id)).toEqual(e);
  }
  for (const changes of [
    { values: { n: 1 } },
    { unknown: true },
    { handle: ' ' },
    { definition_id: crypto.randomUUID() },
  ]) {
    const id = crypto.randomUUID();
    expect(
      (
        await rpc(
          'create_metaobject',
          { metaobject_id: id, changes: { definition_id: d, handle: id, values: { n: 3 }, ...changes } },
          admin.token,
        )
      ).status,
    ).not.toBe(200);
    expect(await read(id)).toBeNull();
  }
  for (const token of [undefined, buyer.token])
    for (const [name, args] of [
      [
        'create_metaobject',
        {
          metaobject_id: crypto.randomUUID(),
          changes: { definition_id: d, handle: 'denied', values: { n: 3 } },
        },
      ],
      [
        'update_metaobject',
        { metaobject_id: e.id, expected_revision: e.revision, changes: { status: 'active' } },
      ],
    ] as const)
      expect((await rpc(name, args, token)).data).toMatchObject({ code: '42501' });
  expect((await update({ ...e, id: crypto.randomUUID() }, {})).data).toMatchObject({ code: 'PT404' });
});

test('旧入口推进版本；同版本并发只成功一次；行锁/定义锁竞争拒绝，RR 旧快照不能覆盖', async () => {
  const d = await definition();
  let e = await create(d);
  await checked(
    api(`/rest/v1/metaobjects?id=eq.${e.id}`, {
      token: admin.token,
      method: 'PATCH',
      body: { values: { n: 5 }, revision: 999 },
    }),
  );
  expect((await update(e, { status: 'active' })).data).toMatchObject({ code: 'PT409' });
  e = await read(e.id);
  expect(e.revision).toBe(2);
  const results = await Promise.all([6, 7].map((n) => update(e, { values: { n } })));
  expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  expect(['PT409', '55P03']).toContain(
    (results.find((r) => r.status !== 200)!.data as { code: string }).code,
  );
  e = await read(e.id);
  await db.begin(async (sql) => {
    await sql`select id from public.metaobjects where id=${e.id}::uuid for update`;
    expect((await update(e, { status: 'active' })).data).toMatchObject({ code: '55P03' });
  });
  await db.begin(async (sql) => {
    await sql`update public.metaobject_definitions set name='Held' where id=${d}::uuid`;
    expect((await update(e, { status: 'active' })).data).toMatchObject({ code: '55P03' });
  });
  const stale = await staleAfterCommit(
    db,
    async (sql) => {
      await sql`select set_config('request.jwt.claims',${JSON.stringify({ sub: admin.userId, role: 'authenticated' })},true)`;
      await sql`select public.update_metaobject(${e.id}::uuid,${e.revision}::integer,'{"values":{"n":2}}'::jsonb)`;
    },
    () => edit(e, { values: { n: 9 } }),
  );
  expect(stale.error?.errno).toBe('40001');
  expect((await read(e.id)).values).toEqual({ n: 9 });
});
