import { afterAll, beforeAll, expect, test } from 'bun:test';
import { AdminBackend } from '../mcp/src/backend';
import { API, ANON_KEY, api, checked, rpc, signup, makeAdmin, type TestUser } from './helpers';
import { mcpSession, toolData } from './support/mcp';
import { testDatabase } from './database-concurrency';

interface Address {
  id: string;
  updated_at: string;
  country: string;
  line1: string;
  phone: string | null;
  is_default: boolean;
}
interface Customer {
  id: string;
  updated_at: string;
  email: string | null;
  full_name: string;
  phone: string | null;
  addresses: Address[];
}
const db = testDatabase();
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
    await session?.close();
  } finally {
    await db.close();
  }
});
const call = (name: string, args: Record<string, unknown>) => toolData<Customer>(session.client, name, args);
const read = (customer_id: string) => call('get_admin_customer', { customer_id });
const create = () =>
  call('create_customer', {
    idempotency_key: crypto.randomUUID(),
    full_name: 'Original',
    email: 'contact@example.test',
    phone: '1234',
  });
const address = {
  recipient_name: 'Recipient',
  country: 'jp',
  line1: '1 Main St',
  city: 'Tokyo',
  phone: '5678',
};

test('MCP 客户资料更新保留未传字段、支持 null、校验旧令牌且不改 Auth 邮箱', async () => {
  const original = await read(buyer.customerId);
  const unchanged = await call('update_customer', {
    customer_id: original.id,
    expected_updated_at: original.updated_at,
    changes: {},
  });
  expect(unchanged.updated_at).toBe(original.updated_at);
  const changed = await call('update_customer', {
    customer_id: original.id,
    expected_updated_at: original.updated_at,
    changes: { full_name: '商店客户', email: 'different@example.test', phone: '1234' },
  });
  expect(changed).toMatchObject({ full_name: '商店客户', email: 'different@example.test', phone: '1234' });
  expect(changed.updated_at).not.toBe(original.updated_at);
  expect(await checked(api('/auth/v1/user', { token: buyer.token }))).toMatchObject({
    id: buyer.userId,
    email: buyer.email,
  });
  expect(
    (
      await rpc(
        'update_customer',
        {
          customer_id: original.id,
          expected_updated_at: original.updated_at,
          changes: { full_name: 'Lost' },
        },
        admin.token,
      )
    ).data,
  ).toMatchObject({ code: 'PT409' });
  expect(
    await call('update_customer', {
      customer_id: changed.id,
      expected_updated_at: changed.updated_at,
      changes: { email: null, phone: null },
    }),
  ).toMatchObject({ email: null, phone: null, full_name: '商店客户' });
});

test('MCP 地址创建/修改/删除保留归属、默认命令与时间戳冲突合同', async () => {
  const customer = await create(),
    id = crypto.randomUUID();
  const args = { customer_id: customer.id, address_id: id, changes: address };
  const created = await call('create_customer_address', args);
  expect(created.addresses).toHaveLength(1);
  expect(created.addresses[0]).toMatchObject({ id, country: 'JP', is_default: false, phone: '5678' });
  expect((await rpc('create_customer_address', args, admin.token)).data).toMatchObject({ code: '23505' });
  const token = created.addresses[0].updated_at;
  expect(
    (
      await call('update_customer_address', {
        customer_id: customer.id,
        address_id: id,
        expected_updated_at: token,
        changes: {},
      })
    ).updated_at,
  ).toBe(created.updated_at);
  const edited = await call('update_customer_address', {
    customer_id: customer.id,
    address_id: id,
    expected_updated_at: token,
    changes: { phone: null, line1: '2 Other St' },
  });
  expect(edited.addresses[0]).toMatchObject({ phone: null, line1: '2 Other St', country: 'JP' });
  for (const name of ['update_customer_address', 'delete_customer_address']) {
    expect(
      (
        await rpc(
          name,
          {
            customer_id: customer.id,
            address_id: id,
            expected_updated_at: token,
            ...(name.startsWith('update') ? { changes: { line1: 'Lost' } } : {}),
          },
          admin.token,
        )
      ).data,
    ).toMatchObject({ code: 'PT409' });
    expect(
      (
        await rpc(
          name,
          {
            customer_id: buyer.customerId,
            address_id: id,
            expected_updated_at: edited.addresses[0].updated_at,
            ...(name.startsWith('update') ? { changes: {} } : {}),
          },
          admin.token,
        )
      ).data,
    ).toMatchObject({ code: 'PT404' });
  }
  await toolData(session.client, 'set_default_address', { address_id: id });
  const second = crypto.randomUUID();
  const withSecond = await call('create_customer_address', { ...args, address_id: second });
  expect(withSecond.addresses.find((a) => a.id === id)?.is_default).toBe(true);
  const deleted = await call('delete_customer_address', {
    customer_id: customer.id,
    address_id: id,
    expected_updated_at: withSecond.addresses.find((a) => a.id === id)!.updated_at,
  });
  expect(deleted.addresses.map((a) => a.id)).toEqual([second]);
  expect(deleted.addresses[0].is_default).toBe(false);
  expect(deleted.updated_at).not.toBe(withSecond.updated_at);
});

test('RPC 独立拒绝普通用户及身份/默认字段注入，失败创建原子回滚', async () => {
  const customer = await read(buyer.customerId),
    id = crypto.randomUUID();
  for (const token of [undefined, buyer.token]) {
    for (const [name, args] of [
      [
        'update_customer',
        {
          customer_id: customer.id,
          expected_updated_at: customer.updated_at,
          changes: { full_name: 'Denied' },
        },
      ],
      ['create_customer_address', { customer_id: customer.id, address_id: id, changes: address }],
      [
        'update_customer_address',
        { customer_id: customer.id, address_id: id, expected_updated_at: customer.updated_at, changes: {} },
      ],
      [
        'delete_customer_address',
        { customer_id: customer.id, address_id: id, expected_updated_at: customer.updated_at },
      ],
    ] as const)
      expect((await rpc(name, args, token)).data).toMatchObject({ code: '42501' });
  }
  for (const changes of [
    { auth_user_id: admin.userId },
    { anonymized_at: null },
    { full_name: null },
    { phone: 123 },
    { email: false },
  ]) {
    expect(
      (
        await rpc(
          'update_customer',
          { customer_id: customer.id, expected_updated_at: customer.updated_at, changes },
          admin.token,
        )
      ).data,
    ).toMatchObject({ code: '22023' });
  }
  for (const extra of [
    { is_default: true },
    { customer_id: admin.customerId },
    { city: 123 },
    { label: null },
  ]) {
    expect(
      (
        await rpc(
          'create_customer_address',
          { customer_id: customer.id, address_id: id, changes: { ...address, ...extra } },
          admin.token,
        )
      ).data,
    ).toMatchObject({ code: '22023' });
    expect(await read(customer.id)).toEqual(customer);
  }
});

test('并发资料更新只允许一个成功；匿名化持锁时快速拒绝，完成后不能恢复资料或地址', async () => {
  const customer = await create();
  const results = await Promise.all(
    ['First', 'Second'].map((full_name) =>
      rpc(
        'update_customer',
        {
          customer_id: customer.id,
          expected_updated_at: customer.updated_at,
          changes: { full_name },
        },
        admin.token,
      ),
    ),
  );
  expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  expect(['PT409', '55P03']).toContain(
    (results.find((r) => r.status !== 200)!.data as { code: string }).code,
  );
  const winner = await read(customer.id);
  expect(winner.full_name).toBe(results[0].status === 200 ? 'First' : 'Second');
  const edit = {
    customer_id: customer.id,
    expected_updated_at: winner.updated_at,
    changes: { full_name: 'Restored' },
  };
  const insert = { customer_id: customer.id, address_id: crypto.randomUUID(), changes: address };
  await db.begin(async (sql) => {
    await sql`set local statement_timeout='10s'`;
    await sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: admin.userId, role: 'authenticated' })}, true)`;
    await sql`select public.anonymize_customer(${customer.id}::uuid)`;
    for (const [name, args] of [
      ['update_customer', edit],
      ['create_customer_address', insert],
    ] as const)
      expect((await rpc(name, args, admin.token)).data).toMatchObject({ code: '55P03' });
  });
  expect((await rpc('update_customer', edit, admin.token)).data).toMatchObject({ code: 'PT409' });
  expect((await rpc('create_customer_address', insert, admin.token)).data).toMatchObject({ code: 'PT404' });
  expect(await read(customer.id)).toMatchObject({ full_name: '', email: null, phone: null, addresses: [] });
});
