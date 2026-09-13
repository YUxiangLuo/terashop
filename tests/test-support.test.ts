import { afterAll, expect, test } from 'bun:test';
import { testDatabase, heldTransactionRace, staleAfterCommit } from './database-concurrency';
import { stockedProduct } from './support/catalog';
import { withRollback } from '../scripts/lib/transactions';
import { api, checked, makeAdmin, signup } from './helpers';

const database = testDatabase();
afterAll(() => database.close());
const key = () => String(BigInt(`0x${crypto.randomUUID().replaceAll('-', '').slice(0, 14)}`));

for (const failure of [undefined, new Error('rollback fixture'), Symbol('callback failure')]) {
  test(`回滚夹具${failure === undefined ? '成功返回值' : typeof failure === 'symbol' ? '透传非 Error 异常' : '透传同名异常'}，真实写入均不提交`, async () => {
    const id = crypto.randomUUID(), result = { id, marker: 17 };
    try {
      const run = withRollback(database, async tx => {
        await tx`insert into public.products(id, slug, name) values (${id}::uuid, ${id}, 'Rollback probe')`;
        expect(await tx`select id from public.products where id=${id}::uuid`).toHaveLength(1);
        if (failure !== undefined) throw failure;
        return result;
      });
      if (failure === undefined) expect(await run).toBe(result);
      else await expect(run).rejects.toBe(failure);
      expect(await database`select id from public.products where id=${id}::uuid`).toHaveLength(0);
    } finally {
      // Clean only this probe if a broken helper accidentally committed it.
      await database`delete from public.products where id=${id}::uuid`;
    }
  });
}

test('并发夹具的持锁分支设置失败时拒绝，不留下未完成的 ready 屏障', async () => {
  await expect(heldTransactionRace(database, async () => { throw new Error('holder setup failed'); }, async () => null))
    .rejects.toThrow('holder setup failed');
});

test('竞争方失败时释放持锁事务；barrier 失败不泄漏异步分支或数据库锁', async () => {
  const lock = key(); let finished = false;
  await expect(heldTransactionRace(database, async tx => {
    await tx`select pg_advisory_xact_lock(${lock}::bigint)`;
  }, async () => {
    try { throw new Error('competitor failed before blocking'); } finally { finished = true; }
  })).rejects.toThrow('did not block');
  expect(finished).toBe(true);
  const [row] = await database`select pg_try_advisory_xact_lock(${lock}::bigint) acquired`;
  expect(row.acquired).toBe(true);
});

test('持锁者后置动作失败仍等待竞争方完成，避免下一测试开始后继续执行', async () => {
  const lock = key(); let finished = false;
  await expect(heldTransactionRace(database, async tx => {
    await tx`select pg_advisory_xact_lock(${lock}::bigint)`;
  }, async () => {
    await database.begin(async tx => { await tx`select pg_advisory_xact_lock(${lock}::bigint)`; });
    finished = true;
  }, async () => { throw new Error('holder action failed'); })).rejects.toThrow('holder action failed');
  expect(finished).toBe(true);
});

test('竞争提交失败时不再执行旧快照写入，保留原始错误', async () => {
  let ran = false;
  await expect(staleAfterCommit(database, async () => { ran = true; }, async () => { throw new Error('commit failed'); }))
    .rejects.toThrow('commit failed');
  expect(ran).toBe(false);
});

test('商品夹具在发布后库存初始化失败时也归档，不遗留公开半成品', async () => {
  const admin = await signup(); await makeAdmin(admin.userId);
  const label = `failed-setup-${crypto.randomUUID()}`;
  await expect(stockedProduct(admin, { label, onHand: -1 })).rejects.toThrow('23514');
  const rows = await checked<Array<{ status: string }>>(api(`/rest/v1/products?slug=like.fixture-${label}-*&select=status`, { service: true }));
  expect(rows).toEqual([{ status: 'archived' }]);
  expect((await api(`/rest/v1/products?slug=like.fixture-${label}-*&select=id`)).data).toEqual([]);
});
