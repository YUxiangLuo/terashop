import { afterAll, beforeAll, expect, test } from 'bun:test';
import { checked, rpc, signup, makeAdmin, type TestUser } from './helpers';
import { testDatabase, heldTransactionRace, staleAfterCommit } from './database-concurrency';
import { createCredentialCipher, type CredentialEnvelope } from '../mcp/src/credentials';

const db = testDatabase();
const project = `credential-test-${crypto.randomUUID()}`;
let admin: TestUser;
const cipher = await createCredentialCipher(
  new Map([['test', crypto.getRandomValues(new Uint8Array(32))]]),
  'test',
);
const secret = { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresAt: 1700000000 };
beforeAll(async () => {
  admin = await signup();
  await makeAdmin(admin.userId);
});
afterAll(async () => {
  try {
    await db`delete from private.mcp_grants where binding->>'project'=${project}`;
  } finally {
    await db.close();
  }
});
async function fixture() {
  const binding = {
    issuer: 'https://auth.example',
    subject: 'a',
    client_id: 'client',
    resource: 'https://shop.example/mcp',
    project,
    session_id: crypto.randomUUID(),
  };
  const grant = await checked<{ id: string }>(
    rpc(
      'mcp_grant_command',
      {
        p_action: 'create',
        p_binding: binding,
        p_user_id: admin.userId,
        p_scopes: ['store:read'],
      },
      undefined,
      true,
    ),
  );
  const args = { p_binding: binding, p_grant_id: grant.id, p_user_id: admin.userId };
  const seal = (revision: number) =>
    cipher.seal({ project, grantId: grant.id, userId: admin.userId, revision }, secret);
  const read = () => rpc('mcp_credential_command', { ...args, p_action: 'read' }, undefined, true);
  const write = (revision: number, envelope: unknown) =>
    rpc(
      'mcp_credential_command',
      {
        ...args,
        p_action: 'write',
        p_expected_revision: revision,
        p_envelope: envelope,
      },
      undefined,
      true,
    );
  const revoke = () =>
    rpc(
      'mcp_grant_command',
      { p_action: 'revoke', p_binding: binding, p_grant_id: grant.id },
      undefined,
      true,
    );
  return { binding, grant, args, seal, read, write, revoke };
}

test('credential store is service-only and rejects malformed envelopes and identity substitution', async () => {
  const f = await fixture();
  for (const token of [undefined, admin.token])
    expect((await rpc('mcp_credential_command', { ...f.args, p_action: 'read' }, token)).data).toMatchObject({
      code: '42501',
    });
  for (const role of ['anon', 'authenticated', 'service_role']) {
    const [row] =
      await db`select has_table_privilege(${role},'private.mcp_credentials','SELECT,INSERT,UPDATE,DELETE') as allowed`;
    expect(row.allowed).toBe(false);
  }
  const envelope = await f.seal(1);
  for (const invalid of [
    null,
    [],
    { ...envelope, refreshToken: 'plaintext' },
    { ...envelope, version: '1' },
    { ...envelope, keyId: null },
    { ...envelope, iv: 'bad' },
    { ...envelope, ciphertext: 'x'.repeat(65537) },
  ])
    expect((await f.write(0, invalid)).data).toMatchObject({ code: '22023' });
  for (const revision of [-1, null, 9007199254740991])
    expect(
      (
        await rpc(
          'mcp_credential_command',
          { ...f.args, p_action: 'write', p_expected_revision: revision, p_envelope: envelope },
          undefined,
          true,
        )
      ).data,
    ).toMatchObject({ code: '22023' });
  for (const change of [
    { p_user_id: crypto.randomUUID() },
    { p_grant_id: crypto.randomUUID() },
    { p_binding: { ...f.binding, client_id: 'other' } },
  ])
    expect(
      (await rpc('mcp_credential_command', { ...f.args, ...change, p_action: 'read' }, undefined, true)).data,
    ).toMatchObject({ code: 'PT404' });
  expect((await f.read()).data).toEqual({ revision: 0, envelope: null });
});

test('CAS advances revisions, persists decryptable envelopes, rejects replay, and revocation erases ciphertext', async () => {
  const f = await fixture();
  const first = await f.seal(1);
  expect((await f.write(0, first)).data).toEqual({ revision: 1, envelope: first });
  expect((await f.write(0, first)).data).toMatchObject({ code: 'PT409' });
  const second = await f.seal(2);
  expect((await f.write(1, second)).data).toEqual({ revision: 2, envelope: second });
  const reconnected = testDatabase();
  try {
    const [stored] =
      await reconnected`select revision::int,envelope from private.mcp_credentials where grant_id=${f.grant.id}::uuid`;
    expect(stored).toEqual({ revision: 2, envelope: second });
  } finally {
    await reconnected.close();
  }
  const stored = await checked<{ revision: number; envelope: CredentialEnvelope }>(f.read());
  expect(
    await cipher.open(
      { project, grantId: f.grant.id, userId: admin.userId, revision: stored.revision },
      stored.envelope,
    ),
  ).toEqual(secret);
  await expect(
    cipher.open({ project, grantId: f.grant.id, userId: admin.userId, revision: stored.revision }, first),
  ).rejects.toThrow('CREDENTIAL_DECRYPTION_FAILED');
  await checked(f.revoke());
  await checked(f.revoke());
  expect((await f.read()).data).toMatchObject({ code: '42501' });
  expect((await f.write(2, await f.seal(3))).data).toMatchObject({ code: '42501' });
  const [row] =
    await db`select count(*)::int as count from private.mcp_credentials where grant_id=${f.grant.id}::uuid`;
  expect(row.count).toBe(0);
  const [tombstone] = await db`select state from private.mcp_grants where id=${f.grant.id}::uuid`;
  expect(tombstone.state).toBe('revoked');
});

test('concurrent first writers serialize; stale revision and revoke/write races fail closed', async () => {
  const f = await fixture();
  const first = await f.seal(1);
  const raced = await heldTransactionRace(
    db,
    async (sql) => {
      await sql`select set_config('request.jwt.claims','{"role":"service_role"}',true)`;
      await sql`select public.mcp_credential_command('write',${JSON.stringify(f.binding)}::text::jsonb,${f.grant.id}::uuid,${admin.userId}::uuid,0,${JSON.stringify(first)}::text::jsonb)`;
    },
    () => f.write(0, first),
  );
  expect(raced.data).toMatchObject({ code: 'PT409' });
  const second = await f.seal(2);
  const stale = await staleAfterCommit(
    db,
    async (sql) => {
      await sql`select set_config('request.jwt.claims','{"role":"service_role"}',true)`;
      return sql`select public.mcp_credential_command('read',${JSON.stringify(f.binding)}::text::jsonb,${f.grant.id}::uuid,${admin.userId}::uuid)`;
    },
    () => checked(f.write(1, second)),
  );
  expect(stale.error).toMatchObject({ errno: '40001' });
  const revoked = await heldTransactionRace(
    db,
    async (sql) => {
      await sql`select set_config('request.jwt.claims','{"role":"service_role"}',true)`;
      await sql`select public.mcp_grant_command('revoke',${JSON.stringify(f.binding)}::text::jsonb,null,null,${f.grant.id}::uuid)`;
    },
    () => f.write(2, second),
  );
  expect(revoked.data).toMatchObject({ code: '42501' });

  const other = await fixture();
  const winningWrite = await other.seal(1);
  const revokeAfterWrite = await heldTransactionRace(
    db,
    async (sql) => {
      await sql`select set_config('request.jwt.claims','{"role":"service_role"}',true)`;
      await sql`select public.mcp_credential_command('write',${JSON.stringify(other.binding)}::text::jsonb,${other.grant.id}::uuid,${admin.userId}::uuid,0,${JSON.stringify(winningWrite)}::text::jsonb)`;
    },
    () => other.revoke(),
  );
  expect(revokeAfterWrite.data).toMatchObject({ state: 'revoked' });
  const [erased] =
    await db`select count(*)::int as count from private.mcp_credentials where grant_id=${other.grant.id}::uuid`;
  expect(erased.count).toBe(0);
});

test('role removal denies reads and writes but still permits erasure via revoke', async () => {
  const f = await fixture();
  await checked(f.write(0, await f.seal(1)));
  await db`update public.profiles set role='customer' where id=${admin.userId}::uuid`;
  try {
    expect((await f.read()).data).toMatchObject({ code: '42501' });
    expect((await f.write(1, await f.seal(2))).data).toMatchObject({ code: '42501' });
    await checked(f.revoke());
  } finally {
    await makeAdmin(admin.userId);
  }
});
