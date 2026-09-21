import { afterAll, beforeAll, expect, test } from 'bun:test';
import { checked, command, rpc, signup, makeAdmin, type TestUser } from './helpers';
import { testDatabase, heldTransactionRace, staleAfterCommit } from './database-concurrency';

const db = testDatabase();
const bindings: Record<string, string>[] = [];
let admin: TestUser, other: TestUser, customer: TestUser;
interface Grant {
  id: string;
  user_id: string;
  scopes: string[];
  state: string;
  version: number;
}
beforeAll(async () => {
  admin = await signup();
  other = await signup();
  customer = await signup();
  await makeAdmin(admin.userId);
  await makeAdmin(other.userId);
});
afterAll(async () => {
  try {
    for (const binding of bindings)
      await db`delete from private.mcp_grants where binding=${JSON.stringify(binding)}::text::jsonb`;
  } finally {
    await db.close();
  }
});
function binding() {
  const value = {
    issuer: 'https://auth.example/realm',
    subject: 'upstream-a',
    client_id: 'agent-a',
    resource: 'https://shop.example/mcp',
    project: 'local-test',
    session_id: crypto.randomUUID(),
  };
  bindings.push(value);
  return value;
}
function call(action: string, identity: Record<string, string>, extra: Record<string, unknown> = {}) {
  return rpc('mcp_grant_command', { p_action: action, p_binding: identity, ...extra }, undefined, true);
}
function create(identity: Record<string, string>, userId = admin.userId, scopes = ['store:read']) {
  return checked<Grant>(
    command(
      'mcp_grant_command',
      { p_action: 'create', p_binding: identity, p_user_id: userId, p_scopes: scopes },
      undefined,
      true,
    ),
  );
}

test('grant creation is service-only, strict and does not expose the private table', async () => {
  const identity = binding();
  const args = { p_action: 'create', p_binding: identity, p_user_id: admin.userId, p_scopes: ['store:read'] };
  for (const token of [undefined, admin.token, customer.token]) {
    expect((await rpc('mcp_grant_command', args, token)).data).toMatchObject({ code: '42501' });
  }
  for (const invalid of [
    null,
    [],
    { ...identity, access_token: 'not-accepted' },
    { ...identity, subject: null },
    { ...identity, subject: '' },
    { ...identity, resource: 'a'.repeat(1801) },
    { issuer: identity.issuer },
  ]) {
    expect(
      (await rpc('mcp_grant_command', { ...args, p_binding: invalid }, undefined, true)).data,
    ).toMatchObject({ code: '22023' });
  }
  for (const p_scopes of [null, ['store:root'], [null]]) {
    expect((await rpc('mcp_grant_command', { ...args, p_scopes }, undefined, true)).data).toMatchObject({
      code: '22023',
    });
  }
  expect(
    (await call('create', identity, { p_user_id: customer.userId, p_scopes: ['store:read'] })).data,
  ).toMatchObject({ code: '42501' });
  const [row] =
    await db`select count(*)::int as count from private.mcp_grants where binding=${JSON.stringify(identity)}::text::jsonb`;
  expect(row.count).toBe(0);
  for (const role of ['anon', 'authenticated', 'service_role']) {
    const [privilege] =
      await db`select has_table_privilege(${role},'private.mcp_grants','SELECT,INSERT,UPDATE,DELETE') as allowed`;
    expect(privilege.allowed).toBe(false);
  }
});

test('immutable approvals survive new connections; revocation is terminal and idempotent', async () => {
  const identity = binding();
  const grant = await create(identity, admin.userId, ['store:write', 'store:read']);
  expect(grant).toEqual({
    id: expect.any(String),
    user_id: admin.userId,
    scopes: ['store:read', 'store:write'],
    state: 'active',
    version: 1,
  });
  expect(await create(identity, admin.userId, ['store:read', 'store:write'])).toEqual(grant);
  for (const extra of [
    { p_user_id: other.userId, p_scopes: grant.scopes },
    { p_user_id: admin.userId, p_scopes: ['store:read'] },
    { p_user_id: admin.userId, p_scopes: [...grant.scopes, 'store:payments'] },
  ]) {
    expect((await call('create', identity, extra)).data).toMatchObject({ code: 'PT409' });
  }
  const reconnected = testDatabase();
  try {
    const [persisted] =
      await reconnected`select id, user_id from private.mcp_grants where binding=${JSON.stringify(identity)}::text::jsonb`;
    expect(persisted).toEqual({ id: grant.id, user_id: admin.userId });
  } finally {
    await reconnected.close();
  }
  expect((await call('resolve', identity)).data).toEqual(grant);
  expect((await call('revoke', identity, { p_grant_id: crypto.randomUUID() })).data).toMatchObject({
    code: 'PT404',
  });
  const revoked = await checked<Grant>(call('revoke', identity, { p_grant_id: grant.id }));
  expect(revoked).toEqual({ ...grant, state: 'revoked', version: 2 });
  expect((await call('revoke', identity, { p_grant_id: grant.id })).data).toEqual(revoked);
  expect((await call('resolve', identity)).data).toMatchObject({ code: '42501' });
  expect(
    (await call('create', identity, { p_user_id: admin.userId, p_scopes: grant.scopes })).data,
  ).toMatchObject({ code: 'PT409' });
});

test('every identity dimension isolates grants and role removal denies resolution but not revocation', async () => {
  const identity = binding();
  const grant = await create(identity);
  for (const key of Object.keys(identity)) {
    const changed = { ...identity, [key]: `${identity[key as keyof typeof identity]}-other` };
    bindings.push(changed);
    expect((await call('resolve', changed)).data).toMatchObject({ code: 'PT404' });
    const distinct = await create(changed, other.userId);
    expect(distinct.id).not.toBe(grant.id);
    expect((await call('revoke', changed, { p_grant_id: grant.id })).data).toMatchObject({ code: 'PT404' });
    expect((await call('resolve', changed)).data).toEqual(distinct);
  }
  const demoted = await signup();
  await makeAdmin(demoted.userId);
  const ownBinding = binding();
  const own = await create(ownBinding, demoted.userId);
  await db`update public.profiles set role='customer' where id=${demoted.userId}::uuid`;
  expect((await call('resolve', ownBinding)).data).toMatchObject({ code: '42501' });
  expect((await call('revoke', ownBinding, { p_grant_id: own.id })).data).toMatchObject({ state: 'revoked' });
  expect((await call('resolve', identity)).data).toEqual(grant);
});

test('concurrent creation deduplicates; revocation blocks replay and stale snapshot resolution', async () => {
  const identity = binding();
  const raced = await heldTransactionRace(
    db,
    async (sql) => {
      await sql`select set_config('request.jwt.claims','{"role":"service_role"}',true)`;
      await sql`select public.mcp_grant_command('create',${JSON.stringify(identity)}::text::jsonb,${admin.userId}::uuid,array['store:read'])`;
    },
    () => create(identity),
  );
  expect((await call('resolve', identity)).data).toEqual(raced);
  const [count] =
    await db`select count(*)::int as count from private.mcp_grants where binding=${JSON.stringify(identity)}::text::jsonb`;
  expect(count.count).toBe(1);
  const replay = await heldTransactionRace(
    db,
    async (sql) => {
      await sql`select set_config('request.jwt.claims','{"role":"service_role"}',true)`;
      await sql`select public.mcp_grant_command('revoke',${JSON.stringify(identity)}::text::jsonb,null,null,${raced.id}::uuid)`;
    },
    () => call('create', identity, { p_user_id: admin.userId, p_scopes: ['store:read'] }),
  );
  expect(replay.data).toMatchObject({ code: 'PT409' });
  for (const isolation of ['read committed', 'repeatable read'] as const) {
    const current = binding();
    const grant = await create(current);
    const stale = await staleAfterCommit(
      db,
      async (sql) => {
        await sql`select set_config('request.jwt.claims','{"role":"service_role"}',true)`;
        return sql`select public.mcp_grant_command('resolve',${JSON.stringify(current)}::text::jsonb)`;
      },
      () => checked(call('revoke', current, { p_grant_id: grant.id })),
      isolation,
    );
    expect(stale.error).toMatchObject({ errno: isolation === 'repeatable read' ? '40001' : '42501' });
  }
});
