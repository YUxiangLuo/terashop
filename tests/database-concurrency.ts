import { SQL, type TransactionSQL } from 'bun';

export function testDatabase(): SQL {
  if (!process.env.DB_URL) throw new Error('DB_URL is required; use bun run test or bun run test:current');
  return new SQL(process.env.DB_URL, { max: 3 });
}

// Run a command while another real transaction deliberately owns its lock.
// Observe pg_blocking_pids rather than depending on request timing or sleeps.
export async function heldTransactionRace<T>(
  database: SQL,
  hold: (transaction: TransactionSQL) => Promise<unknown>,
  compete: () => Promise<T>,
  afterBlocked?: (transaction: TransactionSQL) => Promise<unknown>,
): Promise<T> {
  const ready = Promise.withResolvers<number>();
  const release = Promise.withResolvers<boolean>();
  const holding = database.begin(async transaction => {
    await hold(transaction);
    const [row] = await transaction`select pg_backend_pid() as pid`;
    ready.resolve(row.pid);
    if (await release.promise) await afterBlocked?.(transaction);
  });
  holding.catch(ready.reject);
  let competing: Promise<T> | undefined;
  let observed = false;
  try {
    const pid = await ready.promise;
    competing = compete();
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const [row] = await database`
        select exists (select 1 from pg_stat_activity a where ${pid}::integer = any(pg_blocking_pids(a.pid))) as blocked
      `;
      if (row.blocked) { observed = true; break; }
      await Bun.sleep(5);
    }
    if (!observed) throw new Error('competing command did not block on the held transaction');
  } finally {
    release.resolve(observed);
    await holding;
  }
  return competing!;
}
