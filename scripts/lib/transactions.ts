import type { SQL, TransactionSQL } from 'bun';

// Transactional fixtures and lint probes must never survive, even on failure.
export async function withRollback<T>(database: SQL, run: (sql: TransactionSQL) => Promise<T>): Promise<T> {
  const rollback = Symbol('rollback fixture');
  let result!: T;
  try {
    await database.begin(async sql => { result = await run(sql); throw rollback; });
  } catch (error) {
    if (error !== rollback) throw error;
  }
  return result;
}
