import { afterAll, beforeAll, expect, test } from 'bun:test';
import { AdminBackend } from '../mcp/src/backend';
import { API, ANON_KEY, api, checked, rpc, signup, makeAdmin, type TestUser } from './helpers';
import { mcpSession, toolData } from './support/mcp';
import { Cleanup } from './support/cleanup';
import { staleAfterCommit, testDatabase } from './database-concurrency';

interface Versioned {
  id: string;
  revision: number;
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
async function definition() {
  const id = crypto.randomUUID();
  cleanup.defer(() =>
    checked(api(`/rest/v1/metaobject_definitions?id=eq.${id}`, { service: true, method: 'DELETE' })),
  );
  return toolData<Versioned>(session.client, 'create_metaobject_definition', {
    definition_id: id,
    changes: { type: id, name: 'Delete', fields: [] },
  });
}
const entry = (d: Versioned) =>
  toolData<Versioned>(session.client, 'create_metaobject', {
    metaobject_id: crypto.randomUUID(),
    changes: { definition_id: d.id, handle: crypto.randomUUID(), values: {} },
  });
const args = (d: Versioned, definition = false) => ({
  [definition ? 'definition_id' : 'metaobject_id']: d.id,
  expected_revision: d.revision,
});
const remove = (d: Versioned, definition = false) =>
  rpc(definition ? 'delete_metaobject_definition' : 'delete_metaobject', args(d, definition), admin.token);
const read = (d: Versioned, definition = false) =>
  toolData<Versioned | null>(
    session.client,
    definition ? 'get_admin_metaobject_definition' : 'get_admin_metaobject',
    { [definition ? 'definition_id' : 'metaobject_id']: d.id },
  );

test('只删目标条目、保留定义；非空定义包含草稿也不能级联删除，重复请求返回缺失', async () => {
  const d = await definition(),
    e = await entry(d),
    sibling = await entry(d);
  expect((await remove(d, true)).data).toMatchObject({ code: '23503' });
  expect(await read(e)).toMatchObject(e);
  expect(await read(sibling)).toMatchObject(sibling);
  expect(
    await toolData<{ id: string; deleted: boolean }>(session.client, 'delete_metaobject', args(e)),
  ).toEqual({ id: e.id, deleted: true });
  expect(await read(e)).toBeNull();
  expect(await read(d, true)).toMatchObject(d);
  expect(await read(sibling)).toMatchObject(sibling);
  expect((await remove(e)).data).toMatchObject({ code: 'PT404' });
  expect((await remove(d, true)).data).toMatchObject({ code: '23503' });
  await checked(remove(sibling));
  expect(
    await toolData<{ id: string; deleted: boolean }>(
      session.client,
      'delete_metaobject_definition',
      args(d, true),
    ),
  ).toEqual({
    id: d.id,
    deleted: true,
  });
  expect(await read(d, true)).toBeNull();
  expect((await remove(d, true)).data).toMatchObject({ code: 'PT404' });
});

test('私有单引用/列表引用阻止删除，不能自动删除引用；显式解除后才允许删除', async () => {
  const d = await definition(),
    e = await entry(d);
  const field = crypto.randomUUID(),
    owner = crypto.randomUUID();
  cleanup.defer(() =>
    checked(api(`/rest/v1/metafields?id=eq.${field}`, { service: true, method: 'DELETE' })),
  );
  await checked(
    api('/rest/v1/metafields', {
      service: true,
      method: 'POST',
      body: {
        id: field,
        owner_type: 'shop',
        owner_id: owner,
        key: field,
        type: 'metaobject_reference',
        value: e.id,
      },
    }),
  );
  for (const body of [
    { type: 'metaobject_reference', value: e.id },
    { type: 'list_metaobject_reference', value: [e.id, e.id] },
  ]) {
    await checked(api(`/rest/v1/metafields?id=eq.${field}`, { service: true, method: 'PATCH', body }));
    expect((await remove(e)).data).toMatchObject({ code: '23503' });
    expect(await read(e)).toMatchObject(e);
    expect(
      await checked<unknown[]>(api(`/rest/v1/metafields?id=eq.${field}&select=value`, { service: true })),
    ).toEqual([{ value: body.value }]);
  }
  await checked(
    api(`/rest/v1/metafields?id=eq.${field}`, { service: true, method: 'PATCH', body: { value: [] } }),
  );
  await checked(remove(e));
  expect(
    await checked<unknown[]>(api(`/rest/v1/metafields?id=eq.${field}&select=value`, { service: true })),
  ).toEqual([{ value: [] }]);
  expect(await read(d, true)).toMatchObject(d);
});

test('RPC 独立鉴权、缺失/无效版本与旧版本拒绝，同版本并发删除只成功一次', async () => {
  for (const isDefinition of [false, true]) {
    const d = await definition(),
      target = isDefinition ? d : await entry(d);
    const name = isDefinition ? 'delete_metaobject_definition' : 'delete_metaobject';
    for (const token of [undefined, buyer.token])
      expect((await rpc(name, args(target, isDefinition), token)).data).toMatchObject({ code: '42501' });
    for (const revision of [0, null])
      expect(
        (await rpc(name, { ...args(target, isDefinition), expected_revision: revision }, admin.token)).data,
      ).toMatchObject({ code: '22023' });
    await toolData(session.client, isDefinition ? 'update_metaobject_definition' : 'update_metaobject', {
      ...args(target, isDefinition),
      changes: isDefinition ? { name: 'Changed' } : { handle: 'changed' },
    });
    expect((await remove(target, isDefinition)).data).toMatchObject({ code: 'PT409' });
    const latest = (await read(target, isDefinition))!;
    const results = await Promise.all([remove(latest, isDefinition), remove(latest, isDefinition)]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(['PT404', '55P03']).toContain(
      (results.find((r) => r.status !== 200)!.data as { code: string }).code,
    );
    expect(await read(target, isDefinition)).toBeNull();
  }
});

test('新增条目与删除定义互斥；RR 旧快照不能忽略新增条目触发级联，反向插入不能复活已删定义', async () => {
  const d = await definition();
  await db.begin(async (sql) => {
    await sql`insert into public.metaobjects(definition_id,handle) values(${d.id}::uuid,'holding')`;
    expect((await remove(d, true)).data).toMatchObject({ code: '55P03' });
  });
  await checked(api(`/rest/v1/metaobjects?definition_id=eq.${d.id}`, { service: true, method: 'DELETE' }));
  let child: Versioned;
  const stale = await staleAfterCommit(
    db,
    async (sql) => {
      await sql`select set_config('request.jwt.claims',${JSON.stringify({ sub: admin.userId, role: 'authenticated' })},true)`;
      await sql`select public.delete_metaobject_definition(${d.id}::uuid,${d.revision}::integer)`;
    },
    async () => {
      child = await entry(d);
    },
  );
  expect(stale.error?.errno).toBe('40001');
  expect(await read(d, true)).toMatchObject(d);
  expect(await read(child!)).toMatchObject(child!);
  await checked(remove(child!));
  const reverse = await staleAfterCommit(
    db,
    async (sql) => {
      await sql`insert into public.metaobjects(definition_id,handle) values(${d.id}::uuid,'stale')`;
    },
    () => checked(remove(d, true)),
  );
  expect(reverse.error?.errno).toBe('40001');
  expect(await read(d, true)).toBeNull();
});

test('引用写入与删除目标互斥；RR 旧快照仍受真实引用 FK 保护', async () => {
  const d = await definition(),
    e = await entry(d),
    field = crypto.randomUUID();
  cleanup.defer(() =>
    checked(api(`/rest/v1/metafields?id=eq.${field}`, { service: true, method: 'DELETE' })),
  );
  await db.begin(async (sql) => {
    await sql`insert into public.metafields(id,owner_type,owner_id,key,type,value) values(${field}::uuid,'shop',${field}::uuid,${field},'metaobject_reference',to_jsonb(${e.id}::text))`;
    expect((await remove(e)).data).toMatchObject({ code: '55P03' });
  });
  await checked(api(`/rest/v1/metafields?id=eq.${field}`, { service: true, method: 'DELETE' }));
  const stale = await staleAfterCommit(
    db,
    async (sql) => {
      await sql`select set_config('request.jwt.claims',${JSON.stringify({ sub: admin.userId, role: 'authenticated' })},true)`;
      await sql`select public.delete_metaobject(${e.id}::uuid,${e.revision}::integer)`;
    },
    () =>
      checked(
        api('/rest/v1/metafields', {
          service: true,
          method: 'POST',
          body: {
            id: field,
            owner_type: 'shop',
            owner_id: field,
            key: field,
            type: 'metaobject_reference',
            value: e.id,
          },
        }),
      ),
  );
  expect(['23503', '40001']).toContain(stale.error?.errno);
  expect(await read(e)).toMatchObject(e);
  expect(
    await checked<unknown[]>(api(`/rest/v1/metafields?id=eq.${field}&select=value`, { service: true })),
  ).toEqual([{ value: e.id }]);
});
