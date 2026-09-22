import type postgres from 'postgres';
import * as z from 'zod/v4';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
const text = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value.trim() === value);
const binding = z.strictObject({
  issuer: text,
  subject: z.uuid(),
  client_id: text,
  resource: text,
  project: text,
  session_id: id,
});
const attempt = z.strictObject({ interactionId: id, binding });

// Dedicated issuer DB only. Automatic crash recovery is not yet enabled.
// The host must persist begin before local grant creation, and only mark
// a terminal state after confirmed completion or confirmed two-sided revocation.
// A pending record is recovery work, NOT permission to retry issuing a code.
export function createOidcApprovalJournal(database: postgres.Sql) {
  return {
    async begin(input: z.infer<typeof attempt>): Promise<void> {
      try {
        const entry = attempt.parse(input);
        await database.begin(async (tx) => {
          await tx.unsafe("set local lock_timeout = '5s'");
          const parameters = [entry.interactionId, entry.binding];
          await tx.unsafe(
            `insert into oidc.approval_attempts (interaction_id,binding)
            values ($1,$2::jsonb) on conflict (interaction_id) do nothing`,
            parameters,
          );
          // Separate statement sees the winner after a concurrent INSERT waits.
          const [row] = await tx.unsafe(
            `select state,binding=$2::jsonb as same
            from oidc.approval_attempts where interaction_id=$1 for update`,
            parameters,
          );
          if (!row || !row.same || row.state !== 'pending') throw new Error('Conflicting attempt');
        });
      } catch {
        throw new Error('OIDC_JOURNAL_WRITE_FAILED');
      }
    },
    async finish(interactionId: string, state: 'completed' | 'revoked'): Promise<void> {
      try {
        id.parse(interactionId);
        z.enum(['completed', 'revoked']).parse(state);
        const rows = await database`update oidc.approval_attempts set state=${state}
          where interaction_id=${interactionId} and state in ('pending',${state}) returning interaction_id`;
        if (rows.length !== 1) throw new Error('Conflicting terminal state');
      } catch {
        throw new Error('OIDC_JOURNAL_WRITE_FAILED');
      }
    },
    async pending(after = ''): Promise<Array<z.infer<typeof attempt>>> {
      try {
        if (after) id.parse(after);
        const rows = await database`select interaction_id,binding from oidc.approval_attempts
          where state='pending' and interaction_id>${after} order by interaction_id limit 100`;
        return rows.map((row) => attempt.parse({ interactionId: row.interaction_id, binding: row.binding }));
      } catch {
        throw new Error('OIDC_JOURNAL_READ_FAILED');
      }
    },
  };
}
