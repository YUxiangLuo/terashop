import { afterAll, beforeAll, expect, test } from 'bun:test';
import { AdminBackend } from '../mcp/src/backend';
import { API, ANON_KEY, checked, rpc, signup, makeAdmin, type TestUser } from './helpers';
import { mcpSession, toolData } from './support/mcp';

let admin: TestUser, buyer: TestUser, second: TestUser;
let session: Awaited<ReturnType<typeof mcpSession>>;
const marker = crypto.randomUUID();
interface User {
  user_id: string;
  customer_id: string | null;
  role: string;
  email: string;
  customer_anonymized_at: string | null;
}
interface Page {
  items: User[];
  next_cursor: string | null;
}
beforeAll(async () => {
  admin = await signup(`a_${marker}@test.com`);
  buyer = await signup(`b_${marker}@test.com`);
  second = await signup(`c_${marker}@test.com`);
  await makeAdmin(admin.userId);
  session = await mcpSession(
    new AdminBackend({ url: API, anonKey: ANON_KEY, accessToken: admin.token }),
    true,
  );
});
afterAll(async () => {
  await session?.close();
});
const get = (user_id: string) => toolData<User | null>(session.client, 'get_admin_user', { user_id });

test('账户分页和角色/邮箱 AND 筛选，Auth 与 Customer ID 明确分开且 DTO 不扩张', async () => {
  const first = await toolData<Page>(session.client, 'list_admin_users', {
    search: ` ${marker.toUpperCase()} `,
    page_size: 2,
  });
  const last = await toolData<Page>(session.client, 'list_admin_users', {
    search: marker,
    page_size: 2,
    after_id: first.next_cursor,
  });
  expect([...first.items, ...last.items].map((u) => u.user_id)).toEqual(
    [admin.userId, buyer.userId, second.userId].sort(),
  );
  expect(last.next_cursor).toBeNull();
  expect(Object.keys(first.items[0]).sort()).toEqual(
    ['user_id', 'email', 'role', 'created_at', 'updated_at', 'customer_id', 'customer_anonymized_at'].sort(),
  );
  expect(
    (
      await toolData<Page>(session.client, 'list_admin_users', { search: marker, role_filter: 'admin' })
    ).items.map((u) => u.user_id),
  ).toEqual([admin.userId]);
  expect(
    (await toolData<Page>(session.client, 'list_admin_users', { search: buyer.email, role_filter: 'admin' }))
      .items,
  ).toEqual([]);
  expect((await toolData<Page>(session.client, 'list_admin_users', { search: `${marker}%` })).items).toEqual(
    [],
  );
  expect(await get(buyer.userId)).toMatchObject({
    user_id: buyer.userId,
    customer_id: buyer.customerId,
    email: buyer.email,
    role: 'customer',
    customer_anonymized_at: null,
  });
  expect(await get(buyer.customerId)).toBeNull();
  expect(await get(crypto.randomUUID())).toBeNull();
  expect(
    await checked<User | null>(rpc('get_admin_user', { user_id: buyer.userId }, undefined, true)),
  ).toEqual(await get(buyer.userId));
});

test('读身份再提升/降级，撤权后旧 MCP 会话立即拒绝查询；匿名化不等于删除 Auth', async () => {
  expect((await get(second.userId))!.role).toBe('customer');
  const changed = await toolData<{ id: string; role: string; email: string }>(
    session.client,
    'set_user_role',
    { user_id: second.userId, role: 'admin' },
  );
  expect(changed).toMatchObject({ id: second.userId, role: 'admin', email: second.email });
  expect(Object.keys(changed).sort()).toEqual(['id', 'email', 'role', 'created_at', 'updated_at'].sort());
  const promoted = await mcpSession(
    new AdminBackend({ url: API, anonKey: ANON_KEY, accessToken: second.token }),
  );
  try {
    expect(await toolData<User>(promoted.client, 'get_admin_user', { user_id: second.userId })).toMatchObject(
      { role: 'admin' },
    );
    await toolData(session.client, 'set_user_role', { user_id: second.userId, role: 'customer' });
    const denied = await promoted.client.callTool({ name: 'list_admin_users', arguments: {} });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).toContain('ADMIN_REQUIRED');
    expect((await rpc('get_admin_user', { user_id: admin.userId }, second.token)).data).toMatchObject({
      code: '42501',
    });
  } finally {
    await promoted.close();
  }
  const result = await toolData<{ id: string; email: string; role: string }>(
    session.client,
    'anonymize_user',
    { p_user_id: second.userId },
  );
  expect(result).toMatchObject({ id: second.userId, email: '', role: 'customer' });
  expect(Object.keys(result).sort()).toEqual(['id', 'email', 'role', 'created_at', 'updated_at'].sort());
  const anonymized = (await get(second.userId))!;
  expect(anonymized).toMatchObject({
    user_id: second.userId,
    role: 'customer',
    email: '',
    customer_id: second.customerId,
  });
  expect(anonymized.customer_anonymized_at).not.toBeNull();
});

test('管理员查询不允许普通客户读自己或他人，RPC 独立校验输入', async () => {
  for (const token of [undefined, buyer.token]) {
    expect((await rpc('list_admin_users', {}, token)).data).toMatchObject({ code: '42501' });
    expect((await rpc('get_admin_user', { user_id: buyer.userId }, token)).data).toMatchObject({
      code: '42501',
    });
  }
  for (const args of [
    { page_size: 0 },
    { page_size: 101 },
    { page_size: null },
    { role_filter: 'owner' },
    { search: 'x'.repeat(201) },
  ])
    expect((await rpc('list_admin_users', args, admin.token)).data).toMatchObject({ code: '22023' });
  expect((await rpc('get_admin_user', { user_id: null }, admin.token)).data).toMatchObject({ code: '22023' });
});
