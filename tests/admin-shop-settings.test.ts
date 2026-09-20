import { afterAll, beforeAll, expect, test } from 'bun:test';
import { AdminBackend } from '../mcp/src/backend';
import { API, ANON_KEY, checked, rpc, signup, makeAdmin, type TestUser } from './helpers';
import { mcpSession, toolData } from './support/mcp';
import { staleAfterCommit, testDatabase } from './database-concurrency';

interface Settings {
  name: string;
  timezone: string;
  currency: string;
  revision: number;
  updated_at: string;
}
const db = testDatabase();
let admin: TestUser, buyer: TestUser, initial: Settings;
let session: Awaited<ReturnType<typeof mcpSession>>;
const read = () => toolData<Settings>(session.client, 'get_admin_shop_settings');
const update = (revision: number, changes: Record<string, unknown>) =>
  toolData<Settings>(session.client, 'update_shop_settings', { expected_revision: revision, changes });
beforeAll(async () => {
  admin = await signup();
  buyer = await signup();
  await makeAdmin(admin.userId);
  session = await mcpSession(
    new AdminBackend({ url: API, anonKey: ANON_KEY, accessToken: admin.token }),
    true,
  );
  initial = await read();
});
afterAll(async () => {
  try {
    if (initial) await update((await read()).revision, { name: initial.name, timezone: initial.timezone });
  } finally {
    await session?.close();
    await db.close();
  }
});

test('店铺设置显式 DTO、部分更新、空补丁与同值不推进版本，旧版本不能重放', async () => {
  const before = await read();
  expect(Object.keys(before).sort()).toEqual(['currency', 'name', 'revision', 'timezone', 'updated_at']);
  expect(before.currency).toBe('USD');
  const name = `Shop ${crypto.randomUUID()}`;
  const changed = await update(before.revision, { name, timezone: 'Asia/Shanghai' });
  expect(changed).toMatchObject({
    name,
    timezone: 'Asia/Shanghai',
    currency: 'USD',
    revision: before.revision + 1,
  });
  expect(changed.updated_at).not.toBe(before.updated_at);
  expect(await update(changed.revision, {})).toEqual(changed);
  expect(await update(changed.revision, { name })).toEqual(changed);
  expect(
    (
      await rpc(
        'update_shop_settings',
        { expected_revision: before.revision, changes: { name } },
        admin.token,
      )
    ).data,
  ).toMatchObject({ code: 'PT409' });
  const partial = await update(changed.revision, { timezone: 'America/New_York' });
  expect(partial).toMatchObject({ name, timezone: 'America/New_York', revision: changed.revision + 1 });
  expect(await checked<Settings>(rpc('get_admin_shop_settings', {}, undefined, true))).toEqual(partial);
});

test('RPC 独立拒绝越权、未知字段、无效时区和伪造版本，失败不写入', async () => {
  const before = await read();
  for (const token of [undefined, buyer.token]) {
    expect((await rpc('get_admin_shop_settings', {}, token)).data).toMatchObject({ code: '42501' });
    expect(
      (
        await rpc(
          'update_shop_settings',
          { expected_revision: before.revision, changes: { name: 'Denied' } },
          token,
        )
      ).data,
    ).toMatchObject({ code: '42501' });
  }
  for (const changes of [
    null,
    [],
    { currency: 'EUR' },
    { revision: 42 },
    { name: null },
    { name: '' },
    { name: '   ' },
    { name: 'x'.repeat(201) },
    { timezone: 'not/a/zone' },
    { timezone: null },
    { timezone: '+08:00' },
    { timezone: 'asia/shanghai' },
  ]) {
    expect(
      (await rpc('update_shop_settings', { expected_revision: before.revision, changes }, admin.token)).data,
    ).toMatchObject({ code: '22023' });
  }
  for (const expected_revision of [null, 0]) {
    expect(
      (await rpc('update_shop_settings', { expected_revision, changes: {} }, admin.token)).data,
    ).toMatchObject({ code: '22023' });
  }
  expect(await read()).toEqual(before);
  const [privileges] = await db`select
    has_table_privilege('authenticated','private.shop_settings','UPDATE') as admin_write,
    has_table_privilege('service_role','private.shop_settings','UPDATE') as service_write`;
  expect(privileges).toEqual({ admin_write: false, service_write: false });
});

test('竞争写入与旧 REPEATABLE READ 快照不能覆盖已提交配置', async () => {
  const before = await read();
  await db.begin(async (tx) => {
    await tx`select * from private.shop_settings for no key update`;
    expect(
      (
        await rpc(
          'update_shop_settings',
          { expected_revision: before.revision, changes: { name: 'Blocked' } },
          admin.token,
        )
      ).data,
    ).toMatchObject({ code: '55P03' });
  });
  const name = `Committed ${crypto.randomUUID()}`;
  const result = await staleAfterCommit(
    db,
    async (tx) => {
      await tx`select set_config('request.jwt.claims','{"role":"service_role"}',true)`;
      return tx`select public.update_shop_settings(${before.revision},'{"name":"Stale"}'::jsonb)`;
    },
    () => update(before.revision, { name }),
  );
  expect(result.error).toMatchObject({ errno: '40001' });
  expect(await read()).toMatchObject({ name, revision: before.revision + 1 });
});
