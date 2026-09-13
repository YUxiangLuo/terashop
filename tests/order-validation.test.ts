import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { TransactionSQL } from 'bun';
import { withRollback } from '../scripts/lib/transactions';
import { testDatabase } from './database-concurrency';
import { signup, TEST_ADDRESS, type TestUser } from './helpers';

const database = testDatabase();
let buyer: TestUser;
beforeAll(async () => { buyer = await signup(); });
afterAll(() => database.close());

async function fixture(sql: TransactionSQL) {
  const p = crypto.randomUUID(), v = crypto.randomUUID(), code = crypto.randomUUID().toUpperCase(), shipping = crypto.randomUUID();
  await sql`insert into public.products(id,slug,name) values (${p}::uuid,${p},'Validation fixture')`;
  await sql`insert into public.product_variants(id,product_id,price,track_inventory) values (${v}::uuid,${p}::uuid,10,false)`;
  await sql`update public.products set status='active' where id=${p}::uuid`;
  await sql`insert into public.promotions(name,code,type,params,per_customer_limit) values ('Validation discount',${code},'order_percentage','{"percent":10}',10)`;
  await sql`update public.tax_rates set is_active=false where country='NZ' and is_active`;
  await sql`insert into public.tax_rates(name,country,rate,include_shipping) values ('Test-only NZ tax','NZ',0.1,true)`;
  await sql`insert into public.shipping_methods(id,name,price) values (${shipping}::uuid,'Validation shipping',10)`;
  await sql`select set_config('request.jwt.claims',${JSON.stringify({ sub: buyer.userId, role: 'authenticated' })},true)`;
  return async (lines = 1) => {
    const items = Array.from({ length: lines }, (_, i) => ({ variant_id: v, quantity: 1, attributes: { label: String(i) } }));
    const [row] = await sql`select public.create_order(${JSON.stringify(items)}::text::jsonb,address=>${JSON.stringify({ ...TEST_ADDRESS, country: 'NZ' })}::text::jsonb,shipping_method_id=>${shipping}::uuid,discount_code=>${code}) o`;
    return row.o as { id: string; total: number };
  };
}
async function calls(sql: TransactionSQL) {
  const [row] = await sql`select coalesce(sum(calls),0)::int n from pg_stat_xact_user_functions where schemaname='private' and funcname='assert_order_totals'`;
  return row.n as number;
}

for (const n of [1, 10, 50]) test(`${n} 行订单仅执行一次完整延迟校验，不按明细数重复扫描`, async () => {
  await withRollback(database, async sql => {
    const create = await fixture(sql);
    await sql`set local track_functions='all'`;
    const before = await calls(sql), start = performance.now();
    const order = await create(n);
    await sql`set constraints all immediate`;
    const count = await calls(sql) - before;
    console.info(`order-validation lines=${n} full_checks=${count} elapsed_ms=${Math.round(performance.now() - start)}`);
    expect(order.total).toBe(n * 9.9 + 11);
    expect(count).toBe(1); // count, not machine-dependent wall-clock time, is the performance contract
  });
}, 15000);

test('同事务两张订单分别校验；强制校验后再次修改仍重新校验', async () => {
  await withRollback(database, async sql => {
    const create = await fixture(sql); await sql`set local track_functions='all'`;
    const before = await calls(sql), first = await create(), second = await create();
    await sql`set constraints all immediate`;
    expect(await calls(sql) - before).toBe(2);
    for (const id of [first.id, second.id]) {
      await sql`set constraints all deferred`;
      const checkedBefore = await calls(sql);
      await sql`update public.orders set admin_note='revalidate' where id=${id}::uuid`;
      await sql`set constraints all immediate`;
      expect(await calls(sql) - checkedBefore).toBe(1);
    }
    await sql`set constraints all immediate`;
  });
});

test('保存点回滚不能留下去重标记而吞掉后续校验', async () => {
  await withRollback(database, async sql => {
    const create = await fixture(sql), order = await create();
    await sql`set local track_functions='all'`;
    await sql`set constraints all immediate`;
    await sql`set constraints all deferred`;
    await sql`savepoint first_edit`;
    await sql`update public.orders set admin_note='rolled back' where id=${order.id}::uuid`;
    await sql`rollback to savepoint first_edit`;
    await sql`release savepoint first_edit`;
    const before = await calls(sql);
    await sql`update public.orders set admin_note='persisted' where id=${order.id}::uuid`;
    await sql`set constraints all immediate`;
    expect(await calls(sql) - before).toBe(1);
  });
});

test('缺失商品行的订单在 COMMIT 被拒绝，校验队列不残留且 API 角色不可操作', async () => {
  const id = crypto.randomUUID();
  await expect(database.begin(async sql => {
    await sql`insert into public.orders(id,customer_id,email,subtotal,total,shipping_address)
      values (${id}::uuid,${buyer.customerId}::uuid,'review@example.invalid',10,10,${JSON.stringify(TEST_ADDRESS)}::text::jsonb)`;
  })).rejects.toThrow('order line totals');
  expect(await database`select id from public.orders where id=${id}::uuid`).toHaveLength(0);
  expect(await database`select order_id from private.order_validation_queue`).toHaveLength(0);
  for (const role of ['anon','authenticated','service_role']) {
    await expect(database.begin(async sql => {
      await sql.unsafe(`set local role ${role}`); await sql`select * from private.order_validation_queue`;
    })).rejects.toMatchObject({ errno: '42501' });
    const [row] = await database`select has_table_privilege(${role},'private.order_validation_queue','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') allowed`;
    expect(row.allowed).toBe(false);
  }
});

test('价格 DTO 的税/优惠查询限定订单，使用订单或更精确的商品行索引', async () => {
  await withRollback(database, async sql => {
    const create = await fixture(sql), order = await create(2);
    await sql`set constraints all immediate`;
    // Explain the actual SQL-language body (not a hand-maintained copy).
    // Force index eligibility to make this structural regression independent of fixture size.
    const [definition] = await sql`select prosrc from pg_proc where oid='private.order_pricing_json(uuid)'::regprocedure`;
    await sql`set local enable_seqscan=off`;
    const [explain] = await sql.unsafe(`explain (format json) ${definition.prosrc.replaceAll('p_order_id', '$1::uuid')}`, [order.id]);
    const nodes: Record<string, any>[] = [];
    const walk = (node: Record<string, any>) => { nodes.push(node); for (const child of node.Plans ?? []) walk(child); };
    walk(explain['QUERY PLAN'][0].Plan);
    const details = nodes.filter(n => ['order_discount_allocations', 'order_tax_lines'].includes(n['Relation Name']));
    expect(details).toHaveLength(4);
    for (const node of details) {
      // An item-tax lookup may legitimately prefer the more selective item
      // index and check order_id as a filter. Do not pin a single cost-based plan.
      const indexCondition = node['Index Cond'] ?? node['Recheck Cond'] ?? '';
      expect(node['Node Type']).not.toBe('Seq Scan');
      expect(`${indexCondition} ${node.Filter ?? ''}`).toContain('order_id =');
      expect(indexCondition).toMatch(/order_(id|item_id) =/);
    }
  });
});
