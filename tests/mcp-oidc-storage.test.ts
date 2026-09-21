import { afterAll, beforeAll, expect, test } from 'bun:test';
import { SQL } from 'bun';
import postgres from 'postgres';
import { createOidcAdapter } from '../mcp/src/oidc-adapter';
import { heldTransactionRace, testDatabase } from './database-concurrency';
import { verifyOAuthProvider } from './support/oauth-provider-compat';

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

test('real provider opaque token protocol works with durable adapter', async () => {
  await verifyOAuthProvider('opaque', Adapter);
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
