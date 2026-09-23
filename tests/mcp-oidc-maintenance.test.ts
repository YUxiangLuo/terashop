import { afterAll, beforeAll, expect, test } from 'bun:test';
import { SQL } from 'bun';
import postgres from 'postgres';
import { createOidcAdapter } from '../mcp/src/oidc-adapter';
import {
  cleanupExpiredOidcPayloads,
  invalidateRestoredOidcAuthorization,
  MAX_OIDC_CLEANUP_BATCH,
} from '../mcp/src/oidc-maintenance';
import { heldTransactionRace, testDatabase } from './database-concurrency';

const admin = testDatabase();
const name = `oidc_maintenance_${crypto.randomUUID().replaceAll('-', '')}`;
let db: postgres.Sql, race: SQL;
let created = false;

beforeAll(async () => {
  await admin.unsafe(`create database ${name}`);
  created = true;
  const target = new URL(process.env.DB_URL!);
  target.pathname = `/${name}`;
  // Maintenance must explicitly choose RC, even when the role defaults to RR.
  db = postgres(target.href, { max: 3, connection: { default_transaction_isolation: 'repeatable read' } });
  race = new SQL(target.href, { max: 3 });
  await db.unsafe(await Bun.file('mcp/auth/storage.sql').text());
});

afterAll(async () => {
  try {
    await Promise.all([db?.end(), race?.close()]);
    if (created) await admin.unsafe(`drop database ${name}`);
  } finally {
    await admin.close();
  }
});

test('cleanup is bounded, includes the expiry boundary, and retains safety tombstones', async () => {
  const grantId = crypto.randomUUID();
  await db`insert into oidc.revoked_grants(id) values (${grantId})`;
  await db`insert into oidc.approval_attempts(interaction_id,binding)
    values ('pending-cleanup-test','{"session_id":"pending-session"}'::jsonb)`;
  await db`insert into oidc.artifacts(model,id,payload,expires_at,grant_id,uid,user_code,consumed)
    values
      ('Session','expired-session','{"secret":"one"}'::jsonb,clock_timestamp()-interval '1 second',${grantId},'sensitive-uid',null,123),
      ('DeviceCode','boundary-device','{"secret":"two"}'::jsonb,clock_timestamp(),${grantId},null,'sensitive-code',456),
      ('AccessToken','never-expires','{"secret":"keep"}'::jsonb,null,${grantId},null,null,null),
      ('AccessToken','future','{"secret":"future"}'::jsonb,clock_timestamp()+interval '1 hour',${grantId},null,null,null)`;

  expect(await cleanupExpiredOidcPayloads(db, 1)).toBe(1);
  expect(await cleanupExpiredOidcPayloads(db, 1)).toBe(1);
  expect(await cleanupExpiredOidcPayloads(db, 1)).toBe(0);

  const scrubbed = await db`select id,payload,destroyed,grant_id,consumed,uid,user_code
    from oidc.artifacts where id in ('expired-session','boundary-device') order by id`;
  expect([...scrubbed]).toEqual([
    {
      id: 'boundary-device',
      payload: null,
      destroyed: true,
      grant_id: grantId,
      consumed: '456',
      uid: null,
      user_code: null,
    },
    {
      id: 'expired-session',
      payload: null,
      destroyed: true,
      grant_id: grantId,
      consumed: '123',
      uid: null,
      user_code: null,
    },
  ]);
  expect((await db`select payload from oidc.artifacts where id='never-expires'`)[0].payload).toEqual({
    secret: 'keep',
  });
  expect((await db`select payload from oidc.artifacts where id='future'`)[0].payload).toEqual({
    secret: 'future',
  });
  expect(await db`select id from oidc.revoked_grants where id=${grantId}`).toHaveLength(1);
  expect([
    ...(await db`select state from oidc.approval_attempts where interaction_id='pending-cleanup-test'`),
  ]).toEqual([{ state: 'pending' }]);
});

test('cleanup shares writer serialization and its tombstone rejects a stale upsert', async () => {
  const id = crypto.randomUUID();
  const Adapter = createOidcAdapter(db);
  const token = new Adapter('AccessToken');
  await token.upsert(id, { scope: 'sensitive' }, 60);

  const cleaned = await heldTransactionRace(
    race,
    (tx) => tx`select pg_advisory_xact_lock(1952805473,1869177955)`,
    () => cleanupExpiredOidcPayloads(db, 10),
    (tx) => tx`update oidc.artifacts set expires_at=clock_timestamp() where model='AccessToken' and id=${id}`,
  );
  expect(cleaned).toBe(1);
  await expect(token.upsert(id, { scope: 'stale-secret' }, 60)).rejects.toThrow();
  expect(await token.find(id)).toBeUndefined();
  expect(
    await db`select 1 from oidc.artifacts where model='AccessToken' and id=${id} and destroyed and payload is null`,
  ).toHaveLength(1);
});

test('cleanup rejects unbounded or malformed limits before accessing storage', async () => {
  for (const limit of [0, -1, 1.5, MAX_OIDC_CLEANUP_BATCH + 1, Number.NaN])
    await expect(cleanupExpiredOidcPayloads(db, limit)).rejects.toThrow('OIDC cleanup limit');
});

test('restore invalidation revokes every known grant and retains journals and artifact evidence', async () => {
  const grantModel = `grant-${crypto.randomUUID()}`;
  const binding = `binding-${crypto.randomUUID()}`;
  await db`insert into oidc.artifacts(model,id,payload,grant_id,uid,user_code,consumed) values
    ('Grant',${grantModel},'{"secret":"grant"}',null,null,null,11),
    ('AccessToken',${`access-${crypto.randomUUID()}`},'{"secret":"access"}',${binding},null,null,22),
    ('Session',${`session-${crypto.randomUUID()}`},'{"secret":"session"}',null,'restore-uid',null,33),
    ('DeviceCode',${`device-${crypto.randomUUID()}`},'{"secret":"device"}',null,null,'restore-code',44)`;
  await db`insert into oidc.approval_attempts(interaction_id,binding)
    values ('pending-restore-test','{"session_id":"pending-restore-session"}')`;

  expect(await invalidateRestoredOidcAuthorization(db)).toEqual({
    artifactsInvalidated: 6,
    grantsRevoked: 2,
  });
  expect(
    await db`select id from oidc.revoked_grants where id in (${grantModel},${binding}) order by id`,
  ).toHaveLength(2);
  expect(
    await db`select 1 from oidc.artifacts where not destroyed or payload is not null or uid is not null or user_code is not null`,
  ).toHaveLength(0);
  expect(
    await db`select 1 from oidc.artifacts where consumed in (11,22,33,44) and
    ((id=${grantModel}) or grant_id=${binding})`,
  ).toHaveLength(2);
  expect(
    await db`select state from oidc.approval_attempts where interaction_id='pending-restore-test'`,
  ).toHaveLength(1);
  expect(await invalidateRestoredOidcAuthorization(db)).toEqual({
    artifactsInvalidated: 0,
    grantsRevoked: 0,
  });
});

test('maintenance refuses the live issuer owner lock', async () => {
  const holder = await db.reserve();
  try {
    await holder`select pg_advisory_lock(1952805473,1869177956)`;
    await expect(invalidateRestoredOidcAuthorization(db)).rejects.toThrow('OIDC_MAINTENANCE_OWNER_LOCKED');
    await expect(cleanupExpiredOidcPayloads(db)).rejects.toThrow('OIDC_MAINTENANCE_OWNER_LOCKED');
  } finally {
    await holder`select pg_advisory_unlock(1952805473,1869177956)`;
    holder.release();
  }
});

test('invalidation rolls back revocation and payload changes together on SQL failure', async () => {
  await db`insert into oidc.artifacts(model,id,payload,grant_id)
    values ('Grant','atomic-rollback','{"secret":"keep-until-committed"}','atomic-rollback')`;
  await db.unsafe(`create function oidc.maintenance_fixture_failure() returns trigger
    language plpgsql as $$ begin raise exception 'fixture rejected update'; end $$;
    create trigger maintenance_fixture_failure before update on oidc.artifacts
      for each row when (old.id='atomic-rollback') execute function oidc.maintenance_fixture_failure();`);
  try {
    await expect(invalidateRestoredOidcAuthorization(db)).rejects.toThrow('fixture rejected update');
    expect(await db`select 1 from oidc.revoked_grants where id='atomic-rollback'`).toHaveLength(0);
    expect((await db`select payload from oidc.artifacts where id='atomic-rollback'`)[0].payload).toEqual({
      secret: 'keep-until-committed',
    });
  } finally {
    await db.unsafe(`drop trigger maintenance_fixture_failure on oidc.artifacts;
      drop function oidc.maintenance_fixture_failure();`);
  }
  expect(await invalidateRestoredOidcAuthorization(db)).toEqual({
    artifactsInvalidated: 1,
    grantsRevoked: 1,
  });
});
