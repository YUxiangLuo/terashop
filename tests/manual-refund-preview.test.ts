import { afterAll, beforeAll, expect, test } from 'bun:test';
import { api, rpc, signup, makeAdmin, stockOf, TEST_ADDRESS, type TestUser } from './helpers';
import { checked, paymentFixture, fixtureOrder, fixtureIntent, settleIntent, type PaymentFixture } from './payment-fixtures';
import { heldTransactionRace, staleAfterCommit, testDatabase } from './database-concurrency';

const database = testDatabase();
let admin: TestUser, buyer: TestUser, fixture: PaymentFixture;
let shipping: string, tax: string, promotion: string;
const code = `REFUND-PREVIEW-${crypto.randomUUID()}`;
beforeAll(async () => {
  admin = await signup(); buyer = await signup(); await makeAdmin(admin.userId);
  fixture = await paymentFixture(admin);
  const insert = async (table: string, body: object) => (await checked<Array<{id:string}>>(api(`/rest/v1/${table}`, { service:true, method:'POST', body })))[0].id;
  shipping = await insert('shipping_methods', { name:'Preview shipping', price:4, countries:['AQ'] });
  tax = await insert('tax_rates', { name:'Preview tax', country:'AQ', rate:0.13, include_shipping:true });
  promotion = await insert('promotions', { name:'Preview discount', code, type:'order_fixed', params:{amount:0.01}, stackable:true });
});
afterAll(async () => {
  for (const [table,id] of [['shipping_methods',shipping],['tax_rates',tax],['promotions',promotion]])
    if (id) await checked(api(`/rest/v1/${table}?id=eq.${id}`, {service:true,method:'PATCH',body:{is_active:false}}));
  if (fixture) await checked(api(`/rest/v1/products?id=eq.${fixture.productId}`, {service:true,method:'PATCH',body:{status:'archived'}}));
  await database.close();
});
const lines = (id:string, quantity:number) => [{order_item_id:id,quantity}];
async function paid(quantity = 3) {
  const order = await fixtureOrder(fixture, buyer, quantity);
  await checked(rpc('mark_order_paid',{order_id:order.id,idempotency_key:crypto.randomUUID()},admin.token));
  return order;
}
const preview = (args:object) => checked<any>(rpc('preview_manual_refund',args,admin.token));
const commit = (args:object) => checked<any>(rpc('commit_manual_refund',args,admin.token));
const ledger = (id:string) => checked<any>(rpc('get_order_ledger',{order_id:id},admin.token));
const command = (args:object, p:any) => ({...args,preview_token:p.preview_token,idempotency_key:crypto.randomUUID(),reason:'Offline refund confirmed'});

test('preview has no business writes; exact item effects commit once and replay after fully refunded', async () => {
  const o = await paid(2), before = await ledger(o.id), stock = await stockOf(fixture.sku);
  const args = {order_id:o.id,items:lines(o.itemId,2),restock:true};
  const p = await preview(args);
  expect(p).toMatchObject({amount:20,currency:'USD',available_amount:20,source:'items',restock:true});
  expect(p.lines).toEqual([{order_item_id:o.itemId,quantity:2,amount:20,cancelled_quantity:2,restocked_quantity:2,restock_shipped_quantity:0}]);
  expect(p.components).toEqual([]);
  expect(await ledger(o.id)).toEqual(before);
  expect(await stockOf(fixture.sku)).toBe(stock);
  expect(p.preview_token).toMatch(/^[a-f0-9]{64}$/);
  const c = command(args,p);
  const [result, duplicate] = await Promise.all([commit(c), commit(c)]);
  expect(duplicate).toEqual(result);
  expect(result.refund.lines).toEqual(p.lines);
  expect(result.refund.amount).toBe(20);
  expect(await stockOf(fixture.sku)).toBe(stock+2);
  expect(await commit(c)).toEqual(result);
  expect((await ledger(o.id)).refunds).toHaveLength(1);
  expect(await stockOf(fixture.sku)).toBe(stock+2);
  const changed = await rpc('commit_manual_refund',{...c,reason:'changed'},admin.token);
  expect(changed.status).toBe(400);
  const legacy = await rpc('refund_order',{order_id:o.id,idempotency_key:c.idempotency_key,amount:1},admin.token);
  expect(legacy.status).toBe(400);
});

test('discount and item/shipping tax rounding are identical to execution; last unit absorbs remainder', async () => {
  const o = await checked<any>(rpc('create_order', {
    items:[{variant_id:fixture.variantId,quantity:3}], address:{...TEST_ADDRESS,country:'AQ'},
    shipping_method_id:shipping,discount_code:code,idempotency_key:crypto.randomUUID(),
  },buyer.token));
  await checked(rpc('mark_order_paid',{order_id:o.id,idempotency_key:crypto.randomUUID()},admin.token));
  const prices = await checked<any>(rpc('get_order_pricing',{order_id:o.id},admin.token));
  const item = prices.lines[0];
  // $30 - $0.01 = $29.99; 13% item tax = $3.90; shipping $4 + $0.52 tax.
  expect(prices.total).toBe(38.41);
  const amounts = [15.82,11.3,11.29];
  for (let index=0; index<3; index++) {
    const args = {order_id:o.id,items:lines(item.id,1),...(index===0?{shipping_amount:4}:{}),restock:false};
    const p = await preview(args);
    expect(p.amount).toBe(amounts[index]);
    expect(p.lines[0].amount).toBe(index===2?9.99:10);
    expect(p.lines[0].restocked_quantity).toBe(0);
    expect(p.components.filter((c:any)=>c.kind==='tax').map((c:any)=>c.amount).sort()).toEqual(index===0?[0.52,1.3]:[1.3]);
    const result = await commit(command(args,p));
    expect(result.refund.components).toEqual(p.components);
    expect(result.refund.lines).toEqual(p.lines);
  }
  expect((await ledger(o.id)).balances).toMatchObject({refunded:38.41,is_balanced:true});
});

test('explicit amount scope requires a preview and never defaults to remaining balance', async () => {
  const o = await paid();
  for (const extra of [{},{amount:0},{amount:1.001},{amount:1,items:lines(o.itemId,1)},{amount:1,restock:true}]) {
    expect((await rpc('preview_manual_refund',{order_id:o.id,...extra},admin.token)).status).toBe(400);
  }
  const args = {order_id:o.id,amount:7.25};
  const p = await preview(args);
  expect(p.components).toEqual([{kind:'unallocated',tax_line_id:null,shipping_line_id:null,amount:7.25}]);
  expect(p.lines).toEqual([]);
  expect((await rpc('commit_manual_refund',{...command(args,p),preview_token:'0'.repeat(64)},admin.token)).status).toBe(400);
  expect((await ledger(o.id)).refunds).toHaveLength(0);
  expect((await commit(command(args,p))).refund.amount).toBe(7.25);
});

test('shipping-only refunds include tax but never cancel items or change stock', async () => {
  const o = await fixtureOrder(fixture,buyer,1,true,{shipping_method_id:shipping,address:{...TEST_ADDRESS,country:'AQ'}});
  await checked(rpc('mark_order_paid',{order_id:o.id,idempotency_key:crypto.randomUUID()},admin.token));
  const stock = await stockOf(fixture.sku);
  const args = {order_id:o.id,shipping_amount:1.25};
  const p = await preview(args);
  expect(p.amount).toBe(1.41); // $1.25 net shipping + $0.16 tax at 13%.
  expect(p.lines).toEqual([]);
  expect(p.components.map((c:any)=>[c.kind,c.amount])).toEqual([['shipping',1.25],['tax',0.16]]);
  expect((await commit(command(args,p))).refund.components).toEqual(p.components);
  expect(await stockOf(fixture.sku)).toBe(stock);
});

test('still-affordable amount preview becomes stale after another refund; failed commit is atomic', async () => {
  const o = await paid(), args = {order_id:o.id,amount:5};
  const p = await preview(args), c = command(args,p);
  await checked(rpc('refund_order',{order_id:o.id,amount:1,idempotency_key:crypto.randomUUID()},admin.token));
  const before = await ledger(o.id);
  const result = await rpc('commit_manual_refund',c,admin.token);
  expect(result.data).toMatchObject({message:'refund preview changed; preview and confirm again'});
  expect(await ledger(o.id)).toEqual(before);
  const fresh = await preview(args);
  expect(fresh.amount).toBe(5);
  expect(fresh.preview_token).not.toBe(p.preview_token);
  expect((await commit({...c,preview_token:fresh.preview_token})).refund.amount).toBe(5);
});

test('old repeatable-read snapshot cannot commit a preview after concurrent fulfillment', async () => {
  const o = await paid(2), args = {order_id:o.id,items:lines(o.itemId,2),restock:true};
  const p = await preview(args), c = command(args,p);
  const result = await staleAfterCommit(database, async tx => {
    await tx`select set_config('request.jwt.claims',${JSON.stringify({role:'authenticated',sub:admin.userId})},true)`;
    return tx`select public.commit_manual_refund(${o.id}::uuid,${p.preview_token},${c.idempotency_key},items=>${JSON.stringify(args.items)}::text::jsonb,restock=>true,reason=>'Offline refund confirmed')`;
  }, () => checked(rpc('create_fulfillment',{order_id:o.id,items:lines(o.itemId,1),idempotency_key:crypto.randomUUID()},admin.token)));
  expect(result.error).not.toBeNull();
  expect((await ledger(o.id)).refunds).toHaveLength(0);
});

test('customer/anonymous cannot preview or commit, and online orders are rejected', async () => {
  const o = await paid();
  for (const token of [buyer.token,undefined]) {
    expect((await rpc('preview_manual_refund',{order_id:o.id,amount:1},token)).status).toBeGreaterThanOrEqual(400);
    expect((await rpc('commit_manual_refund',{order_id:o.id,amount:1,preview_token:'0'.repeat(64),idempotency_key:crypto.randomUUID(),reason:'test'},token)).status).toBeGreaterThanOrEqual(400);
  }
  const online = await fixtureOrder(fixture,buyer);
  await settleIntent(await fixtureIntent(online,buyer));
  expect((await rpc('preview_manual_refund',{order_id:online.id,amount:1},admin.token)).data).toMatchObject({message:'manual-only payment history required'});
});

for (const concurrent of ['refund','fulfillment']) test(`held-lock ${concurrent} invalidates preview before any refund write`, async () => {
  const o = await paid(2);
  const args = {order_id:o.id,items:lines(o.itemId,2),restock:true};
  const p = await preview(args), c = command(args,p);
  const result = await heldTransactionRace(database, async tx => {
    await tx`select set_config('request.jwt.claims',${JSON.stringify({role:'authenticated',sub:admin.userId})},true)`;
    await tx`select id from public.orders where id=${o.id}::uuid for update`;
  }, () => rpc('commit_manual_refund',c,admin.token), async tx => {
    if (concurrent==='refund') await tx`select public.refund_order(${o.id}::uuid,${crypto.randomUUID()},amount=>1)`;
    else await tx`select public.create_fulfillment(order_id=>${o.id}::uuid,idempotency_key=>${crypto.randomUUID()},items=>${JSON.stringify(lines(o.itemId,1))}::text::jsonb)`;
  });
  expect(result.status).toBe(400);
  expect((await ledger(o.id)).refunds).toHaveLength(concurrent==='refund'?1:0);
  const [record] = await database`select count(*)::int n from commerce.command_idempotency where idempotency_key=${c.idempotency_key}`;
  expect(record.n).toBe(0);
  if (concurrent==='fulfillment') {
    expect(result.data).toMatchObject({message:'refund preview changed; preview and confirm again'});
    const fresh = await preview(args);
    expect(fresh.amount).toBe(p.amount); // Same money, different stock impact must invalidate too.
    expect(fresh.lines[0]).toMatchObject({cancelled_quantity:1,restocked_quantity:1});
    expect((await commit(command(args,fresh))).refund.lines).toEqual(fresh.lines);
  }
});
