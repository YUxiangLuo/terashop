import { afterAll, beforeAll, expect, test } from 'bun:test';
import { api, rpc, signup, makeAdmin, TEST_ADDRESS, type TestUser } from './helpers';
import { checked } from './payment-fixtures';
import { heldTransactionRace, testDatabase } from './database-concurrency';

const database = testDatabase();
let admin: TestUser;
beforeAll(async () => { admin = await signup(); await makeAdmin(admin.userId); });
afterAll(async () => { await database.close(); });
interface Address { id: string; is_default: boolean; recipient_name: string }
async function add(owner: TestUser, isDefault = false): Promise<Address> {
  const [row] = await checked<Address[]>(api('/rest/v1/addresses', {
    token: owner.token, method: 'POST', body: { ...TEST_ADDRESS, is_default: isDefault },
  }));
  return row;
}
function defaults(owner: TestUser): Promise<Address[]> {
  return checked(api('/rest/v1/addresses?is_default=eq.true&select=id,is_default,recipient_name', { token: owner.token }));
}

test('既有地址只能经 RPC 切换默认；客户/admin 的列权限和 service trigger 均限制 PATCH', async () => {
  const owner = await signup();
  const first = await add(owner, true);
  const second = await add(owner);
  for (const token of [owner.token, admin.token]) {
    expect((await api(`/rest/v1/addresses?id=eq.${second.id}`, {
      token, method: 'PATCH', body: { is_default: true },
    })).status).toBe(403);
  }
  const direct = await api(`/rest/v1/addresses?id=eq.${second.id}`, {
    service: true, method: 'PATCH', body: { is_default: true },
  });
  expect(direct.status).toBe(400);
  expect(direct.data).toMatchObject({ message: expect.stringContaining('set_default_address') });
  const updated = await checked<Address>(rpc('set_default_address', { address_id: second.id }, owner.token));
  expect(updated).toMatchObject({ id: second.id, is_default: true });
  expect((await defaults(owner)).map(row => row.id)).toEqual([second.id]);
  const repeated = await checked<Address>(rpc('set_default_address', { address_id: second.id }, owner.token));
  expect(repeated.is_default).toBe(true);
  expect((await api(`/rest/v1/addresses?id=eq.${first.id}`, {
    token: owner.token, method: 'PATCH', body: { recipient_name: 'edited', country: 'us' },
  })).status).toBe(200);
});

test('默认地址 RPC 验证归属；管理员/service 可操作，匿名和其他客户不可操作', async () => {
  const owner = await signup(); const other = await signup();
  const address = await add(owner);
  const command = { address_id: address.id };
  expect((await rpc('set_default_address', command)).status).toBe(401);
  expect((await rpc('set_default_address', command, other.token)).status).toBe(400);
  expect((await rpc('set_default_address', { address_id: crypto.randomUUID() }, owner.token)).status).toBe(400);
  expect((await rpc('set_default_address', command, admin.token)).status).toBe(200);
  expect((await rpc('set_default_address', command, undefined, true)).status).toBe(200);
});

test('并发切换多个既有地址全部完成，并发默认 INSERT 同样保持最多一个默认', async () => {
  const owner = await signup();
  const addresses = await Promise.all(Array.from({ length: 8 }, () => add(owner)));
  const results = await Promise.all(addresses.map(address => rpc('set_default_address', {
    address_id: address.id,
  }, owner.token)));
  expect(results.every(result => result.status === 200)).toBe(true);
  expect(await defaults(owner)).toHaveLength(1);
  const [switched, inserted] = await Promise.all([
    rpc('set_default_address', { address_id: addresses[0].id }, owner.token), add(owner, true),
  ]);
  expect(switched.status).toBe(200);
  expect(inserted.is_default).toBe(true);
  expect(await defaults(owner)).toHaveLength(1);
});

test('受控旧死锁交错：等待客户锁的 RPC 不持目标地址行，持锁方仍能更新它', async () => {
  const owner = await signup();
  await add(owner, true);
  const target = await add(owner);
  const key = `tera-headless:default-address:${owner.userId}`;
  const result = await heldTransactionRace(database, async transaction => {
    await transaction`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  }, () => rpc('set_default_address', { address_id: target.id }, owner.token), async transaction => {
    // With the old direct-PATCH trigger, this update and the waiting customer
    // lock formed an ABBA cycle. The command must not own target's tuple yet.
    await transaction`set local lock_timeout = '500ms'`;
    await transaction`update public.addresses set recipient_name = 'no lock inversion' where id = ${target.id}::uuid`;
  });
  expect(result.status).toBe(200);
  expect(result.data).toMatchObject({ id: target.id, recipient_name: 'no lock inversion', is_default: true });
});

test('地址身份不可转移；显式清除默认不影响其他默认，清除/删除当前默认可留下零个', async () => {
  const owner = await signup(); const other = await signup();
  const first = await add(owner, true); const second = await add(owner);
  for (const body of [{ customer_id: other.userId }, { id: crypto.randomUUID() }]) {
    expect((await api(`/rest/v1/addresses?id=eq.${first.id}`, {
      token: owner.token, method: 'PATCH', body,
    })).status).toBe(403);
    expect((await api(`/rest/v1/addresses?id=eq.${first.id}`, {
      service: true, method: 'PATCH', body,
    })).status).toBe(400);
  }
  await checked(rpc('set_default_address', { address_id: second.id, make_default: false }, owner.token));
  expect((await defaults(owner)).map(row => row.id)).toEqual([first.id]);
  await checked(rpc('set_default_address', { address_id: first.id, make_default: false }, owner.token));
  expect(await defaults(owner)).toEqual([]);
  await checked(rpc('set_default_address', { address_id: first.id }, owner.token));
  await checked(api(`/rest/v1/addresses?id=eq.${first.id}`, { token: owner.token, method: 'DELETE' }));
  expect(await defaults(owner)).toEqual([]);
});

test('RPC 不遗留可供后续表写入使用的默认地址修改标记', async () => {
  const owner = await signup(); const target = await add(owner);
  await expect(database.begin(async transaction => {
    await transaction`select set_config('request.jwt.claims', ${JSON.stringify({ role: 'authenticated', sub: owner.userId })}, true)`;
    await transaction`select public.set_default_address(${target.id}::uuid)`;
    await transaction`update public.addresses set is_default = false where id = ${target.id}::uuid`;
  })).rejects.toThrow('use set_default_address');
  expect(await defaults(owner)).toEqual([]);
});
