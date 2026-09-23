import assert from 'node:assert/strict';
import type postgres from 'postgres';
import { createOidcApprovalJournal } from '../../mcp/src/oidc-journal';

export const journalFixture = (interactionId: string) => ({
  interactionId,
  binding: {
    issuer: 'https://auth.example',
    subject: '11111111-1111-4111-8111-111111111111',
    client_id: 'agent',
    resource: 'https://shop.example/mcp',
    project: 'journal-test',
    session_id: `grant-${interactionId}`,
  },
});

export async function verifyApprovalJournal(db: postgres.Sql) {
  const journal = createOidcApprovalJournal(db);
  const other = createOidcApprovalJournal(db);
  const a = journalFixture(`journal-${crypto.randomUUID()}`);
  const changed = { ...a, binding: { ...a.binding, project: 'other-shop' } };
  const results = await Promise.allSettled([journal.begin(a), other.begin(changed)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const winner = results[0].status === 'fulfilled' ? a : changed;
  assert.deepEqual(
    (await journal.pending()).find((r) => r.interactionId === a.interactionId),
    winner,
  );
  await journal.begin(winner); // Identical pending receipt may be retried.
  await assert.rejects(journal.begin({ ...winner, interactionId: `${a.interactionId}-duplicate` }));
  const terminal = await Promise.allSettled([
    journal.finish(a.interactionId, 'completed'),
    other.finish(a.interactionId, 'revoked'),
  ]);
  assert.equal(terminal[1].status, 'fulfilled'); // Revocation wins in either order.
  await journal.finish(a.interactionId, 'revoked');
  await assert.rejects(journal.finish(a.interactionId, 'completed'));
  await assert.rejects(journal.begin(winner), /^Error: OIDC_JOURNAL_WRITE_FAILED$/);
  assert(!(await journal.pending()).some((r) => r.interactionId === a.interactionId));
  await assert.rejects(journal.finish('missing', 'completed'));
  await assert.rejects(journal.begin({ ...journalFixture('secret'), token: 'must-not-persist' } as any));
  // Mixed ASCII case deliberately differs from locale order. Cross the page boundary.
  const ids = Array.from(
    { length: 103 },
    (_, i) => `page-${i % 2 ? 'a' : 'Z'}-${String(i).padStart(3, '0')}`,
  );
  for (const id of ids) await journal.begin(journalFixture(id));
  const first = await journal.pending('page-');
  assert.equal(first.length, 100);
  const last = await journal.pending(first.at(-1)!.interactionId);
  assert.deepEqual(
    [...first, ...last].filter((r) => r.interactionId.startsWith('page-')).map((r) => r.interactionId),
    ids.sort(),
  );
  await db`delete from oidc.approval_attempts where binding->>'project' in ('journal-test','other-shop')`;
}
