import assert from 'node:assert/strict';
import postgres from 'postgres';
import { cleanupExpiredOidcPayloads } from '../../mcp/src/oidc-maintenance';

// Test the supported Node runtime, including driver behavior on lost ownership.
export async function verifyOidcMaintenance(url: string) {
  const db = postgres(url, { max: 3, connect_timeout: 5, onnotice: () => {} });
  const id = crypto.randomUUID();
  const ready = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let holding: Promise<unknown> | undefined;
  let competing: Promise<boolean> | undefined;
  try {
    await db`insert into oidc.artifacts(model,id,payload,expires_at)
      values ('Session',${id},'{"secret":"must-survive-rollback"}',clock_timestamp())`;
    holding = db.begin(async (tx) => {
      await tx.unsafe('select pg_advisory_xact_lock(1952805473,1869177955)');
      ready.resolve();
      await release.promise;
    });
    void holding.catch(ready.reject);
    await ready.promise;
    competing = cleanupExpiredOidcPayloads(db).then(
      () => false,
      () => true,
    );
    let killed = false;
    const until = Date.now() + 3000;
    while (Date.now() < until) {
      const rows = await db`select l.pid from pg_locks l
        where l.locktype='advisory' and l.granted and l.classid=1952805473 and l.objid=1869177956
        and l.database=(select oid from pg_database where datname=current_database())
        and cardinality(pg_blocking_pids(l.pid)) > 0`;
      if (rows.length) {
        assert.equal(rows.length, 1);
        assert.equal((await db`select pg_terminate_backend(${rows[0].pid}) as killed`)[0].killed, true);
        killed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert(killed, 'maintenance did not reach the writer barrier');
    assert.equal(await competing, true, 'connection loss must abort maintenance');
    release.resolve();
    await holding;
    assert.deepEqual((await db`select payload from oidc.artifacts where id=${id}`)[0].payload, {
      secret: 'must-survive-rollback',
    });
    assert((await cleanupExpiredOidcPayloads(db)) >= 1);
    assert.equal((await db`select payload from oidc.artifacts where id=${id}`)[0].payload, null);
  } finally {
    release.resolve();
    await Promise.allSettled([holding, competing]);
    await db.end({ timeout: 5 });
  }
}
