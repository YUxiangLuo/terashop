import { afterAll, expect, test } from 'bun:test';
import type { TransactionSQL } from 'bun';
import { checkDatabase, withRollback } from '../scripts/db-lint';
import { testDatabase } from './database-concurrency';

const database = testDatabase();
afterAll(() => database.close());

async function changeBody(sql: TransactionSQL, signature: string, change: (body: string) => string) {
  const [row] = await sql`
    select pg_get_functiondef(oid) as definition, prosrc from pg_proc
    where oid = ${signature}::regprocedure
  `;
  const body = change(row.prosrc);
  expect(body).not.toBe(row.prosrc);
  await sql.unsafe(row.definition.replace(row.prosrc, () => body));
}

async function lintObjects() {
  const [row] = await database`
    select (select count(*)::int from pg_extension where extname = 'plpgsql_check') as extensions,
           (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname like 'pg_temp_%' and c.relname in ('_price_lines', '_price_promos')) as tables
  `;
  return row;
}

test('SQL lint 覆盖业务函数与每个触发器挂载表，精确例外可见且检查对象全部回滚', async () => {
  const before = await lintObjects();
  const report = await withRollback(database, checkDatabase);
  expect(report.checked).toBeGreaterThan(100);
  expect(report.issues).toEqual([]);
  expect(report.reviewed.map(issue => [issue.function, issue.relation]).sort()).toEqual([
    ['private.canonical_variant_quantities(jsonb)', null],
    ['private.canonical_order_item_quantities(jsonb)', null],
    ['private.assert_checkout_quote_totals()', 'commerce.checkout_quotes'],
    ['private.assert_refund_request_lines()', 'commerce.refund_requests'],
    ['private.assert_refund_request_lines()', 'commerce.refund_request_lines'],
  ].sort());
  expect(await lintObjects()).toEqual(before);
});

test('临时表预建后仍检查计价 SQL，真实缺列不会被当作临时表误报忽略', async () => {
  await withRollback(database, async sql => {
    await changeBody(sql, 'private.price_checkout(jsonb,jsonb,uuid,text)', body =>
      body.replace('sum(unit_price * quantity)', 'sum(missing_price_column * quantity)'));
    const report = await checkDatabase(sql);
    expect(report.issues).toContainEqual(expect.objectContaining({
      function: 'private.price_checkout(jsonb,jsonb,uuid,text)',
      level: 'error', sqlstate: '42703', message: 'column "missing_price_column" does not exist',
    }));
  });
});

test('规范化函数的 JSON 表达式改变后，即使告警类型和位置不变也必须重新审阅', async () => {
  await withRollback(database, async sql => {
    for (const signature of [
      'private.canonical_variant_quantities(jsonb)', 'private.canonical_order_item_quantities(jsonb)',
    ]) {
      await changeBody(sql, signature, body => body.replace(
        "'quantity', x.quantity)", "'quantity', x.quantity, 'zone', current_setting('TimeZone'))",
      ));
    }
    const report = await checkDatabase(sql);
    for (const name of ['canonical_variant_quantities', 'canonical_order_item_quantities']) {
      expect(report.issues).toContainEqual(expect.objectContaining({
        function: `private.${name}(jsonb)`, level: 'warning',
        message: 'routine is marked as IMMUTABLE, but expression is STABLE',
      }));
      expect(report.reviewed.some(issue => issue.function === `private.${name}(jsonb)`)).toBe(false);
    }
  });
});

test('多表触发器的表名分支或字段改变后，不再豁免缺列错误', async () => {
  await withRollback(database, async sql => {
    await changeBody(sql, 'private.assert_checkout_quote_totals()', body =>
      body.replace("tg_table_name = 'checkout_quotes'", "tg_table_name = 'wrong_table'"));
    await changeBody(sql, 'private.assert_refund_request_lines()', body =>
      body.replace('v_id := new.id;', 'v_id := new.missing_id;'));
    const report = await checkDatabase(sql);
    for (const name of ['assert_checkout_quote_totals', 'assert_refund_request_lines']) {
      expect(report.issues).toContainEqual(expect.objectContaining({
        function: `private.${name}()`, level: 'error', sqlstate: '42703',
      }));
      expect(report.reviewed.some(issue => issue.function === `private.${name}()`)).toBe(false);
    }
  });
});

test('db:lint 命令遇到真实错误或未审阅告警时均返回非零退出码', async () => {
  const name = `lint_probe_${crypto.randomUUID().replaceAll('-', '')}`;
  try {
    for (const [expression, volatility, level] of [
      ['(select missing_column from public.products limit 1)', 'volatile', 'error'],
      ['extract(epoch from now())::integer', 'immutable', 'warning'],
    ]) {
      // The subprocess needs a committed probe; only this uniquely named private
      // test function is committed, and it is removed in finally.
      await database.unsafe(`create or replace function private.${name}() returns integer
        language plpgsql ${volatility} as $probe$ begin return ${expression}; end; $probe$`);
      const child = Bun.spawn(['bun', 'run', 'db:lint'], {
        cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe',
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      expect(exitCode).toBe(1);
      expect(stdout).toContain('function/trigger contexts checked');
      expect(stderr).toContain(`"function":"private.${name}()"`);
      expect(stderr).toContain(`"level":"${level}"`);
    }
  } finally {
    await database.unsafe(`drop function if exists private.${name}()`);
  }
}, 15000);

test('无法识别临时表定义时检查失败，异常路径也不留下扩展或临时表', async () => {
  const before = await lintObjects();
  await expect(withRollback(database, async sql => {
    await changeBody(sql, 'private.price_checkout(jsonb,jsonb,uuid,text)', body =>
      body.replace('create temporary table _price_promos', 'create temporary table _renamed_price_promos'));
    await checkDatabase(sql);
  })).rejects.toThrow('Cannot prepare price_checkout temp tables');
  await expect(withRollback(database, async sql => {
    await checkDatabase(sql);
    throw new Error('failure after preparing lint objects');
  })).rejects.toThrow('failure after preparing lint objects');
  expect(await lintObjects()).toEqual(before);
});
