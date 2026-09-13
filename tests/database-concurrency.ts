import { SQL, type TransactionSQL } from 'bun';

export function testDatabase(): SQL {
  if (!process.env.DB_URL) throw new Error('DB_URL is required; use bun run test or bun run test:current');
  const url = new URL(process.env.DB_URL);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Tests require a local database');
  return new SQL(process.env.DB_URL, { max: 3 });
}

async function bounded(transaction: TransactionSQL): Promise<void> {
  await transaction`set local statement_timeout='10s'`;
  await transaction`set local lock_timeout='5s'`;
}
const outcome = <T>(promise: Promise<T>) => promise.then(
  value => ({ ok: true as const, value }), error => ({ ok: false as const, error }),
);

export async function waitForBlockedCommand(database: SQL, backendPid: number, timeout = 2000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const [row] = await database`select exists (
      select 1 from pg_stat_activity where ${backendPid}::integer = any(pg_blocking_pids(pid))
    ) as blocked`;
    if (row.blocked) return;
    await Bun.sleep(5); // Poll an observed lock condition, never guess an interleaving.
  }
  throw new Error('competing command did not block on the held transaction');
}

// Both branches are joined even on barrier/command failure. Capture rejections
// immediately: a failed competitor must not leak an unhandled rejection or
// continue writing fixtures after the next test begins.
export async function heldTransactionRace<T>(
  database: SQL,
  hold: (transaction: TransactionSQL) => Promise<unknown>,
  compete: () => Promise<T>,
  afterBlocked?: (transaction: TransactionSQL) => Promise<unknown>,
): Promise<T> {
  const ready = Promise.withResolvers<number>();
  const release = Promise.withResolvers<boolean>();
  const holding = outcome(database.begin(async transaction => {
    try {
      await bounded(transaction);
      await hold(transaction);
      const [row] = await transaction`select pg_backend_pid() as pid`;
      ready.resolve(row.pid);
      if (await release.promise) await afterBlocked?.(transaction);
    } catch (error) { ready.reject(error); throw error; }
  }));
  holding.then(result => { if (!result.ok) ready.reject(result.error); });
  let competing: ReturnType<typeof outcome<T>> | undefined;
  try {
    const pid = await ready.promise;
    competing = outcome(Promise.resolve().then(compete));
    await waitForBlockedCommand(database, pid);
    release.resolve(true);
    const [held, other] = await Promise.all([holding, competing]);
    if (!held.ok) throw held.error;
    if (!other.ok) throw other.error;
    return other.value;
  } finally {
    release.resolve(false);
    await Promise.all([holding, competing]);
  }
}

// Establish the snapshot BEFORE acknowledging the other committed command.
// READ COMMITTED remains available as the control; changing to RR after the
// other commit would accidentally test fresh snapshots instead of the defect.
export async function staleAfterCommit<T>(
  database: SQL,
  run: (transaction: TransactionSQL) => Promise<T>,
  commit: () => Promise<unknown>,
  isolation: 'repeatable read' | 'read committed' = 'repeatable read',
) {
  const ready = Promise.withResolvers<void>();
  const release = Promise.withResolvers<boolean>();
  const stale = database.begin(async transaction => {
    await transaction.unsafe(`set transaction isolation level ${isolation}`);
    await bounded(transaction);
    await transaction`select count(*) from public.products`;
    ready.resolve();
    if (!await release.promise) throw new Error('Competing commit failed; stale command was not started');
    return run(transaction);
  }).then(value => ({ value, error: null }), error => { ready.reject(error); return { value: null, error }; });
  try { await ready.promise; await commit(); release.resolve(true); return await stale; }
  finally { release.resolve(false); await stale; }
}
