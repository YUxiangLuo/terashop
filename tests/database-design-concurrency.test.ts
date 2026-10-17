import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { TransactionSQL } from 'bun';
import { withRollback } from '../scripts/lib/transactions';
import { testDatabase, staleAfterCommit as runStale } from './database-concurrency';
import { api, makeAdmin, rpc, signup, TEST_ADDRESS, type TestUser } from './helpers';
import { checked, fixtureOrder, paymentFixture, type PaymentFixture } from './payment-fixtures';

const database = testDatabase();
let admin: TestUser;
const fixtures: PaymentFixture[] = [];
beforeAll(async () => { admin = await signup(); await makeAdmin(admin.userId); });
afterAll(async () => {
  for (const f of fixtures) await checked(api(`/rest/v1/products?id=eq.${f.productId}`, { service: true, method: 'PATCH', body: { status: 'archived' } }));
  await database.close();
});
async function fixture() { const f = await paymentFixture(admin); fixtures.push(f); return f; }
async function actor(sql: TransactionSQL, user: TestUser) {
  await sql`select set_config('request.jwt.claims',${JSON.stringify({ sub: user.userId, role: 'authenticated' })},true)`;
}

const staleAfterCommit = (run: (sql: TransactionSQL) => Promise<unknown>, commit: () => Promise<unknown>, isolation: 'repeatable read' | 'read committed' = 'repeatable read') =>
  runStale(database, run, commit, isolation);

for (const isolation of ['read committed', 'repeatable read'] as const)
for (const mode of ['insert', 'update'] as const)
test(`直接账本写入不能超退：${mode} / ${isolation}`, async () => {
  const f = await fixture(), buyer = await signup(), order = await fixtureOrder(f, buyer, 1, false);
  await checked(rpc('mark_order_paid', { idempotency_key: crypto.randomUUID(), order_id: order.id }, admin.token));
  const id = crypto.randomUUID(), amount = order.total * 0.6;
  if (mode === 'update') await database`insert into commerce.payment_transactions(id,order_id,provider,kind,status,amount,currency)
    values (${id}::uuid,${order.id}::uuid,'manual','refund','pending',${amount},${order.currency})`;
  const result = await staleAfterCommit(async sql => {
    if (mode === 'update') return sql`update commerce.payment_transactions set status='succeeded' where id=${id}::uuid`;
    return sql`insert into commerce.payment_transactions(order_id,provider,kind,status,amount,currency)
      values (${order.id}::uuid,'manual','refund','succeeded',${amount},${order.currency})`;
  }, () => database`insert into commerce.payment_transactions(order_id,provider,kind,status,amount,currency)
      values (${order.id}::uuid,'manual','refund','succeeded',${amount},${order.currency})`, isolation);
  if (isolation === 'repeatable read') expect(result.error).toMatchObject({ errno: '40001' });
  else expect(result.error?.message).toContain('refund amount exceeds captured amount');
  const [row] = await database`select sum(amount)::float8 total from commerce.payment_transactions
    where order_id=${order.id}::uuid and kind='refund' and status='succeeded'`;
  expect(row.total).toBe(amount);
});

for (const isolation of ['read committed', 'repeatable read'] as const)
for (const mode of ['change-definition', 'create-definition', 'definition-first'] as const)
test(`Metafield 类型关系串行化：${mode} / ${isolation}`, async () => {
  const namespace = `race-${crypto.randomUUID()}`, owner = crypto.randomUUID();
  try {
    if (mode === 'change-definition') await database`insert into public.metafield_definitions(owner_type,namespace,key,name,type)
      values('shop',${namespace},'x','x','text')`;
    await database.begin(async first => {
      await first.unsafe(`set transaction isolation level ${isolation}`);
      if (mode === 'definition-first') await first`insert into public.metafield_definitions(owner_type,namespace,key,name,type)
        values('shop',${namespace},'x','x','number')`;
      else await first`insert into public.metafields(owner_type,owner_id,namespace,key,type,value)
        values('shop',${owner}::uuid,${namespace},'x','text','"text"')`;
      // The first statement has completed but remains uncommitted.
      const error = await database.begin(async second => {
        await second.unsafe(`set transaction isolation level ${isolation}`);
        await second`set local lock_timeout='2s'`;
        if (mode === 'change-definition') await second`update public.metafield_definitions set type='number' where namespace=${namespace}`;
        else if (mode === 'create-definition') await second`insert into public.metafield_definitions(owner_type,namespace,key,name,type)
          values('shop',${namespace},'x','x','number')`;
        else await second`insert into public.metafields(owner_type,owner_id,namespace,key,type,value)
          values('shop',${owner}::uuid,${namespace},'x','text','"text"')`;
      }).then(() => null, error => error);
      expect(error).toMatchObject({ errno: '55P03', message: 'metafield key is being modified; retry transaction' });
    });
    expect(await database`select m.id from public.metafields m join public.metafield_definitions d
      using(owner_type,namespace,key) where m.namespace=${namespace} and m.type<>d.type`).toHaveLength(0);
  } finally {
    await database`delete from public.metafields where namespace=${namespace}`;
    await database`delete from public.metafield_definitions where namespace=${namespace}`;
  }
});

for (const exists of [false, true]) test(`Metafield 定义提交后旧 RR 快照拒绝写入旧类型（已有定义=${exists}）`, async () => {
  const namespace = `stale-${crypto.randomUUID()}`;
  try {
    if (exists) await database`insert into public.metafield_definitions(owner_type,namespace,key,name,type)
      values('shop',${namespace},'x','x','text')`;
    const result = await staleAfterCommit(async sql => {
      await sql`insert into public.metafields(owner_type,owner_id,namespace,key,type,value)
        values('shop',${crypto.randomUUID()}::uuid,${namespace},'x','text','"text"')`;
    }, async () => {
      if (exists) await database`update public.metafield_definitions set type='number' where namespace=${namespace}`;
      else await database`insert into public.metafield_definitions(owner_type,namespace,key,name,type)
        values('shop',${namespace},'x','x','number')`;
    });
    expect(result.error).toMatchObject({ errno: '40001' });
  } finally {
    await database`delete from public.metafields where namespace=${namespace}`;
    await database`delete from public.metafield_definitions where namespace=${namespace}`;
  }
});

for (const action of ['quote', 'order', 'adjust'] as const) test(`新 Quote 提交后，旧 RR 快照不能通过 ${action} 再消耗相同可用库存`, async () => {
  const f = await fixture(), first = await signup(), second = await signup();
  await checked(rpc('adjust_inventory', { idempotency_key: crypto.randomUUID(), variant_id: f.variantId, delta: -99 }, admin.token));
  let quoteId: string | undefined;
  const result = await staleAfterCommit(async sql => {
    await actor(sql, action === 'adjust' ? admin : second);
    if (action === 'adjust') return sql`select public.adjust_inventory(${f.variantId}::uuid,-1,${crypto.randomUUID()})`;
    if (action === 'order') return (await sql`select public.create_order(jsonb_build_array(jsonb_build_object('variant_id',${f.variantId}::uuid,'quantity',1)),${crypto.randomUUID()},address=>${JSON.stringify(TEST_ADDRESS)}::text::jsonb) o`)[0].o;
    return (await sql`select public.create_checkout_quote(jsonb_build_array(jsonb_build_object('variant_id',${f.variantId}::uuid,'quantity',1)),${crypto.randomUUID()},address=>${JSON.stringify(TEST_ADDRESS)}::text::jsonb) q`)[0].q;
  }, async () => {
    quoteId = (await checked<{ id: string }>(rpc('create_checkout_quote', { items: [{ variant_id: f.variantId, quantity: 1 }], address: TEST_ADDRESS, idempotency_key: crypto.randomUUID() }, first.token))).id;
  });
  try {
    expect(result.error).toMatchObject({ errno: '40001' });
    const [row] = await database`select on_hand,private.active_reserved_quantity(variant_id,location_id) reserved from public.inventory_levels where variant_id=${f.variantId}::uuid`;
    expect(row).toEqual({ on_hand: 1, reserved: 1 });
  } finally {
    if (quoteId) await checked(rpc('cancel_checkout_quote', { quote_id: quoteId }, first.token));
    if (result.value && action !== 'adjust') {
      const id = (result.value as { id: string }).id;
      await checked(rpc(action === 'quote' ? 'cancel_checkout_quote' : 'cancel_order', action === 'quote' ? { quote_id: id } : { order_id: id }, second.token));
    }
  }
});

for (const direct of [false, true]) test(`连续部分履约无状态变化时，${direct ? '直接 INSERT' : 'RPC'} 也拒绝旧 RR 快照超发`, async () => {
  const f = await fixture(), buyer = await signup(), order = await fixtureOrder(f, buyer, 4, false);
  await checked(rpc('mark_order_paid', { idempotency_key: crypto.randomUUID(), order_id: order.id }, admin.token));
  const items = (quantity: number) => [{ order_item_id: order.itemId, quantity }];
  await checked(rpc('create_fulfillment', { idempotency_key: crypto.randomUUID(), order_id: order.id, items: items(1) }, admin.token));
  const result = await staleAfterCommit(async sql => {
    await actor(sql, admin);
    if (direct) return sql`insert into public.fulfillments(order_id,items) values (${order.id}::uuid,${JSON.stringify(items(2))}::text::jsonb)`;
    return sql`select public.create_fulfillment(${order.id}::uuid,${JSON.stringify(items(2))}::text::jsonb,${crypto.randomUUID()})`;
  }, () => checked(rpc('create_fulfillment', { idempotency_key: crypto.randomUUID(), order_id: order.id, items: items(2) }, admin.token)));
  expect(result.error).toMatchObject({ errno: '40001' });
  const [balance] = await database`select sum(quantity)::int fulfilled from commerce.fulfillment_lines where order_item_id=${order.itemId}::uuid`;
  expect(balance.fulfilled).toBe(3);
});

test('READ COMMITTED 对照：新 Quote 后的第二次报价按最新预占拒绝', async () => {
  const f = await fixture(), first = await signup(), second = await signup();
  await checked(rpc('adjust_inventory', { idempotency_key: crypto.randomUUID(), variant_id: f.variantId, delta: -99 }, admin.token));
  let id: string | undefined;
  try {
    const result = await staleAfterCommit(async sql => {
      await actor(sql, second);
      await sql`select public.create_checkout_quote(jsonb_build_array(jsonb_build_object('variant_id',${f.variantId}::uuid,'quantity',1)),${crypto.randomUUID()},address=>${JSON.stringify(TEST_ADDRESS)}::text::jsonb)`;
    }, async () => { id = (await checked<{ id: string }>(rpc('create_checkout_quote', { items: [{ variant_id: f.variantId, quantity: 1 }], address: TEST_ADDRESS, idempotency_key: crypto.randomUUID() }, first.token))).id; }, 'read committed');
    expect(result.error?.message).toContain('insufficient available stock');
  } finally { if (id) await checked(rpc('cancel_checkout_quote', { quote_id: id }, first.token)); }
});

for (const first of ['insert', 'delete'] as const) test(`metafield/商品删除的旧 RR 快照不能留下孤儿（${first} 先提交）`, async () => {
  const product = crypto.randomUUID(), meta = crypto.randomUUID();
  await database`insert into public.products(id,slug,name) values (${product}::uuid,${product},'FK concurrency')`;
  const insert = (sql: TransactionSQL | typeof database) => sql`insert into public.metafields(id,owner_type,owner_id,key,type,value) values (${meta}::uuid,'product',${product}::uuid,'text','text','"value"')`;
  const remove = (sql: TransactionSQL | typeof database) => sql`delete from public.products where id=${product}::uuid`;
  try {
    const result = await staleAfterCommit(async sql => { await (first === 'insert' ? remove(sql) : insert(sql)); }, async () => { await (first === 'insert' ? insert(database) : remove(database)); });
    expect(result.error).not.toBeNull();
    expect(['40001', '23503']).toContain(result.error.errno);
    if (first === 'insert') await remove(database); // whole transaction retry sees the committed child
    expect(await database`select id from public.metafields where id=${meta}::uuid`).toHaveLength(0);
  } finally {
    await database`delete from public.metafields where id=${meta}::uuid`;
    await database`delete from public.products where id=${product}::uuid`;
  }
});

for (const rules of [{ min: 8 }, { max: 6 }, { choices: [6, 8] }])
for (const exists of [false, true])
test(`Metafield 定义拒绝使既有值失效：${JSON.stringify(rules)} / update=${exists}`, async () => {
  const namespace = crypto.randomUUID();
  try {
    if (exists) await database`insert into public.metafield_definitions(owner_type,namespace,key,name,type)
      values ('shop',${namespace},'n','n','number')`;
    await database`insert into public.metafields(owner_type,owner_id,namespace,key,type,value)
      values ('shop',${crypto.randomUUID()}::uuid,${namespace},'n','number','7')`;
    await expect(withRollback(database, async sql => {
      if (exists) await sql`update public.metafield_definitions set validations=${JSON.stringify(rules)}::text::jsonb where namespace=${namespace}`;
      else await sql`insert into public.metafield_definitions(owner_type,namespace,key,name,type,validations)
        values ('shop',${namespace},'n','n','number',${JSON.stringify(rules)}::text::jsonb)`;
    })).rejects.toThrow('metafield "n" must be');
    if (exists) await database`update public.metafield_definitions set validations='{"min":7,"max":7,"choices":[7]}' where namespace=${namespace}`;
    else await database`insert into public.metafield_definitions(owner_type,namespace,key,name,type,validations)
      values ('shop',${namespace},'n','n','number','{"min":7,"max":7,"choices":[7]}')`;
  } finally {
    await database`delete from public.metafields where namespace=${namespace}`;
    await database`delete from public.metafield_definitions where namespace=${namespace}`;
  }
});

for (const definitionFirst of [false, true]) test(`Metafield validations 变更和旧 RR 值写入互斥：definitionFirst=${definitionFirst}`, async () => {
  const namespace = crypto.randomUUID();
  const value = (sql: TransactionSQL | typeof database) => sql`insert into public.metafields(owner_type,owner_id,namespace,key,type,value)
    values ('shop',${crypto.randomUUID()}::uuid,${namespace},'n','number','7')`;
  const definition = (sql: TransactionSQL | typeof database) => sql`update public.metafield_definitions set validations='{"max":6}' where namespace=${namespace}`;
  try {
    await database`insert into public.metafield_definitions(owner_type,namespace,key,name,type)
      values ('shop',${namespace},'n','n','number')`;
    const result = await staleAfterCommit(sql => definitionFirst ? value(sql) : definition(sql),
      () => definitionFirst ? definition(database) : value(database));
    expect(result.error).toMatchObject({ errno: '40001' });
  } finally {
    await database`delete from public.metafields where namespace=${namespace}`;
    await database`delete from public.metafield_definitions where namespace=${namespace}`;
  }
});

for (const insertFirst of [false, true]) test(`Metaobject 引用与目标删除不能留下悬空引用：insertFirst=${insertFirst}`, async () => {
  const definition = crypto.randomUUID(), object = crypto.randomUUID(), meta = crypto.randomUUID();
  const insert = (sql: TransactionSQL | typeof database) => sql`insert into public.metafields(id,owner_type,owner_id,key,type,value)
    values (${meta}::uuid,'shop',${meta}::uuid,${meta},'metaobject_reference',to_jsonb(${object}::text))`;
  const remove = (sql: TransactionSQL | typeof database) => sql`delete from public.metaobjects where id=${object}::uuid`;
  try {
    await database`insert into public.metaobject_definitions(id,type,name,fields) values (${definition}::uuid,${definition},'refs','[]')`;
    await database`insert into public.metaobjects(id,definition_id,handle) values (${object}::uuid,${definition}::uuid,'object')`;
    const result = await staleAfterCommit(sql => insertFirst ? remove(sql) : insert(sql),
      () => insertFirst ? insert(database) : remove(database));
    expect(result.error).not.toBeNull();
    expect(['40001','23503']).toContain(result.error.errno);
    if (insertFirst) {
      await expect(withRollback(database, sql => sql`delete from public.metaobject_definitions where id=${definition}::uuid`)).rejects.toMatchObject({ errno: '23503' });
      await database`update public.metafields set type='list_metaobject_reference',value=jsonb_build_array(${object}::text,${object}::text) where id=${meta}::uuid`;
      expect(await database`select target_id from private.metafield_metaobject_refs where metafield_id=${meta}::uuid`).toHaveLength(1);
      await database`update public.metafields set value='[]' where id=${meta}::uuid`;
      expect(await database`select target_id from private.metafield_metaobject_refs where metafield_id=${meta}::uuid`).toHaveLength(0);
      await remove(database);
    }
  } finally {
    await database`delete from public.metafields where id=${meta}::uuid`;
    await database`delete from public.metaobject_definitions where id=${definition}::uuid`;
  }
});
