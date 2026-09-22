import { afterAll, beforeAll, expect, test } from 'bun:test';
import { SQL } from 'bun';
import postgres from 'postgres';
import { createOidcAdapter } from '../mcp/src/oidc-adapter';
import { heldTransactionRace, testDatabase } from './database-concurrency';
import { verifyOAuthProvider } from './support/oauth-provider-compat';
import { verifyApprovalJournal } from './support/oauth-journal';
import { createOidcApprovalJournal } from '../mcp/src/oidc-journal';
import { recoverOidcApprovals } from '../mcp/src/oidc-recovery';
import { API, SERVICE_KEY, checked, rpc, signup, makeAdmin } from './helpers';

// A fresh dedicated database on the already validated disposable local cluster.
// No tables or migrations are added to the shop database.
const admin = testDatabase();
const name = `oidc_test_${crypto.randomUUID().replaceAll('-', '')}`;
let db: postgres.Sql, second: postgres.Sql, race: SQL;
let Adapter: ReturnType<typeof createOidcAdapter>;
let created = false;
let url: string;
beforeAll(async () => {
  await admin.unsafe(`create database ${name}`);
  created = true;
  const target = new URL(process.env.DB_URL!);
  target.pathname = `/${name}`;
  url = target.href;
  db = postgres(url, { max: 3 });
  second = postgres(url, { max: 3 });
  race = new SQL(url, { max: 3 });
  await db.unsafe(await Bun.file('mcp/auth/storage.sql').text());
  Adapter = createOidcAdapter(db);
});
afterAll(async () => {
  try {
    await Promise.all([db?.end(), second?.end(), race?.close()]);
    if (created) await admin.unsafe(`drop database ${name}`);
  } finally {
    await admin.close();
  }
});

test('OIDC approval journal preserves bindings, terminal states and paginated recovery work', async () => {
  await verifyApprovalJournal(db);
});

test('pending recovery survives lost revocation receipts, fences late writes and skips completed approvals', async () => {
  const user = await signup();
  await makeAdmin(user.userId);
  const project = `recovery-${crypto.randomUUID()}`;
  const config = {
    issuer: 'https://auth.example',
    resource: 'https://shop.example/mcp',
    project,
    supabaseUrl: API,
    serviceRoleKey: SERVICE_KEY,
  };
  const journal = createOidcApprovalJournal(db);
  const entries = Array.from({ length: 103 }, (_, i) => ({
    interactionId: `recover-${String(i).padStart(3, '0')}`,
    binding: {
      issuer: config.issuer,
      resource: config.resource,
      project,
      subject: user.userId,
      client_id: 'agent',
      session_id: crypto.randomUUID(),
    },
  }));
  const first = entries[0]!,
    completed = entries[102]!;
  const command = (entry: typeof first, action: string) =>
    rpc(
      'mcp_grant_command',
      {
        p_action: action,
        p_binding: entry.binding,
        ...(action === 'create' ? { p_user_id: user.userId, p_scopes: ['store:read'] } : {}),
      },
      undefined,
      true,
    );
  try {
    for (const entry of entries) await journal.begin(entry);
    const grant = await checked<{ id: string }>(command(first, 'create'));
    const kept = await checked<{ id: string }>(command(completed, 'create'));
    await journal.finish(completed.interactionId, 'completed');
    await admin`insert into private.mcp_credentials(grant_id,revision,envelope) values (${grant.id}::uuid,1,'{}'::jsonb)`;
    const grants = new Adapter('Grant');
    await grants.upsert(first.binding.session_id, { accountId: user.userId }, 60);
    await grants.upsert(completed.binding.session_id, { accountId: user.userId }, 60);
    // Reject a mismatched deployment before either side is changed or contacted.
    let calls = 0;
    await expect(
      recoverOidcApprovals(db, { ...config, project: 'wrong-shop' }, async () => {
        calls++;
        throw new Error('must not send identity');
      }),
    ).rejects.toThrow(/^OIDC_RECOVERY_UNCONFIRMED$/);
    expect(calls).toBe(0);
    expect(await grants.find(first.binding.session_id)).toBeDefined();
    // Commit real downstream revocation, then lose its HTTP receipt.
    await expect(
      recoverOidcApprovals(db, config, async (url, init) => {
        calls++;
        const response = await fetch(url, init);
        expect(response.ok).toBe(true);
        await response.arrayBuffer();
        throw new Error('sensitive upstream transport detail');
      }),
    ).rejects.toThrow(/^OIDC_RECOVERY_UNCONFIRMED$/);
    expect(calls).toBe(1);
    expect((await journal.pending())[0]).toEqual(first);
    expect((await command(first, 'resolve')).data).toMatchObject({ code: '42501' });
    expect(await admin`select 1 from private.mcp_credentials where grant_id=${grant.id}::uuid`).toHaveLength(
      0,
    );
    expect(await grants.find(first.binding.session_id)).toBeUndefined();
    await expect(grants.upsert(first.binding.session_id, {}, 60)).rejects.toThrow();
    // Invalid/partial acknowledgements must never finish the journal entry.
    for (const bad of [
      { id: null, user_id: null, scopes: [], state: 'active', version: 2 },
      { id: null, user_id: user.userId, scopes: [], state: 'revoked', version: 2 },
      { id: grant.id, user_id: crypto.randomUUID(), scopes: [], state: 'revoked', version: 2 },
    ]) {
      await expect(recoverOidcApprovals(db, config, async () => Response.json(bad))).rejects.toThrow(
        /^OIDC_RECOVERY_UNCONFIRMED$/,
      );
      expect((await journal.pending())[0]).toEqual(first);
    }
    // First entry finishes; the second fails after both revocations but before
    // journal commit. A real DB write failure, not a mocked journal method.
    await db.unsafe(`create function oidc.reject_recovery_finish() returns trigger language plpgsql as $$
      begin
        if new.interaction_id='recover-001' then raise exception 'fixture interruption'; end if;
        return new;
      end; $$;
      create trigger reject_recovery_finish before update on oidc.approval_attempts
      for each row execute function oidc.reject_recovery_finish()`);
    try {
      await expect(recoverOidcApprovals(db, config)).rejects.toThrow(/^OIDC_RECOVERY_UNCONFIRMED$/);
      expect((await journal.pending())[0]).toEqual(entries[1]!);
      expect((await command(entries[1]!, 'create')).data).toMatchObject({ code: 'PT409' });
      await expect(grants.upsert(entries[1]!.binding.session_id, {}, 60)).rejects.toThrow();
    } finally {
      await db.unsafe(`drop trigger reject_recovery_finish on oidc.approval_attempts;
        drop function oidc.reject_recovery_finish()`);
    }
    // Another pool resumes remaining work across the 100-entry page boundary.
    expect(await recoverOidcApprovals(second, config)).toBe(101);
    expect(await recoverOidcApprovals(second, config)).toBe(0);
    expect(await journal.pending()).toEqual([]);
    expect((await command(completed, 'resolve')).data).toMatchObject({ id: kept.id, state: 'active' });
    expect(await grants.find(completed.binding.session_id)).toBeDefined();
    const absent = entries[101]!;
    expect((await command(absent, 'create')).data).toMatchObject({ code: 'PT409' });
    await expect(grants.upsert(absent.binding.session_id, {}, 60)).rejects.toThrow();
    await expect(
      new Adapter('AccessToken').upsert('recovery-late-token', { grantId: absent.binding.session_id }, 60),
    ).rejects.toThrow();
    const [{ count }] =
      await db`select count(*)::int as count from oidc.approval_attempts where state='revoked' and binding->>'project'=${project}`;
    expect(count).toBe(102);
  } finally {
    await admin`delete from private.mcp_grants where binding->>'project'=${project}`;
    await admin`delete from private.mcp_grant_fences where binding->>'project'=${project}`;
    await db`delete from oidc.approval_attempts where binding->>'project'=${project}`;
    await admin`delete from auth.users where id=${user.userId}::uuid`;
  }
}, 20000);

test('OIDC payloads persist across pools; secondary indexes update and TTL is enforced', async () => {
  const sessions = new Adapter('Session');
  const id = crypto.randomUUID();
  const payload = { uid: 'old-uid', accountId: 'user', extra: { nested: ['preserved', 42] } };
  await sessions.upsert(id, payload, 60);
  const reopened = postgres(url, { max: 1 });
  try {
    const Stored = createOidcAdapter(reopened);
    expect(await new Stored('Session').find(id)).toEqual(payload);
  } finally {
    await reopened.end();
  }
  expect(await sessions.findByUid('old-uid')).toEqual(payload);
  await sessions.upsert(id, { ...payload, uid: 'new-uid' }, 60);
  expect(await sessions.findByUid('old-uid')).toBeUndefined();
  expect((await sessions.findByUid('new-uid'))?.accountId).toBe('user');
  await db`update oidc.artifacts set expires_at=clock_timestamp()-interval '1 second' where id=${id}`;
  expect(await sessions.findByUid('new-uid')).toBeUndefined();
  const device = new Adapter('DeviceCode');
  await device.upsert('device', { userCode: 'old-code' }, 60);
  await device.upsert('device', { userCode: 'new-code' }, 60);
  expect(await device.findByUserCode('old-code')).toBeUndefined();
  expect(await device.findByUserCode('new-code')).toEqual({ userCode: 'new-code' });
  await device.destroy('device');
  expect(await device.findByUserCode('new-code')).toBeUndefined();
  await expect(device.upsert('device', {}, 60)).rejects.toThrow();
  const [{ allowed }] = await db`select has_schema_privilege('anon','oidc','usage') as allowed`;
  expect(allowed).toBe(false);
});

test('concurrent consumption allows one winner, revokes the family and rejects late issuance', async () => {
  for (const model of ['AuthorizationCode', 'RefreshToken']) {
    const grantId = crypto.randomUUID();
    const a = new Adapter(model);
    const Other = createOidcAdapter(second);
    const b = new Other(model);
    const id = crypto.randomUUID();
    const payload = { grantId, accountId: 'user' };
    await new Adapter('Grant').upsert(grantId, {}, 60);
    await a.upsert(id, payload, 60);
    expect(await a.find(id)).toEqual(payload);
    expect(await b.find(id)).toEqual(payload); // Both requests have the stale unconsumed view.
    const results = await Promise.allSettled([a.consume(id), b.consume(id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(failure.reason.error).toBe('invalid_grant');
    expect(await a.find(id)).toBeUndefined();
    expect(await new Adapter('Grant').find(grantId)).toBeUndefined();
    await expect(new Adapter('AccessToken').upsert(crypto.randomUUID(), { grantId }, 60)).rejects.toThrow();
    await expect(new Adapter('Grant').upsert(grantId, {}, 60)).rejects.toThrow();
  }
});

test('stale saves preserve consumption and cannot change grant membership', async () => {
  const a = new Adapter('RefreshToken');
  const id = crypto.randomUUID(),
    grantId = crypto.randomUUID();
  await a.upsert(id, { grantId }, 60);
  await a.consume(id);
  await a.upsert(id, { grantId, scope: 'store:read' }, 60);
  expect((await a.find(id))?.consumed).toBeGreaterThan(0);
  await expect(a.upsert(id, { grantId: crypto.randomUUID() }, 60)).rejects.toThrow();
  await a.destroy(id);
  await a.destroy(id);
  await expect(a.upsert(id, { grantId }, 60)).rejects.toThrow();
});

test('a writer blocked behind committed revocation cannot resurrect the grant', async () => {
  const grantId = crypto.randomUUID();
  const token = new Adapter('AccessToken');
  await new Adapter('Grant').upsert(grantId, {}, 60);
  await heldTransactionRace(
    race,
    (tx) => tx`select pg_advisory_xact_lock(1952805473,1869177955)`,
    async () => {
      await expect(token.upsert('late-token', { grantId }, 60)).rejects.toThrow();
    },
    (tx) => tx`insert into oidc.revoked_grants(id) values (${grantId})`,
  );
  expect(await token.find('late-token')).toBeUndefined();
  expect(await new Adapter('Grant').find(grantId)).toBeUndefined();
  await new Adapter('Grant').destroy(grantId);
  await Promise.all([token.revokeByGrantId(grantId), new Adapter('RefreshToken').revokeByGrantId(grantId)]);
});

test('real provider opaque protocol and concurrent HTTP exchanges work with durable adapter', async () => {
  await verifyOAuthProvider('opaque', Adapter, true);
}, 15000);

test('revocation waiting behind issuance deletes that family only, even without a Grant row', async () => {
  const revoked = crypto.randomUUID(),
    kept = crypto.randomUUID();
  const token = new Adapter('AccessToken');
  await token.upsert('kept-token', { grantId: kept, scope: 'store:read' }, 60);
  await heldTransactionRace(
    race,
    async (tx) => {
      await tx`select pg_advisory_xact_lock(1952805473,1869177955)`;
      await tx`insert into oidc.artifacts(model,id,payload,grant_id)
        values ('AccessToken','in-flight',${JSON.stringify({ grantId: revoked })}::jsonb,${revoked})`;
    },
    () => token.revokeByGrantId(revoked),
  );
  expect(await token.find('in-flight')).toBeUndefined();
  expect(await token.find('kept-token')).toEqual({ grantId: kept, scope: 'store:read' });
  await expect(token.upsert('new-revoked-token', { grantId: revoked }, 60)).rejects.toThrow();
});

test('zero TTL expires immediately; configured tolerance retains payload without changing provider exp', async () => {
  const a = new Adapter('AuthorizationCode');
  const payload = { exp: Math.floor(Date.now() / 1000), grantId: crypto.randomUUID() };
  await a.upsert('expired-code', payload, 0);
  expect(await a.find('expired-code')).toBeUndefined();
  await expect(a.consume('expired-code')).rejects.toThrow();
  const Tolerant = createOidcAdapter(db, 30);
  const tolerant = new Tolerant('AuthorizationCode');
  await tolerant.upsert('tolerated-code', payload, 0);
  expect(await tolerant.find('tolerated-code')).toEqual(payload);
});
