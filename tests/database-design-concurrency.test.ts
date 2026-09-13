import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { TransactionSQL } from 'bun';
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

for (const action of ['quote', 'order', 'adjust'] as const) test(`新 Quote 提交后，旧 RR 快照不能通过 ${action} 再消耗相同可用库存`, async () => {
  const f = await fixture(), first = await signup(), second = await signup();
  await checked(rpc('adjust_inventory', { variant_id: f.variantId, delta: -99 }, admin.token));
  let quoteId: string | undefined;
  const result = await staleAfterCommit(async sql => {
    await actor(sql, action === 'adjust' ? admin : second);
    if (action === 'adjust') return sql`select public.adjust_inventory(${f.variantId}::uuid,-1)`;
    if (action === 'order') return (await sql`select public.create_order(jsonb_build_array(jsonb_build_object('variant_id',${f.variantId}::uuid,'quantity',1)),address=>${JSON.stringify(TEST_ADDRESS)}::text::jsonb) o`)[0].o;
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
  await checked(rpc('mark_order_paid', { order_id: order.id }, admin.token));
  const items = (quantity: number) => [{ order_item_id: order.itemId, quantity }];
  await checked(rpc('create_fulfillment', { order_id: order.id, items: items(1) }, admin.token));
  const result = await staleAfterCommit(async sql => {
    await actor(sql, admin);
    if (direct) return sql`insert into public.fulfillments(order_id,items) values (${order.id}::uuid,${JSON.stringify(items(2))}::text::jsonb)`;
    return sql`select public.create_fulfillment(${order.id}::uuid,${JSON.stringify(items(2))}::text::jsonb)`;
  }, () => checked(rpc('create_fulfillment', { order_id: order.id, items: items(2) }, admin.token)));
  expect(result.error).toMatchObject({ errno: '40001' });
  const [balance] = await database`select sum(quantity)::int fulfilled from commerce.fulfillment_lines where order_item_id=${order.itemId}::uuid`;
  expect(balance.fulfilled).toBe(3);
});

test('READ COMMITTED 对照：新 Quote 后的第二次报价按最新预占拒绝', async () => {
  const f = await fixture(), first = await signup(), second = await signup();
  await checked(rpc('adjust_inventory', { variant_id: f.variantId, delta: -99 }, admin.token));
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
