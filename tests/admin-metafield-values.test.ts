import { afterAll, beforeAll, expect, test } from 'bun:test';
import { AdminBackend } from '../mcp/src/backend';
import { API, ANON_KEY, api, checked, rpc, signup, makeAdmin, TEST_ADDRESS, type TestUser } from './helpers';
import { mcpSession, toolData } from './support/mcp';
import { Cleanup } from './support/cleanup';
import { stockedProduct } from './support/catalog';
import { staleAfterCommit, testDatabase } from './database-concurrency';

interface Field {
  id: string;
  revision: number;
  owner_type: string;
  owner_id: string;
  namespace: string;
  key: string;
  type: string;
  value: unknown;
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
const edit = (f: Field, changes: object) =>
  toolData<Field>(session.client, 'update_metafield', {
    metafield_id: f.id,
    expected_revision: f.revision,
    changes,
  });
const list = (f: Field) =>
  toolData<{ items: Field[] }>(session.client, 'list_admin_metafields', {
    owner_type_filter: f.owner_type,
    owner_id_filter: f.owner_id,
    namespace_filter: f.namespace,
    key_filter: f.key,
  });
async function insert(table: string, body: object) {
  const [row] = await checked<Array<{ id: string }>>(
    api(`/rest/v1/${table}`, { service: true, method: 'POST', body }),
  );
  cleanup.defer(() => checked(api(`/rest/v1/${table}?id=eq.${row.id}`, { service: true, method: 'DELETE' })));
  return row.id;
}
async function create(changes: object = {}) {
  const f = await toolData<Field>(session.client, 'create_metafield', {
    metafield_id: crypto.randomUUID(),
    changes: {
      owner_type: 'shop',
      owner_id: crypto.randomUUID(),
      key: crypto.randomUUID(),
      type: 'json',
      value: null,
      ...changes,
    },
  });
  cleanup.defer(() => checked(api(`/rest/v1/metafields?id=eq.${f.id}`, { service: true, method: 'DELETE' })));
  return f;
}

test('JSON null 是值，不是省略或删除；对象整组替换，UUID/身份不做 upsert，删除需版本', async () => {
  let f = await create();
  expect(f).toMatchObject({
    value: null,
    revision: 1,
    namespace: 'custom',
    definition_id: null,
    definition_access: 'admin',
  });
  expect(await edit(f, {})).toEqual(f);
  f = await edit(f, { value: { a: 3, b: [false, null] } });
  f = await edit(f, { value: { a: 7 } });
  expect(f.value).toEqual({ a: 7 });
  const stale = f;
  f = await edit(f, { value: null });
  expect(f.value).toBeNull();
  const changes = {
    owner_type: f.owner_type,
    owner_id: f.owner_id,
    namespace: f.namespace,
    key: f.key,
    type: f.type,
    value: 9,
  };
  for (const id of [f.id, crypto.randomUUID()])
    expect((await rpc('create_metafield', { metafield_id: id, changes }, admin.token)).data).toMatchObject({
      code: '23505',
    });
  expect(
    (await rpc('delete_metafield', { metafield_id: f.id, expected_revision: stale.revision }, admin.token))
      .data,
  ).toMatchObject({ code: 'PT409' });
  expect(
    await toolData<{ id: string; deleted: boolean }>(session.client, 'delete_metafield', {
      metafield_id: f.id,
      expected_revision: f.revision,
    }),
  ).toEqual({ id: f.id, deleted: true });
  expect((await list(f)).items).toEqual([]);
  expect(
    (await rpc('delete_metafield', { metafield_id: f.id, expected_revision: f.revision }, admin.token)).data,
  ).toMatchObject({ code: 'PT404' });
});

test('分类/订单字段写入不改订单定价；缺失 owner 拒绝；客户匿名化后不可重建字段', async () => {
  const category = await insert('categories', { slug: `value-${crypto.randomUUID()}`, name: 'Values' });
  const c = await create({
    owner_type: 'category',
    owner_id: category,
    type: 'text',
    value: 'category content',
  });
  expect((await list(c)).items).toEqual([c]);
  expect(
    (
      await rpc(
        'create_metafield',
        {
          metafield_id: crypto.randomUUID(),
          changes: {
            owner_type: 'category',
            owner_id: crypto.randomUUID(),
            key: 'x',
            type: 'text',
            value: 'orphan',
          },
        },
        admin.token,
      )
    ).data,
  ).toMatchObject({ code: 'P0001' });
  const product = await stockedProduct(admin, { cleanup });
  const order = await checked<{ id: string }>(
    rpc(
      'create_order',
      {
        items: [{ variant_id: product.variantId, quantity: 1 }],
        address: TEST_ADDRESS,
        idempotency_key: crypto.randomUUID(),
      },
      buyer.token,
    ),
  );
  cleanup.defer(() => checked(rpc('cancel_order', { order_id: order.id }, buyer.token)));
  const before = await checked<Record<string, unknown>>(
    rpc('get_order_pricing', { order_id: order.id }, buyer.token),
  );
  const o = await create({ owner_type: 'order', owner_id: order.id, value: { note: 'packing only' } });
  await edit(o, { value: { note: 'updated' } });
  expect(
    await checked<Record<string, unknown>>(rpc('get_order_pricing', { order_id: order.id }, buyer.token)),
  ).toEqual(before);
  const customer = await signup();
  const f = await create({ owner_type: 'customer', owner_id: customer.customerId });
  await db.begin(async (sql) => {
    await sql`select id from public.customers where id=${customer.customerId}::uuid for update`;
    expect(
      (
        await rpc(
          'update_metafield',
          { metafield_id: f.id, expected_revision: f.revision, changes: { value: 'blocked' } },
          admin.token,
        )
      ).data,
    ).toMatchObject({ code: '55P03' });
  });
  await checked(rpc('anonymize_customer', { customer_id: customer.customerId }, admin.token));
  expect((await list(f)).items).toEqual([]);
  expect(
    (
      await rpc(
        'create_metafield',
        {
          metafield_id: crypto.randomUUID(),
          changes: {
            owner_type: 'customer',
            owner_id: customer.customerId,
            key: 'restore',
            type: 'text',
            value: 'PII',
          },
        },
        admin.token,
      )
    ).data,
  ).toMatchObject({ code: 'P0001' });
});

test('定义类型和规则约束值；引用不能悬空，删字段不删定义或目标', async () => {
  const key = crypto.randomUUID();
  const definition = await insert('metafield_definitions', {
    owner_type: 'shop',
    key,
    type: 'number',
    name: 'Bounded',
    validations: { min: 3, max: 8 },
    access: 'public',
  });
  let f = await create({ key, type: 'number', value: 5 });
  for (const changes of [{ value: 9 }, { type: 'text', value: '5' }]) {
    expect(
      (
        await rpc(
          'update_metafield',
          { metafield_id: f.id, expected_revision: f.revision, changes },
          admin.token,
        )
      ).data,
    ).toMatchObject({ code: 'P0001' });
    expect((await list(f)).items).toEqual([f]);
  }
  f = await edit(f, { value: 8 });
  expect(
    await checked<Array<{ value: number }>>(api(`/rest/v1/metafields?id=eq.${f.id}&select=value`)),
  ).toEqual([{ value: 8 }]);
  await toolData(session.client, 'delete_metafield', { metafield_id: f.id, expected_revision: f.revision });
  expect(
    (await checked<unknown[]>(api(`/rest/v1/metafield_definitions?id=eq.${definition}`, { service: true })))
      .length,
  ).toBe(1);
  const md = await insert('metaobject_definitions', {
    type: `ref_${crypto.randomUUID().replaceAll('-', '')}`,
    name: 'Reference',
    fields: [],
  });
  const target = await insert('metaobjects', { definition_id: md, handle: 'target', values: {} });
  const ref = await create({ type: 'metaobject_reference', value: target });
  expect(
    (
      await rpc(
        'update_metafield',
        { metafield_id: ref.id, expected_revision: ref.revision, changes: { value: crypto.randomUUID() } },
        admin.token,
      )
    ).data,
  ).toMatchObject({ code: 'P0001' });
  expect(
    (await api(`/rest/v1/metaobjects?id=eq.${target}`, { service: true, method: 'DELETE' })).data,
  ).toMatchObject({ code: '23503' });
  await toolData(session.client, 'delete_metafield', {
    metafield_id: ref.id,
    expected_revision: ref.revision,
  });
  expect(
    (await checked<unknown[]>(api(`/rest/v1/metaobjects?id=eq.${target}`, { service: true }))).length,
  ).toBe(1);
});

test('旧入口推进版本；同版本并发只允许一个成功；RR 旧快照不能覆盖新值', async () => {
  let f = await create();
  await checked(
    api(`/rest/v1/metafields?id=eq.${f.id}`, {
      token: admin.token,
      method: 'PATCH',
      body: { value: { direct: true }, revision: 999 },
    }),
  );
  const current = (await list(f)).items[0];
  expect(current.revision).toBe(f.revision + 1);
  expect(
    (
      await rpc(
        'update_metafield',
        { metafield_id: f.id, expected_revision: f.revision, changes: { value: 1 } },
        admin.token,
      )
    ).data,
  ).toMatchObject({ code: 'PT409' });
  f = current;
  const results = await Promise.all(
    [3, 7].map((value) =>
      rpc(
        'update_metafield',
        { metafield_id: f.id, expected_revision: f.revision, changes: { value } },
        admin.token,
      ),
    ),
  );
  expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  expect(['PT409', '55P03']).toContain(
    (results.find((r) => r.status !== 200)!.data as { code: string }).code,
  );
  f = (await list(f)).items[0];
  const stale = await staleAfterCommit(
    db,
    async (sql) => {
      await sql`select set_config('request.jwt.claims',${JSON.stringify({ sub: admin.userId, role: 'authenticated' })},true)`;
      await sql`select public.update_metafield(${f.id}::uuid,${f.revision}::integer,'{"value":4}'::jsonb)`;
    },
    () => edit(f, { value: 11 }),
  );
  expect(stale.error?.errno).toBe('40001');
  expect((await list(f)).items[0].value).toBe(11);
});

test('RPC 独立鉴权，拒绝身份注入及商品/变体旁路，创建失败无残留', async () => {
  const f = await create();
  const failedId = crypto.randomUUID();
  cleanup.defer(() =>
    checked(api(`/rest/v1/metafields?id=eq.${failedId}`, { service: true, method: 'DELETE' })),
  );
  expect(
    (
      await rpc(
        'create_metafield',
        {
          metafield_id: failedId,
          changes: {
            owner_type: 'shop',
            owner_id: f.owner_id,
            key: 'invalid',
            type: 'number',
            value: 'not a number',
          },
        },
        admin.token,
      )
    ).data,
  ).toMatchObject({ code: 'P0001' });
  expect(await checked<unknown[]>(api(`/rest/v1/metafields?id=eq.${failedId}`, { service: true }))).toEqual(
    [],
  );
  for (const token of [undefined, buyer.token])
    for (const [name, args] of [
      ['create_metafield', { metafield_id: crypto.randomUUID(), changes: {} }],
      ['update_metafield', { metafield_id: f.id, expected_revision: f.revision, changes: {} }],
      ['delete_metafield', { metafield_id: f.id, expected_revision: f.revision }],
    ] as const)
      expect((await rpc(name, args, token)).data).toMatchObject({ code: '42501' });
  for (const changes of [
    { owner_id: crypto.randomUUID() },
    { key: 'rename' },
    { revision: 1 },
    { type: null },
  ])
    expect(
      (
        await rpc(
          'update_metafield',
          { metafield_id: f.id, expected_revision: f.revision, changes },
          admin.token,
        )
      ).data,
    ).toMatchObject({ code: '22023' });
  const product = await stockedProduct(admin, { cleanup });
  for (const [owner_type, owner_id] of [
    ['product', product.productId],
    ['variant', product.variantId],
  ]) {
    const changes = { owner_type, owner_id, key: crypto.randomUUID(), type: 'json', value: 1 };
    expect(
      (await rpc('create_metafield', { metafield_id: crypto.randomUUID(), changes }, admin.token)).data,
    ).toMatchObject({ code: '22023' });
    const id = await insert('metafields', changes);
    for (const name of ['update_metafield', 'delete_metafield'])
      expect(
        (
          await rpc(
            name,
            {
              metafield_id: id,
              expected_revision: 1,
              ...(name === 'update_metafield' ? { changes: {} } : {}),
            },
            admin.token,
          )
        ).data,
      ).toMatchObject({ code: '22023' });
  }
});
