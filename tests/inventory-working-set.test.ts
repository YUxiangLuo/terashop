import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { TransactionSQL } from 'bun';
import { withRollback } from '../scripts/lib/transactions';
import { testDatabase, heldTransactionRace } from './database-concurrency';
import { signup, makeAdmin, TEST_ADDRESS, type TestUser } from './helpers';

const database = testDatabase();
let admin: TestUser;
beforeAll(async () => { admin = await signup(); await makeAdmin(admin.userId); });
afterAll(() => database.close());

async function fixture(sql: TransactionSQL, stock = 100) {
  const p = crypto.randomUUID(), v = crypto.randomUUID();
  await sql`insert into public.products(id,slug,name) values(${p}::uuid,${p},'Reservation working set')`;
  await sql`insert into public.product_variants(id,product_id,price) values(${v}::uuid,${p}::uuid,10)`;
  await sql`update public.products set status='active' where id=${p}::uuid`;
  await sql`select set_config('request.jwt.claims',${JSON.stringify({ sub: admin.userId, role: 'authenticated' })},true)`;
  await sql`select public.adjust_inventory(${v}::uuid,${stock})`;
  const [level] = await sql`select location_id from public.inventory_levels where variant_id=${v}::uuid`;
  const [quote] = await sql`select public.create_checkout_quote(
    jsonb_build_array(jsonb_build_object('variant_id',${v}::uuid,'quantity',3)),${crypto.randomUUID()},
    address=>${JSON.stringify(TEST_ADDRESS)}::text::jsonb) q`;
  return { p, v, location: level.location_id as string, q: quote.q.id as string };
}

test('预占工作集跟随转单/付款/取消，回滚恢复，历史行保留且底表不开放', async () => {
  await withRollback(database, async sql => {
    const f = await fixture(sql);
    expect((await sql`select sum(quantity)::int n from commerce.inventory_reservations where quote_id=${f.q}::uuid`)[0].n).toBe(3);
    expect((await sql`select private.active_reserved_quantity(${f.v}::uuid,${f.location}::uuid,${f.q}::uuid) n`)[0].n).toBe(0);
    await sql`savepoint cancel_quote`;
    await sql`select public.cancel_checkout_quote(${f.q}::uuid)`;
    expect(await sql`select 1 from commerce.inventory_reservations where quote_id=${f.q}::uuid`).toHaveLength(0);
    await sql`rollback to savepoint cancel_quote`;
    const [converted] = await sql`select public.create_order_from_quote(${f.q}::uuid) o`;
    expect((await sql`select private.active_reserved_quantity(${f.v}::uuid,${f.location}::uuid) n`)[0].n).toBe(3);
    await sql`select public.mark_order_paid(${converted.o.id}::uuid)`;
    expect(await sql`select 1 from commerce.inventory_reservations where quote_id=${f.q}::uuid`).toHaveLength(0);
    expect(await sql`select 1 from commerce.checkout_quote_lines where quote_id=${f.q}::uuid`).toHaveLength(1);
    expect((await sql`select on_hand from public.inventory_levels where variant_id=${f.v}::uuid`)[0].on_hand).toBe(97);
    await sql`set constraints all immediate`;
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect((await sql`select has_table_privilege(${role},'commerce.inventory_reservations','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') allowed`)[0].allowed).toBe(false);
    }
  });
});

test('预占工作集拒绝篡改、提前删除和批量明细超卖', async () => {
  await withRollback(database, async sql => {
    const f = await fixture(sql, 3);
    for (const statement of [
      'update commerce.inventory_reservations set quantity=1 where quote_id=$1::uuid',
      'delete from commerce.inventory_reservations where quote_id=$1::uuid',
    ]) {
      await sql`savepoint invalid_write`;
      await expect(Promise.resolve(sql.unsafe(statement, [f.q]))).rejects.toThrow();
      await sql`rollback to savepoint invalid_write`;
    }
    await sql`select public.cancel_checkout_quote(${f.q}::uuid)`;
    await sql`savepoint invalid_insert`;
    await expect(Promise.resolve(sql`insert into commerce.inventory_reservations(quote_line_id,quote_id,variant_id,location_id,quantity,expires_at)
      select l.id,l.quote_id,l.variant_id,l.location_id,l.quantity,q.expires_at
      from commerce.checkout_quote_lines l join commerce.checkout_quotes q on q.id=l.quote_id where q.id=${f.q}::uuid`))
      .rejects.toThrow('inventory reservation must match an active quote line');
    await sql`rollback to savepoint invalid_insert`;
    const [header] = await sql`insert into commerce.checkout_quotes(customer_id,idempotency_key,request_hash,pricing_hash,
      currency,subtotal,total,shipping_address,expires_at)
      values(${admin.customerId}::uuid,${crypto.randomUUID()},repeat('a',64),repeat('b',64),'USD',40,40,'{}',now()+interval '15 minutes') returning id`;
    await sql`savepoint bulk_insert`;
    await expect(Promise.resolve(sql`insert into commerce.checkout_quote_lines(quote_id,variant_id,product_id,location_id,name,
      unit_price,quantity,total,line_total,track_inventory,attributes)
      select ${header.id}::uuid,${f.v}::uuid,${f.p}::uuid,${f.location}::uuid,'Bulk',10,2,20,20,true,
        jsonb_build_object('label',n::text) from generate_series(1,2) n`)).rejects.toThrow('reservation line exceeds available stock');
    await sql`rollback to savepoint bulk_insert`;
    expect(await sql`select 1 from commerce.inventory_reservations where quote_id=${header.id}::uuid`).toHaveLength(0);
  });
});

test('并发终结 Quote 时，直接 INSERT 不能重新制造已释放的预占', async () => {
  const f = await database.begin(sql => fixture(sql));
  try {
    await expect(heldTransactionRace(database, async sql => {
      await sql`update commerce.checkout_quotes set status='cancelled' where id=${f.q}::uuid`;
    }, () => database.begin(async sql => {
      await sql`set local statement_timeout='5s'`;
      await sql`insert into commerce.inventory_reservations(quote_line_id,quote_id,variant_id,location_id,quantity,expires_at)
        select l.id,l.quote_id,l.variant_id,l.location_id,l.quantity,q.expires_at
        from commerce.checkout_quote_lines l join commerce.checkout_quotes q on q.id=l.quote_id where q.id=${f.q}::uuid`;
    }))).rejects.toThrow('inventory reservation must match an active quote line');
    expect((await database`select private.active_reserved_quantity(${f.v}::uuid,${f.location}::uuid) n`)[0].n).toBe(0);
  } finally {
    await database`update commerce.checkout_quotes set status='cancelled' where id=${f.q}::uuid`;
    await database`update public.products set status='archived' where id=${f.p}::uuid`;
  }
});

test('实际库存 SQL 与旧列表只查询目标预占，不随历史报价扫描增长', async () => {
  await withRollback(database, async sql => {
    const f = await fixture(sql);
    // Clone valid one-line commercial snapshots and terminate each quote, with
    // every trigger enabled. Fixture-only SQL avoids customer checkout quotas.
    await sql`create temporary table reservation_template on commit drop as
      select ${f.q}::uuid quote_id`;
    await sql.unsafe(`create function pg_temp.reservation_history(n integer) returns void language plpgsql as $$
      declare template commerce.checkout_quotes; line commerce.checkout_quote_lines; v_quote_id uuid;
      begin
        select q.* into strict template from commerce.checkout_quotes q join reservation_template t on q.id=t.quote_id;
        select l.* into strict line from commerce.checkout_quote_lines l where l.quote_id=template.id;
        for i in 1..n loop
          insert into commerce.checkout_quotes(customer_id,idempotency_key,request_hash,pricing_hash,currency,
            subtotal,total,shipping_address,expires_at)
          values(template.customer_id,gen_random_uuid()::text,template.request_hash,template.pricing_hash,'USD',
            30,30,template.shipping_address,template.expires_at) returning checkout_quotes.id into v_quote_id;
          insert into commerce.checkout_quote_lines(quote_id,variant_id,product_id,location_id,name,
            unit_price,quantity,total,line_total,track_inventory)
          values(v_quote_id,line.variant_id,line.product_id,line.location_id,line.name,10,3,30,30,true);
          update commerce.checkout_quotes set status='cancelled' where checkout_quotes.id=v_quote_id;
        end loop;
      end $$`);
    const [definition] = await sql`select prosrc from pg_proc where oid='private.active_reserved_quantity(uuid,uuid,uuid)'::regprocedure`;
    const query = definition.prosrc.replaceAll('p_variant_id', '$1::uuid').replaceAll('p_location_id', '$2::uuid').replaceAll('p_exclude_quote_id', 'null::uuid');
    const nodes = (plan: Record<string, any>): Record<string, any>[] => [plan, ...(plan.Plans ?? []).flatMap(nodes)];
    for (const count of [0, 1000, 10000]) {
      if (count) await sql`select pg_temp.reservation_history(${count === 1000 ? 1000 : 9000})`;
      await sql`analyze commerce.inventory_reservations`;
      await sql`analyze commerce.checkout_quote_lines`;
      await sql`analyze commerce.checkout_quotes`;
      const [explain] = await sql.unsafe(`explain (analyze,buffers,format json) ${query}`, [f.v, f.location]);
      const plan = explain['QUERY PLAN'][0];
      expect(nodes(plan.Plan).filter(n => n['Relation Name']).map(n => n['Relation Name'])).toEqual(['inventory_reservations']);
      expect((await sql`select private.active_reserved_quantity(${f.v}::uuid,${f.location}::uuid) n`)[0].n).toBe(3);
      expect((await sql`select count(*)::int n from commerce.checkout_quote_lines where variant_id=${f.v}::uuid`)[0].n).toBe(count + 1);
      console.info(`reservation-history rows=${count} execution_ms=${plan['Execution Time']} buffers=${plan.Plan['Shared Hit Blocks']}`);
    }
    // Eligibility, not a forced production plan or wall-clock threshold.
    await sql`set local enable_seqscan=off`;
    const [explain] = await sql`explain (format json) select in_stock from public.product_listing where id=${f.p}::uuid`;
    const scans = nodes(explain['QUERY PLAN'][0].Plan).filter(n => n['Relation Name'] === 'inventory_reservations');
    expect(scans).toHaveLength(1);
    // A bitmap heap scan keeps its index conditions on a child index scan.
    expect(scans[0]['Node Type']).not.toBe('Seq Scan');
    const conditions = nodes(scans[0]).map(n => n['Index Cond'] ?? '').join(' ');
    expect(conditions).toContain('variant_id =');
    expect(conditions).toContain('location_id =');
    expect((await sql`select in_stock from public.product_listing where id=${f.p}::uuid`)[0].in_stock).toBe(true);
    await sql`set constraints all immediate`;
  });
}, 120000);
