import { afterAll, beforeAll, expect, test } from 'bun:test';
import { AdminBackend } from '../mcp/src/backend';
import { API, ANON_KEY, api, checked, rpc, signup, makeAdmin, type TestUser } from './helpers';
import { mcpSession, toolData } from './support/mcp';
import { Cleanup } from './support/cleanup';
import { staleAfterCommit, testDatabase } from './database-concurrency';

interface Definition {
  id: string;
  type: string;
  revision: number;
  fields: unknown[];
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
const numeric = (validations: object = {}) => [{ key: 'n', type: 'number', required: true, validations }];
async function create(fields: unknown[] = numeric()) {
  const id = crypto.randomUUID();
  cleanup.defer(() =>
    checked(api(`/rest/v1/metaobject_definitions?id=eq.${id}`, { service: true, method: 'DELETE' })),
  );
  return toolData<Definition>(session.client, 'create_metaobject_definition', {
    definition_id: id,
    changes: { type: `m_${id.replaceAll('-', '')}`, name: 'Schema', fields },
  });
}
const read = (id: string) =>
  toolData<Definition>(session.client, 'get_admin_metaobject_definition', { definition_id: id });
const edit = (d: Definition, changes: object) =>
  toolData<Definition>(session.client, 'update_metaobject_definition', {
    definition_id: d.id,
    expected_revision: d.revision,
    changes,
  });
const update = (d: Definition, changes: object) =>
  rpc(
    'update_metaobject_definition',
    {
      definition_id: d.id,
      expected_revision: d.revision,
      changes,
    },
    admin.token,
  );
const entry = (d: Definition, values: unknown, status = 'active') =>
  api('/rest/v1/metaobjects', {
    service: true,
    method: 'POST',
    body: { definition_id: d.id, handle: crypto.randomUUID(), values, status },
  });

test('私有默认、整组 schema 替换、无变化不推进版本，UUID/type 不做 upsert；创建失败无残留', async () => {
  let d = await create();
  expect(d).toMatchObject({ access: 'admin', is_active: true, revision: 1 });
  expect(await edit(d, {})).toEqual(d);
  d = await edit(d, { description: 'Changed', fields: [] });
  expect(d.fields).toEqual([]);
  expect(d.revision).toBe(2);
  expect(await edit(d, { description: 'Changed', fields: [] })).toEqual(d);
  for (const id of [d.id, crypto.randomUUID()])
    expect(
      (
        await rpc(
          'create_metaobject_definition',
          {
            definition_id: id,
            changes: { type: d.type, name: 'Duplicate', fields: [] },
          },
          admin.token,
        )
      ).data,
    ).toMatchObject({ code: '23505' });
  const failed = crypto.randomUUID();
  expect(
    (
      await rpc(
        'create_metaobject_definition',
        { definition_id: failed, changes: { type: failed, name: 'Invalid', fields: [], unknown: true } },
        admin.token,
      )
    ).data,
  ).toMatchObject({ code: '22023' });
  expect(await read(failed)).toBeNull();
});

test('严格声明与旧直写同样校验：重复 key、未知类型/规则、伪布尔及无效界限拒绝', async () => {
  const d = await create();
  for (const fields of [
    null,
    {},
    [null],
    [{ type: 'text' }],
    [{ key: ' ', type: 'text' }],
    [{ key: 'x', type: 'text', required: 'true' }],
    [{ key: 'x', type: 'text', name: null }],
    [{ key: 'x', type: 'json', extra: true }],
    [{ key: 'x', type: 'metaobject_reference' }],
    [
      { key: 'x', type: 'text' },
      { key: 'x', type: 'number' },
    ],
    numeric({ min: '2' }),
    numeric({ min: 7, max: 2 }),
    numeric({ choices: ['3'] }),
    numeric({ regex: '.*' }),
    [{ key: 'x', type: 'text', validations: { min: 1 } }],
    [{ key: 'x', type: 'list_text', validations: { choices: ['x'] } }],
    [{ key: 'x', type: 'json', validations: null }],
    Array.from({ length: 101 }, (_, i) => ({ key: String(i), type: 'text' })),
  ]) {
    expect((await update(d, { fields })).data).toMatchObject({ code: '22023' });
    expect(
      (
        await api(`/rest/v1/metaobject_definitions?id=eq.${d.id}`, {
          service: true,
          method: 'PATCH',
          body: { fields },
        })
      ).data,
    ).toMatchObject({ code: '22023' });
  }
  expect(await read(d.id)).toEqual(d);
});

test('真实条目强制类型/必填/列表元素/日期/候选值；JSON null 与省略不同，草稿不绕过校验', async () => {
  const d = await create([
    ...numeric({ min: 2, max: 8, choices: [2, 5, 8] }),
    { key: 'flag', type: 'boolean', required: true, validations: { choices: [false] } },
    { key: 'words', type: 'list_text' },
    { key: 'nums', type: 'list_number' },
    { key: 'date', type: 'date' },
    { key: 'time', type: 'datetime' },
    { key: 'json', type: 'json' },
    { key: 'text', type: 'text', validations: { choices: ['yes'] } },
  ]);
  const valid = {
    n: 2,
    flag: false,
    words: ['a'],
    nums: [1, 2.5],
    date: '2026-09-20',
    time: '2026-09-20T03:02:01Z',
    json: null,
    text: 'yes',
  };
  const [row] = await checked<Array<{ id: string; values: unknown }>>(entry(d, valid));
  expect(row.values).toEqual(valid);
  await checked(entry(d, { n: 8, flag: false }, 'draft'));
  for (const values of [
    [],
    null,
    { flag: false },
    { ...valid, n: null },
    { ...valid, n: '2' },
    { ...valid, n: 1 },
    { ...valid, n: 9 },
    { ...valid, n: 3 },
    { ...valid, flag: true },
    { ...valid, flag: 'false' },
    { ...valid, words: ['a', 7] },
    { ...valid, nums: [2, '3'] },
    { ...valid, words: 'a' },
    { ...valid, date: 'not a date' },
    { ...valid, time: 'invalid' },
    { ...valid, text: 'no' },
    { ...valid, undeclared: 3 },
    { ...valid, text: null },
  ]) {
    const result = await entry(d, values, 'draft');
    expect(result.status).not.toBe(201);
    expect(['22023', 'P0001']).toContain((result.data as { code: string }).code);
  }
  expect(
    (
      await api(`/rest/v1/metaobjects?id=eq.${row.id}`, {
        service: true,
        method: 'PATCH',
        body: { values: { n: 9, flag: false } },
      })
    ).data,
  ).toMatchObject({ code: 'P0001' });
  const requiredJson = await create([{ key: 'j', type: 'json', required: true }]);
  expect((await entry(requiredJson, { j: null })).data).toMatchObject({ code: '22023' });
  await checked(entry(requiredJson, { j: false }));
});

test('定义变化校验已有草稿/条目，失败连同发布一起回滚；兼容边界发布/撤回不改写内容', async () => {
  let d = await create();
  const [row] = await checked<Array<{ id: string }>>(entry(d, { n: 7 }));
  await checked(entry(d, { n: 9 }, 'draft'));
  for (const fields of [
    numeric({ max: 8 }),
    [],
    [{ key: 'n', type: 'text' }],
    [...numeric(), { key: 'x', type: 'text', required: true }],
  ]) {
    expect((await update(d, { fields, access: 'public' })).status).not.toBe(200);
    expect(await read(d.id)).toEqual(d);
    expect(await checked<unknown[]>(api(`/rest/v1/metaobjects?id=eq.${row.id}`))).toEqual([]);
  }
  d = await edit(d, { fields: numeric({ max: 9 }), access: 'public' });
  expect(await checked<unknown[]>(api(`/rest/v1/metaobjects?id=eq.${row.id}&select=values`))).toEqual([
    { values: { n: 7 } },
  ]);
  d = await edit(d, { is_active: false });
  expect(await checked<unknown[]>(api(`/rest/v1/metaobjects?id=eq.${row.id}`))).toEqual([]);
  d = await edit(d, { is_active: true, access: 'admin' });
  expect(await checked<unknown[]>(api(`/rest/v1/metaobjects?id=eq.${row.id}`))).toEqual([]);
});

test('旧直写无法伪造 revision；同版本并发只成功一次；定义/条目互斥且双向 RR 旧快照拒绝', async () => {
  let d = await create();
  await checked(
    api(`/rest/v1/metaobject_definitions?id=eq.${d.id}`, {
      token: admin.token,
      method: 'PATCH',
      body: { name: 'Direct', revision: 999 },
    }),
  );
  expect((await update(d, { name: 'Stale' })).data).toMatchObject({ code: 'PT409' });
  d = await read(d.id);
  expect(d.revision).toBe(2);
  const results = await Promise.all(['A', 'B'].map((name) => update(d, { name })));
  expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  expect(['PT409', '55P03']).toContain(
    (results.find((r) => r.status !== 200)!.data as { code: string }).code,
  );
  d = await read(d.id);
  await db.begin(async (sql) => {
    await sql`update public.metaobject_definitions set name='Holding' where id=${d.id}::uuid`;
    expect((await entry(d, { n: 6 })).data).toMatchObject({ code: '55P03' });
  });
  d = await read(d.id);
  await db.begin(async (sql) => {
    await sql`insert into public.metaobjects(definition_id,handle,values) values(${d.id}::uuid,'held','{"n":7}')`;
    expect((await update(d, { fields: numeric({ max: 6 }) })).data).toMatchObject({ code: '55P03' });
  });
  const staleDefinition = await staleAfterCommit(
    db,
    async (sql) => {
      await sql`update public.metaobject_definitions set fields='[{"key":"n","type":"number","validations":{"max":8}}]' where id=${d.id}::uuid`;
    },
    () => checked(entry(d, { n: 9 })),
  );
  expect(staleDefinition.error?.errno).toBe('40001');
  expect(await read(d.id)).toEqual(d);
  const staleEntry = await staleAfterCommit(
    db,
    async (sql) => {
      await sql`insert into public.metaobjects(definition_id,handle,values) values(${d.id}::uuid,'stale','{"n":12}')`;
    },
    () => edit(d, { fields: numeric({ max: 9 }) }),
  );
  expect(staleEntry.error?.errno).toBe('40001');
  expect((await entry(d, { n: 12 })).data).toMatchObject({ code: 'P0001' });
});

test('RPC 独立鉴权、身份不可修改、缺失/非法版本拒绝，不能通过条目迁移绕过定义', async () => {
  const d = await create(),
    other = await create();
  for (const token of [undefined, buyer.token]) {
    for (const definition_id of [d.id, crypto.randomUUID()]) {
      expect(
        (
          await api('/rest/v1/metaobjects', {
            token,
            method: 'POST',
            body: {
              definition_id,
              handle: crypto.randomUUID(),
              values: { undeclared: 'invalid' },
            },
          })
        ).data,
      ).toMatchObject({ code: '42501' });
    }
    expect(
      (
        await api('/rest/v1/metaobject_definitions', {
          token,
          method: 'POST',
          body: {
            type: crypto.randomUUID(),
            name: 'Forbidden',
            fields: [{ key: 'x', type: 'invalid' }],
          },
        })
      ).data,
    ).toMatchObject({ code: '42501' });
  }
  for (const token of [undefined, buyer.token])
    for (const [name, args] of [
      [
        'create_metaobject_definition',
        { definition_id: crypto.randomUUID(), changes: { type: 'x', name: 'x', fields: [] } },
      ],
      ['update_metaobject_definition', { definition_id: d.id, expected_revision: d.revision, changes: {} }],
    ] as const)
      expect((await rpc(name, args, token)).data).toMatchObject({ code: '42501' });
  for (const changes of [
    { type: 'rename' },
    { id: crypto.randomUUID() },
    { revision: 9 },
    { name: null },
    { is_active: null },
    { description: 1 },
  ])
    expect((await update(d, changes)).data).toMatchObject({ code: '22023' });
  expect((await update({ ...d, id: crypto.randomUUID() }, {})).data).toMatchObject({ code: 'PT404' });
  expect((await update({ ...d, revision: 0 }, {})).data).toMatchObject({ code: '22023' });
  const [row] = await checked<Array<{ id: string }>>(entry(d, { n: 4 }));
  expect(
    (
      await api(`/rest/v1/metaobjects?id=eq.${row.id}`, {
        service: true,
        method: 'PATCH',
        body: { definition_id: other.id },
      })
    ).data,
  ).toMatchObject({ code: '22023' });
  expect(
    (
      await api(`/rest/v1/metaobject_definitions?id=eq.${d.id}`, {
        service: true,
        method: 'PATCH',
        body: { type: 'rename' },
      })
    ).data,
  ).toMatchObject({ code: '22023' });
});
