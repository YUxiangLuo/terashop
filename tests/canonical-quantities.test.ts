import { afterAll, expect, test } from 'bun:test';
import { withRollback } from '../scripts/db-lint';
import { testDatabase } from './database-concurrency';

const database = testDatabase();
afterAll(() => database.close());
const first = 'aaaa0000-0000-4000-8000-000000000001';
const second = 'bbbb0000-0000-4000-8000-000000000002';

for (const [name, field] of [
  ['canonical_variant_quantities', 'variant_id'],
  ['canonical_order_item_quantities', 'order_item_id'],
] as const) {
  test(`${name} 的 IMMUTABLE 合同：重排、拆行、UUID 大小写与会话设置不改变规范值/哈希`, async () => {
    await withRollback(database, async sql => {
      const [catalog] = await sql`
        select provolatile from pg_proc where oid = ${`private.${name}(jsonb)`}::regprocedure
      `;
      expect(catalog.provolatile).toBe('i');
      const expected = [{ [field]: first, quantity: 3 }, { [field]: second, quantity: 2 }];
      const inputs = [
        expected,
        [...expected].reverse(),
        [
          { [field]: second.toUpperCase(), quantity: '2', ignored: 'unused' },
          { [field]: first.toUpperCase(), quantity: 1 },
          { [field]: first, quantity: 2 },
        ],
      ];
      // Bind input at execution time so each setting exercises the function,
      // rather than merely reusing a constant-folded result from a prepared plan.
      let canonicalText: string | undefined;
      let hash: string | undefined;
      for (const [timezone, dateStyle, intervalStyle, floatDigits] of [
        ['UTC', 'ISO, MDY', 'postgres', '3'],
        ['Asia/Shanghai', 'SQL, DMY', 'sql_standard', '-3'],
        ['Pacific/Honolulu', 'German, DMY', 'iso_8601', '0'],
      ]) {
        await sql`select set_config('TimeZone', ${timezone}, true),
                         set_config('DateStyle', ${dateStyle}, true),
                         set_config('IntervalStyle', ${intervalStyle}, true),
                         set_config('extra_float_digits', ${floatDigits}, true)`;
        for (const input of inputs) {
          const [row] = await sql.unsafe(`
            with result as materialized (select private.${name}($1::text::jsonb) as value)
            select value, value::text as text, private.command_request_hash(value) as hash from result
          `, [JSON.stringify(input)]);
          expect(row.value).toEqual(expected);
          canonicalText ??= row.text;
          hash ??= row.hash;
          expect(row.text).toBe(canonicalText);
          expect(row.hash).toBe(hash);
        }
      }
    });
  });

  test(`${name} 保留整数上限及非法输入拒绝`, async () => {
    const [valid] = await database.unsafe(`select private.${name}($1::text::jsonb) as value`, [
      JSON.stringify([{ [field]: first, quantity: 2147483646 }, { [field]: first, quantity: 1 }]),
    ]);
    expect(valid.value).toEqual([{ [field]: first, quantity: 2147483647 }]);
    for (const input of [
      null, [], {}, [{ quantity: 1 }], [{ [field]: 'bad', quantity: 1 }],
      ...[0, -1, 1.5, '01', '1.0', 2147483648].map(quantity => [{ [field]: first, quantity }]),
      [{ [field]: first, quantity: 2147483647 }, { [field]: first, quantity: 1 }],
    ]) {
      // SQL queries are lazy thenables; start one before handing it to expect.
      await expect(Promise.resolve(database.unsafe(
        `select private.${name}($1::text::jsonb)`, [JSON.stringify(input)],
      ))).rejects.toThrow();
    }
  });
}
