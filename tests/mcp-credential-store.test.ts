import { afterAll, beforeAll, expect, test } from 'bun:test';
import { api, checked, rpc, signup, makeAdmin, type TestUser } from './helpers';
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
async function fixture(bindSession = true) {
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
  const login = await checked<{ access_token: string }>(
    api('/auth/v1/token?grant_type=password', {
      method: 'POST',
      body: { email: admin.email, password: 'password123' },
    }),
  );
  const session = await checked<{ user_id: string; session_id: string }>(
    rpc('get_mcp_downstream_session', {}, login.access_token),
  );
  if (bindSession)
    await checked(
      rpc(
        'mcp_bind_downstream_session',
        {
          ...args,
          p_session_id: session.session_id,
        },
        undefined,
        true,
      ),
    );
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
  return { binding, grant, args, seal, read, write, revoke, session, token: login.access_token };
}

test('unbound credentials and deleted sessions fail closed without releasing ownership', async () => {
  const f = await fixture(false);
  expect((await f.read()).data).toEqual({ revision: 0, envelope: null });
  expect((await f.write(0, await f.seal(1))).data).toMatchObject({ code: '42501' });
  await checked(
    rpc('mcp_bind_downstream_session', { ...f.args, p_session_id: f.session.session_id }, undefined, true),
  );
  await checked(f.write(0, await f.seal(1)));
  const receipt = await checked<{ refresh_id: string }>(
    rpc(
      'mcp_credential_command',
      {
        ...f.args,
        p_action: 'claim_refresh',
        p_expected_revision: 1,
      },
      undefined,
      true,
    ),
  );
  await db`delete from auth.sessions where id=${f.session.session_id}::uuid`;
  expect((await rpc('get_mcp_downstream_session', {}, f.token)).data).toMatchObject({ code: '42501' });
  expect((await f.read()).data).toMatchObject({ code: '42501' });
  expect((await f.write(1, await f.seal(2))).data).toMatchObject({ code: '42501' });
  for (const action of ['claim_refresh', 'complete_refresh']) {
    expect(
      (
        await rpc(
          'mcp_credential_command',
          {
            ...f.args,
            p_action: action,
            p_expected_revision: 1,
            ...(action === 'complete_refresh'
              ? { p_refresh_id: receipt.refresh_id, p_envelope: await f.seal(2) }
              : {}),
          },
          undefined,
          true,
        )
      ).data,
    ).toMatchObject({ code: '42501' });
  }
  await checked(f.revoke());
});

test('session deletion defeats stale credential reads in RC and RR transactions', async () => {
  for (const isolation of ['read committed', 'repeatable read'] as const) {
    const f = await fixture();
    await checked(f.write(0, await f.seal(1)));
    const stale = await staleAfterCommit(
      db,
      async (sql) => {
        await sql`select set_config('request.jwt.claims','{"role":"service_role"}',true)`;
        return sql`select public.mcp_credential_command('read',${JSON.stringify(f.binding)}::text::jsonb,${f.grant.id}::uuid,${admin.userId}::uuid)`;
      },
      () => db`delete from auth.sessions where id=${f.session.session_id}::uuid`,
      isolation,
    );
    expect(stale.error).toMatchObject({ errno: isolation === 'repeatable read' ? '40001' : '42501' });
  }
});

test('session identity requires a verified administrator user token, not service or caller claims', async () => {
  const f = await fixture();
  expect((await rpc('get_mcp_downstream_session', {}, f.token)).data).toEqual(f.session);
  expect(f.session.user_id).toBe(admin.userId);
  for (const service of [false, true])
    expect((await rpc('get_mcp_downstream_session', {}, undefined, service)).data).toMatchObject({
      code: '42501',
    });
  const customer = await signup();
  expect((await rpc('get_mcp_downstream_session', {}, customer.token)).data).toMatchObject({ code: '42501' });
  const parts = f.token.split('.');
  parts[1] = Buffer.from(
    JSON.stringify({
      ...JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()),
      session_id: crypto.randomUUID(),
    }),
  ).toString('base64url');
  expect((await rpc('get_mcp_downstream_session', {}, parts.join('.'))).status).toBe(401);
});

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

test('refresh admission is single-use, durable and only its receipt can complete the next revision', async () => {
  const f = await fixture();
  const call = (action: string, extra: Record<string, unknown> = {}) =>
    rpc(
      'mcp_credential_command',
      {
        ...f.args,
        p_action: action,
        p_expected_revision: 1,
        ...extra,
      },
      undefined,
      true,
    );
  expect((await call('claim_refresh')).data).toMatchObject({ code: 'PT409' });
  const first = await f.seal(1);
  await checked(f.write(0, first));
  const receipt = await checked<{ revision: number; envelope: CredentialEnvelope; refresh_id: string }>(
    call('claim_refresh'),
  );
  expect(receipt).toEqual({ revision: 1, envelope: first, refresh_id: expect.any(String) });
  const reconnected = testDatabase();
  try {
    const [row] =
      await reconnected`select refresh_id from private.mcp_credentials where grant_id=${f.grant.id}::uuid`;
    expect(row.refresh_id).toBe(receipt.refresh_id);
  } finally {
    await reconnected.close();
  }
  expect((await call('claim_refresh')).data).toMatchObject({ code: 'PT409' });
  expect((await f.read()).data).toMatchObject({ code: 'PT409' });
  const second = await f.seal(2);
  expect((await f.write(1, second)).data).toMatchObject({ code: 'PT409' });
  expect((await call('complete_refresh', { p_envelope: second })).data).toMatchObject({ code: '22023' });
  expect(
    (await call('complete_refresh', { p_envelope: second, p_refresh_id: crypto.randomUUID() })).data,
  ).toMatchObject({ code: 'PT409' });
  const completion = { p_envelope: second, p_refresh_id: receipt.refresh_id };
  expect((await call('complete_refresh', { ...completion, p_expected_revision: 0 })).data).toMatchObject({
    code: 'PT409',
  });
  expect((await call('complete_refresh', completion)).data).toEqual({ revision: 2, envelope: second });
  expect((await call('complete_refresh', completion)).data).toMatchObject({ code: 'PT409' });
  expect((await f.read()).data).toEqual({ revision: 2, envelope: second });
  const next = await checked<{ refresh_id: string }>(call('claim_refresh', { p_expected_revision: 2 }));
  expect(next.refresh_id).not.toBe(receipt.refresh_id);
  await checked(f.revoke());
  expect(
    (
      await call('complete_refresh', {
        p_expected_revision: 2,
        p_envelope: await f.seal(3),
        p_refresh_id: next.refresh_id,
      })
    ).data,
  ).toMatchObject({ code: '42501' });
});

test('refresh contenders and stale readers cannot reuse an admitted credential', async () => {
  const f = await fixture();
  await checked(f.write(0, await f.seal(1)));
  const claim = () =>
    rpc(
      'mcp_credential_command',
      { ...f.args, p_action: 'claim_refresh', p_expected_revision: 1 },
      undefined,
      true,
    );
  const contender = await heldTransactionRace(
    db,
    async (sql) => {
      await sql`select set_config('request.jwt.claims','{"role":"service_role"}',true)`;
      await sql`select public.mcp_credential_command('claim_refresh',${JSON.stringify(f.binding)}::text::jsonb,${f.grant.id}::uuid,${admin.userId}::uuid,1)`;
    },
    claim,
  );
  expect(contender.data).toMatchObject({ code: 'PT409' });
  for (const isolation of ['read committed', 'repeatable read'] as const) {
    const other = await fixture();
    await checked(other.write(0, await other.seal(1)));
    const stale = await staleAfterCommit(
      db,
      async (sql) => {
        await sql`select set_config('request.jwt.claims','{"role":"service_role"}',true)`;
        return sql`select public.mcp_credential_command('read',${JSON.stringify(other.binding)}::text::jsonb,${other.grant.id}::uuid,${admin.userId}::uuid)`;
      },
      () =>
        checked(
          rpc(
            'mcp_credential_command',
            { ...other.args, p_action: 'claim_refresh', p_expected_revision: 1 },
            undefined,
            true,
          ),
        ),
      isolation,
    );
    expect(stale.error).toMatchObject({ errno: isolation === 'repeatable read' ? '40001' : 'PT409' });
  }
});

test('refresh receipts cannot be supplied on ordinary operations or moved to another grant', async () => {
  const a = await fixture(),
    b = await fixture();
  const call = (args: typeof a.args, action: string, extra: Record<string, unknown> = {}) =>
    rpc(
      'mcp_credential_command',
      {
        ...args,
        p_action: action,
        p_expected_revision: 1,
        ...extra,
      },
      undefined,
      true,
    );
  for (const f of [a, b]) await checked(f.write(0, await f.seal(1)));
  const receipt = await checked<{ refresh_id: string }>(call(a.args, 'claim_refresh'));
  await checked(call(b.args, 'claim_refresh'));
  expect(
    (
      await call(b.args, 'complete_refresh', {
        p_refresh_id: receipt.refresh_id,
        p_envelope: await b.seal(2),
      })
    ).data,
  ).toMatchObject({ code: 'PT409' });
  expect((await call(a.args, 'claim_refresh', { p_refresh_id: receipt.refresh_id })).data).toMatchObject({
    code: '22023',
  });
  expect(
    (await call(a.args, 'write', { p_refresh_id: receipt.refresh_id, p_envelope: await a.seal(2) })).data,
  ).toMatchObject({ code: '22023' });
  expect(
    (
      await rpc(
        'mcp_credential_command',
        { ...a.args, p_action: 'claim_refresh', p_expected_revision: 1 },
        admin.token,
      )
    ).data,
  ).toMatchObject({ code: '42501' });
});
