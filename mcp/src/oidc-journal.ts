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

// Dedicated issuer DB only. The service binds this journal to its physical owner
// session. The predicate lives in each SQL statement, not a preceding liveness
// check: a lost/recycled connection must never admit or complete an old request.
// Completed means ready for handoff, not proof the browser received/resumed it.
// Pending also covers claimed recovery work, NEVER permission to reissue a code.
export function createOidcApprovalJournal(
  database: postgres.Sql,
  ownership?: { pid: number; started: string; closed?: () => boolean },
) {
  const authority = () => {
    // Do not submit work to a known-dead postgres 3.4.8 reservation. The SQL
    // identity predicate still fences loss/reuse before onclose is delivered.
    if (ownership?.closed?.()) throw new Error('Lost owner');
    return ownership
      ? database`select pg_backend_pid()=${ownership.pid}
          and exists(select 1 from pg_stat_activity where pid=pg_backend_pid()
            and backend_start::text=${ownership.started})
          and exists(select 1 from pg_locks where pid=pg_backend_pid()
            and locktype='advisory' and granted and mode='ExclusiveLock'
            and classid=1952805473 and objid=1869177956 and objsubid=2
            and database=(select oid from pg_database where datname=current_database())) as held`
      : database`select true as held`;
  };
  return {
    async begin(input: z.infer<typeof attempt>): Promise<void> {
      try {
        const entry = attempt.parse(input);
        const rows = await database`with authority as materialized (${authority()})
          insert into oidc.approval_attempts as a (interaction_id,binding)
          select ${entry.interactionId},${database.json(entry.binding)} from authority where held
          on conflict (interaction_id) do update set binding=excluded.binding
            where a.state='pending' and a.binding=excluded.binding
          returning interaction_id`;
        if (rows.length !== 1) throw new Error('Conflicting attempt or lost owner');
      } catch {
        throw new Error('OIDC_JOURNAL_WRITE_FAILED');
      }
    },
    async finish(interactionId: string, state: 'completed' | 'revoked'): Promise<void> {
      try {
        id.parse(interactionId);
        z.enum(['completed', 'revoked']).parse(state);
        const rows = await database`with authority as materialized (${authority()})
          update oidc.approval_attempts set state=${state}
          where interaction_id=${interactionId} and (select held from authority)
            and (state in ('pending',${state}) or (${state}='revoked' and state='completed'))
          returning interaction_id`;
        if (rows.length !== 1) throw new Error('Conflicting terminal state');
      } catch {
        throw new Error('OIDC_JOURNAL_WRITE_FAILED');
      }
    },
    async pending(after = '', claim = false): Promise<Array<z.infer<typeof attempt>>> {
      try {
        if (after) id.parse(after);
        // Claim abandoned completions BEFORE side effects. An old /resume can
        // destroy its Interaction concurrently; it must not hide unfinished
        // two-sided revocation from the next owner after another crash.
        const [page] = await database`with authority as materialized (${authority()}),
          candidates as materialized (
            select a.interaction_id,a.binding from oidc.approval_attempts a
            where (select held from authority) and a.interaction_id>${after}
              and (a.state='pending' or (${claim} and exists (
                select 1 from oidc.artifacts i where i.model='Interaction'
                  and i.id=a.interaction_id and not i.destroyed)))
            order by a.interaction_id limit 100 for update),
          claimed as (
            update oidc.approval_attempts a
            set state='pending'
            from candidates c where ${claim} and a.state='completed' and a.interaction_id=c.interaction_id
            returning a.interaction_id)
          select held,coalesce((select jsonb_agg(c order by c.interaction_id) from candidates c),'[]') as entries
          from authority`;
        if (!page.held) throw new Error('Lost owner');
        const rows = page.entries as postgres.Row[];
        return rows.map((row) => attempt.parse({ interactionId: row.interaction_id, binding: row.binding }));
      } catch {
        throw new Error('OIDC_JOURNAL_READ_FAILED');
      }
    },
  };
}
