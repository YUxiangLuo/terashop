// Opt-in Node-only Docker fixture. Synthetic data; never a service entrypoint.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { createOidcAdapter } from '../../mcp/src/oidc-adapter';
import { verifyOAuthProvider } from './oauth-provider-compat';
import { verifyOAuthInteraction } from './oauth-interaction';
import { verifyOidcService } from './oauth-service-runtime';
import { verifyOidcMaintenance } from './oauth-maintenance-runtime';
import { createOidcApprovalJournal } from '../../mcp/src/oidc-journal';
import { journalFixture, verifyApprovalJournal } from './oauth-journal';

assert.equal(process.versions.bun, undefined);
assert.equal(process.release.lts, 'Jod');
const phase = process.argv[2];
if (!phase) {
  // Distinct OS processes, not just new pools or adapter objects.
  const run = promisify(execFile);
  for (const step of ['seed', 'resume']) {
    await run(process.execPath, [fileURLToPath(import.meta.url), step], { timeout: 30000 });
    console.log('PASS: storage process', step);
  }
}
const url = (await readFile('/check/database-url', 'utf8')).trim();
assert.equal(new URL(url).hostname, 'oidc-db');
const db = postgres(url, { max: 4, connect_timeout: 5 });
try {
  const Adapter = createOidcAdapter(db);
  const session = new Adapter('Session');
  const refresh = new Adapter('RefreshToken');
  const grants = new Adapter('Grant');
  const [{ rolsuper, rolcreatedb, rolcreaterole }] = await db`
    select rolsuper,rolcreatedb,rolcreaterole from pg_roles where rolname=current_user`;
  assert.equal(rolsuper, false);
  assert.equal(rolcreatedb, false);
  assert.equal(rolcreaterole, false);
  await assert.rejects(db`create table oidc.forbidden(id integer)`, { code: '42501' });
  if (phase === 'seed') {
    const journal = createOidcApprovalJournal(db);
    await journal.begin(journalFixture('restart-pending'));
    await journal.begin(journalFixture('restart-completed'));
    await journal.finish('restart-completed', 'completed');
    await journal.begin(journalFixture('restart-revoked'));
    await journal.finish('restart-revoked', 'revoked');
    await session.upsert('restart-session', { uid: 'restart-uid', accountId: String(process.pid) }, 300);
    await refresh.upsert('used-refresh', { grantId: 'used-grant' }, 300);
    await refresh.consume('used-refresh');
    await grants.upsert('revoked-grant', {}, 300);
    await refresh.upsert('revoked-refresh', { grantId: 'revoked-grant' }, 300);
    await grants.destroy('revoked-grant');
  } else if (phase === 'resume') {
    const journal = createOidcApprovalJournal(db);
    assert.deepEqual(await journal.pending(), [journalFixture('restart-pending')]);
    await assert.rejects(journal.begin(journalFixture('restart-completed')));
    await assert.rejects(journal.begin(journalFixture('restart-revoked')));
    const persisted = await session.findByUid('restart-uid');
    assert(persisted);
    assert.notEqual(persisted.accountId, String(process.pid));
    assert.equal(persisted.uid, 'restart-uid');
    assert((await refresh.find('used-refresh'))?.consumed > 0);
    await assert.rejects(refresh.consume('used-refresh'), { error: 'invalid_grant' });
    assert.equal(await refresh.find('revoked-refresh'), undefined);
    await assert.rejects(refresh.upsert('late-refresh', { grantId: 'revoked-grant' }, 300), {
      error: 'invalid_grant',
    });
    await assert.rejects(grants.upsert('revoked-grant', {}, 300), { error: 'invalid_grant' });
  } else {
    assert.equal(phase, undefined);
    await verifyApprovalJournal(db);
    console.log('PASS: durable approval journal, immutable binding, terminal races and pagination');
    await verifyOAuthProvider('opaque', Adapter, true);
    console.log('PASS: Node LTS PostgreSQL protocol and barrier-controlled HTTP code/refresh races');
    await verifyOAuthInteraction(Adapter);
    console.log('PASS: Node LTS PostgreSQL interaction binding, consent and completion cleanup');
    await verifyOAuthInteraction(Adapter, true);
    console.log('PASS: Node LTS PostgreSQL JSON consent completion and explicit resume');
    const local = new URL(url);
    local.hostname = '127.0.0.1'; // Node shares only this disposable database's network namespace.
    await verifyOidcService(local.href, {
      key: await readFile('/check/key.pem', 'utf8'),
      cert: await readFile('/check/cert.pem', 'utf8'),
    });
    console.log(
      'PASS: direct TLS service startup, private configuration, failure cleanup, CLI restart and SIGTERM',
    );
    await verifyOidcMaintenance(local.href);
    console.log('PASS: maintenance ownership loss rolls back on the lock-owning connection');
  }
} finally {
  await db.end({ timeout: 5 });
}
