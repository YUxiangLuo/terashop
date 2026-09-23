import assert from 'node:assert/strict';
import postgres from 'postgres';
import { createOidcApprovalJournal } from '../../mcp/src/oidc-journal';
import { createOidcAdapter } from '../../mcp/src/oidc-adapter';
import { recoverOidcApprovals } from '../../mcp/src/oidc-recovery';
import { journalFixture } from './oauth-journal';

// Real physical-session loss, in the supported Node runtime. No public backend.
export async function verifyOidcOwnership(url: string) {
  const observer = postgres(url, { max: 2, connect_timeout: 5 });
  const closed = Promise.withResolvers<void>();
  let lost = false;
  const pool = postgres(url, {
    max: 1,
    idle_timeout: 0,
    max_lifetime: null,
    connect_timeout: 3,
    connection: { statement_timeout: 3000 },
    onclose: () => {
      lost = true;
      closed.resolve();
    },
  });
  const prefix = `owner-${crypto.randomUUID()}`;
  const early = journalFixture(`${prefix}-early`);
  const late = journalFixture(`${prefix}-late`);
  const abandoned = journalFixture(`${prefix}-abandoned`);
  const resumed = journalFixture(`${prefix}-resumed`);
  let owner: postgres.ReservedSql | undefined;
  try {
    owner = await pool.reserve();
    const [identity] = await owner`select pg_backend_pid() as pid,backend_start::text as started,
      pg_try_advisory_lock(1952805473,1869177956) as held
      from pg_stat_activity where pid=pg_backend_pid()`;
    assert(identity.held);
    const journal = createOidcApprovalJournal(owner, {
      pid: identity.pid,
      started: identity.started,
      closed: () => lost,
    });
    await journal.begin(early);
    await assert.rejects(
      createOidcApprovalJournal(owner, { pid: identity.pid, started: 'wrong-start' }).begin(late),
      /^Error: OIDC_JOURNAL_WRITE_FAILED$/,
    );
    // Same live session, but no ownership: predicates, not onclose, reject writes.
    await owner`select pg_advisory_unlock(1952805473,1869177956)`;
    await assert.rejects(journal.begin(late));
    await assert.rejects(journal.finish(early.interactionId, 'completed'));
    await assert.rejects(journal.pending('', true));
    await owner`select pg_advisory_lock(1952805473,1869177956)`;
    assert.equal((await observer`select pg_terminate_backend(${identity.pid}) as killed`)[0].killed, true);
    await closed.promise;
    // A paused approval released after owner loss cannot insert its admission.
    await assert.rejects(journal.begin(late), /^Error: OIDC_JOURNAL_WRITE_FAILED$/);
    await assert.rejects(journal.finish(early.interactionId, 'completed'));
    await assert.rejects(journal.pending('', true));
    assert.equal(
      (await observer`select 1 from oidc.approval_attempts where interaction_id=${late.interactionId}`)
        .length,
      0,
    );
    await pool.end({ timeout: 1 });
    owner = undefined;

    const successor = await observer.reserve();
    try {
      const [next] = await successor`select pg_backend_pid() as pid,backend_start::text as started,
        pg_try_advisory_lock(1952805473,1869177956) as held
        from pg_stat_activity where pid=pg_backend_pid()`;
      assert(next.held);
      const current = createOidcApprovalJournal(successor, { pid: next.pid, started: next.started });
      const stale = createOidcApprovalJournal(successor, { pid: identity.pid, started: identity.started });
      await assert.rejects(stale.begin(late)); // A recycled handle cannot adopt the successor's lease.
      await assert.rejects(stale.pending('', true));
      const Adapter = createOidcAdapter(observer);
      const interactions = new Adapter('Interaction');
      const grants = new Adapter('Grant');
      for (const entry of [abandoned, resumed]) {
        await current.begin(entry);
        await grants.upsert(entry.binding.session_id, {}, 60);
        await interactions.upsert(entry.interactionId, { result: {} }, 0);
        await current.finish(entry.interactionId, 'completed');
      }
      await interactions.destroy(resumed.interactionId);
      const config = { ...abandoned.binding, supabaseUrl: 'https://db.example', serviceRoleKey: 'fixture' };
      const revoked = new Set<string>();
      // Recovery claims completion before the old /resume can erase evidence.
      await assert.rejects(
        recoverOidcApprovals(
          observer,
          config,
          async (_url, init) => {
            const binding = JSON.parse(String(init.body)).p_binding;
            if (binding.session_id === abandoned.binding.session_id) {
              assert.equal(
                (
                  await successor`select state from oidc.approval_attempts
            where interaction_id=${abandoned.interactionId}`
                )[0].state,
                'pending',
              );
              await interactions.destroy(abandoned.interactionId); // Old resume wins this race.
              throw new Error('Lost revocation receipt');
            }
            revoked.add(binding.session_id);
            return Response.json({ id: null, user_id: null, scopes: [], state: 'revoked', version: 2 });
          },
          current,
        ),
        /^Error: OIDC_RECOVERY_UNCONFIRMED$/,
      );
      await recoverOidcApprovals(
        observer,
        config,
        async (_url, init) => {
          revoked.add(JSON.parse(String(init.body)).p_binding.session_id);
          return Response.json({ id: null, user_id: null, scopes: [], state: 'revoked', version: 2 });
        },
        current,
      );
      assert(revoked.has(abandoned.binding.session_id));
      assert(revoked.has(early.binding.session_id));
      assert(!revoked.has(resumed.binding.session_id));
      assert.equal(await grants.find(abandoned.binding.session_id), undefined);
      await assert.rejects(grants.upsert(abandoned.binding.session_id, {}, 60));
      await assert.rejects(interactions.upsert(abandoned.interactionId, {}, 60));
      assert(await grants.find(resumed.binding.session_id));
      assert.deepEqual(await current.pending('', true), []);
      await successor`select pg_advisory_unlock(1952805473,1869177956)`;
    } finally {
      successor.release();
    }
  } finally {
    // A terminated reservation is already released by the driver.
    await pool.end({ timeout: 1 });
    await observer`delete from oidc.approval_attempts where interaction_id like ${`${prefix}%`}`;
    await observer.end({ timeout: 1 });
  }
}
