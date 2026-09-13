import { afterAll, beforeAll, expect, test } from 'bun:test';
import { api, rpc, signup, makeAdmin, stockOf as stockAt, TEST_ADDRESS, type TestUser } from './helpers';
import { checked, paymentFixture, fixtureOrder, fixtureIntent, settleIntent, paymentEvent, type PaymentFixture, type FixtureOrder, type FixtureIntent } from './payment-fixtures';
import { heldTransactionRace, staleAfterCommit, testDatabase } from './database-concurrency';

interface Disposition { id: string; receipt_line_id: string; quantity: number; disposition: string; inventory_movement_id: number | null }
interface Receipt { id: string; return_id: string; location_id: string; lines: Array<{ id: string; return_line_id: string; quantity: number; undisposed_quantity: number; dispositions: Disposition[] }> }
interface Return { id: string; order_id: string; fulfillment_id: string; status: string; lines: Array<{ id: string; order_item_id: string; quantity: number; received_quantity: number; receivable_quantity: number }>; receipts: Receipt[] }
interface Shipment { order: FixtureOrder; buyer: TestUser; id: string; intent?: FixtureIntent }
interface Summary { lines: Array<{ fulfillment_id: string; order_item_id: string; shipped_quantity: number; authorized_unreceived_quantity: number; received_quantity: number; available_quantity: number }>; returns: Return[] }
const database = testDatabase();
const extraProducts: string[] = [];
let fixture: PaymentFixture, admin: TestUser, location: string, secondary: string;
beforeAll(async () => {
  admin = await signup(); await makeAdmin(admin.userId); fixture = await paymentFixture(admin);
  const [home] = await checked<Array<{ id: string }>>(api('/rest/v1/locations?is_default=eq.true&select=id', { service: true })); location = home.id;
  const [other] = await checked<Array<{ id: string }>>(api('/rest/v1/locations?select=id', { service: true, method: 'POST', body: { code: `RETURN-${crypto.randomUUID()}`, name: 'Return inspection' } })); secondary = other.id;
});
afterAll(async () => {
  if (fixture) await api(`/rest/v1/products?id=eq.${fixture.productId}`, { service: true, method: 'PATCH', body: { status: 'archived' } });
  for (const id of extraProducts) await api(`/rest/v1/products?id=eq.${id}`, { service: true, method: 'PATCH', body: { status: 'archived' } });
  if (secondary) await api(`/rest/v1/locations?id=eq.${secondary}`, { service: true, method: 'PATCH', body: { is_active: false } });
  await database.close();
});
const stockOf = (sku: string) => stockAt(sku, location);
async function otherStock(): Promise<number> {
  const [row]=await database`select coalesce((select on_hand from public.inventory_levels where variant_id=${fixture.variantId}::uuid and location_id=${secondary}::uuid),0) as on_hand`;
  return row.on_hand;
}
const claims = () => JSON.stringify({ role: 'authenticated', sub: admin.userId });
const lineItems = (id: string, quantity: number) => [{ order_item_id: id, quantity }];
async function shipped(quantity = 2, fulfilled = quantity, online = false): Promise<Shipment> {
  const buyer = await signup(); const order = await fixtureOrder(fixture, buyer, quantity);
  let intent: FixtureIntent | undefined;
  if (online) { intent = await fixtureIntent(order, buyer); await settleIntent(intent); }
  else await checked(rpc('mark_order_paid', { order_id: order.id }, admin.token));
  const shipment = await checked<{ id: string }>(rpc('create_fulfillment', { idempotency_key: crypto.randomUUID(), order_id: order.id, items: lineItems(order.itemId, fulfilled) }, admin.token));
  return { buyer, order, id: shipment.id, intent };
}
const authorize = (s: Shipment, quantity = 1, key = crypto.randomUUID(), token = admin.token): Promise<Return> => checked(rpc('create_return', { fulfillment_id: s.id, items: lineItems(s.order.itemId, quantity), idempotency_key: key, reason: 'Customer return' }, token));
const receive = (r: Return, quantity = 1, at = location, key = crypto.randomUUID(), token = admin.token): Promise<Receipt> => checked(rpc('receive_return', { return_id: r.id, location_id: at, items: [{ return_line_id: r.lines[0].id, quantity }], idempotency_key: key }, token));
const disposition = (receipt: Receipt, quantity = 1, kind = 'restock', key = crypto.randomUUID(), token = admin.token): Promise<Disposition> => checked(rpc('dispose_return_receipt', { receipt_line_id: receipt.lines[0].id, quantity, disposition: kind, idempotency_key: key }, token));
const summary = (s: Shipment): Promise<Summary> => checked(rpc('get_order_returns', { order_id: s.order.id }, s.buyer.token));
const ledger = (s: Shipment): Promise<{ balances: { captured: number; refunded: number; is_balanced: boolean }; refunds: Array<{ lines: Array<{ quantity: number; restocked_quantity: number; cancelled_quantity: number }> }> }> => checked(rpc('get_order_ledger', { order_id: s.order.id }, s.buyer.token));

test('授权、收货、验收处置三步分离；只有 restock 增加可售库存，不自动退款或撤销履约', async () => {
  const s = await shipped(3); const before = await stockOf(fixture.sku);
  const r = await authorize(s, 3); expect(await stockOf(fixture.sku)).toBe(before);
  expect((await summary(s)).lines[0]).toMatchObject({ shipped_quantity: 3, authorized_unreceived_quantity: 3, available_quantity: 0 });
  const receipt = await receive(r, 3); expect(await stockOf(fixture.sku)).toBe(before);
  expect(receipt.lines[0]).toMatchObject({ quantity: 3, undisposed_quantity: 3 });
  const restocked = await disposition(receipt, 2); const discarded = await disposition(receipt, 1, 'discard');
  expect(typeof restocked.inventory_movement_id).toBe('number'); expect(discarded.inventory_movement_id).toBeNull();
  expect(await stockOf(fixture.sku)).toBe(before + 2);
  expect((await summary(s)).returns[0].receipts[0].lines[0].undisposed_quantity).toBe(0);
  expect((await ledger(s)).balances).toMatchObject({ captured: 30, refunded: 0, is_balanced: true });
  const [shipment] = await checked<Array<{ status: string }>>(api(`/rest/v1/fulfillments?id=eq.${s.id}&select=status`, { token: s.buyer.token })); expect(shipment.status).toBe('shipped');
  const events = await checked<Array<{ type: string }>>(api(`/rest/v1/order_events?order_id=eq.${s.order.id}&type=like.return.*&select=type&order=id.asc`, { service: true }));
  expect(events.map(e => e.type)).toEqual(['return.open','return.received','return.disposed','return.disposed']);
  const [outbox] = await database`select count(*)::int as n from commerce.outbox_events where aggregate_id=${s.order.id}::uuid and event_type like 'return.%'`; expect(outbox.n).toBe(4);
});

test('退货引用单次实际发货行：拒绝未发货、已取消发货、跨单/跨发货商品和超量授权', async () => {
  const s = await shipped(3, 1); const other = await shipped(1);
  const body = { fulfillment_id: s.id, idempotency_key: crypto.randomUUID(), items: lineItems(s.order.itemId, 2) };
  expect((await rpc('create_return', body, admin.token)).status).toBe(400);
  expect((await rpc('create_return', { ...body, items: lineItems(other.order.itemId, 1) }, admin.token)).status).toBe(409);
  await checked(api(`/rest/v1/fulfillments?id=eq.${other.id}`, { service: true, method: 'PATCH', body: { status: 'cancelled' } }));
  expect((await rpc('create_return', { ...body, fulfillment_id: other.id, items: lineItems(other.order.itemId, 1) }, admin.token)).status).toBe(400);
  const r = await authorize(s); expect(r.lines[0].quantity).toBe(1);
  expect((await rpc('create_return', { ...body, items: lineItems(s.order.itemId, 1) }, admin.token)).status).toBe(400);
});

test('相同 SKU 的商业行不混用；规范化拆行/重排重试保持同一授权与 receipt UUID', async () => {
  const buyer = await signup();
  const quote = await checked<{ id: string }>(rpc('create_checkout_quote', { idempotency_key: crypto.randomUUID(), address: TEST_ADDRESS,
    items: ['Alice','Bob'].map(name => ({ variant_id: fixture.variantId, quantity: 2, attributes: { name } })) }, buyer.token));
  const order = await checked<{ id: string }>(rpc('create_order_from_quote', { quote_id: quote.id }, buyer.token));
  await checked(rpc('mark_order_paid', { order_id: order.id }, admin.token));
  const lines = await checked<Array<{ id: string; attributes: { name: string } }>>(api(`/rest/v1/order_items?order_id=eq.${order.id}&select=id,attributes`, { token: buyer.token }));
  const f = await checked<{ id: string }>(rpc('create_fulfillment', { idempotency_key: crypto.randomUUID(), order_id: order.id, items: lines.map(l => ({ order_item_id: l.id, quantity: 2 })) }, admin.token));
  const partial = await checked<Return>(rpc('create_return', { fulfillment_id:f.id,items:lineItems(lines[0].id,1),idempotency_key:crypto.randomUUID() },admin.token));
  await expect(database`insert into commerce.return_lines(return_id,order_id,fulfillment_id,order_item_id,quantity)
    values (${partial.id}::uuid,${order.id}::uuid,${f.id}::uuid,${lines[1].id}::uuid,1)`.execute()).rejects.toThrow('authorization fingerprint');
  await checked(rpc('close_return',{return_id:partial.id,cancel:true},admin.token));
  const key = crypto.randomUUID(); const items = lines.map(l => ({ order_item_id: l.id, quantity: 2 }));
  const r = await checked<Return>(rpc('create_return', { fulfillment_id: f.id, items, idempotency_key: key }, admin.token));
  const split = [...items].reverse().flatMap(l => [l,l].map(e => ({ ...e, order_item_id: e.order_item_id.toUpperCase(), quantity: 1 })));
  expect(await checked<Return>(rpc('create_return', { fulfillment_id: f.id, items: split, idempotency_key: key }, admin.token))).toEqual(r);
  const initialReceipt = await receive(r,1);
  await expect(database`insert into commerce.return_receipt_lines(receipt_id,return_id,order_id,return_line_id,quantity)
    values (${initialReceipt.id}::uuid,${r.id}::uuid,${order.id}::uuid,${r.lines[1].id}::uuid,1)`.execute()).rejects.toThrow('receipt fingerprint');
  const command = { return_id: r.id, location_id: location, idempotency_key: crypto.randomUUID(), items: r.lines.map((l,i) => ({ return_line_id: l.id, quantity: i===0?1:2 })) };
  const receipt = await checked<Receipt>(rpc('receive_return', command, admin.token));
  expect(await checked<Receipt>(rpc('receive_return', { ...command, items: [...command.items].reverse() }, admin.token))).toEqual(receipt);
  expect(receipt.lines).toHaveLength(2); expect(new Set(receipt.lines.map(l => l.return_line_id)).size).toBe(2);
  expect((await rpc('receive_return', { ...command, note: 'changed' }, admin.token)).status).toBe(400);
});

test('收货与处置支持分批，未知字段、跨 Return 行、超收/超处置及相同键参数冲突全部回滚', async () => {
  const s = await shipped(3); const r = await authorize(s, 3); const foreign = await authorize(await shipped(1));
  const first = await receive(r, 1); const second = await receive(r, 2); const before = await stockOf(fixture.sku);
  const bad = { return_id: r.id, location_id: location, idempotency_key: crypto.randomUUID(), items: [{ return_line_id: r.lines[0].id, quantity: 1 }] };
  expect((await rpc('receive_return', bad, admin.token)).status).toBe(400);
  expect((await rpc('receive_return', { ...bad, items: [{ return_line_id: foreign.lines[0].id, quantity: 1 }] }, admin.token)).status).toBe(409);
  expect((await rpc('receive_return', { ...bad, items: [{ ...bad.items[0], restock: true }] }, admin.token)).status).toBe(400);
  const key = crypto.randomUUID(); const d = await disposition(second, 1, 'restock', key);
  expect(await disposition(second, 1, 'restock', key)).toEqual(d);
  expect((await rpc('dispose_return_receipt', { receipt_line_id: second.lines[0].id, quantity: 1, disposition: 'discard', idempotency_key: key }, admin.token)).status).toBe(400);
  expect((await rpc('dispose_return_receipt', { receipt_line_id: second.lines[0].id, quantity: 2, disposition: 'restock', idempotency_key: crypto.randomUUID() }, admin.token)).status).toBe(400);
  await disposition(second, 1, 'discard'); await disposition(first, 1, 'discard');
  expect(await stockOf(fixture.sku)).toBe(before + 1);
});

test('关闭释放未收余额但保留实收占用；取消只能无收货，终态不能重开或继续收货', async () => {
  const s = await shipped(3); const r = await authorize(s, 3); const receipt = await receive(r, 1);
  expect((await rpc('close_return', { return_id: r.id, cancel: true }, admin.token)).status).toBe(400);
  const closed = await checked<Return>(rpc('close_return', { return_id: r.id }, admin.token));
  expect(await checked<Return>(rpc('close_return', { return_id: r.id }, admin.token))).toEqual(closed);
  expect(closed.lines[0]).toMatchObject({ received_quantity: 1, receivable_quantity: 0 });
  expect((await summary(s)).lines[0]).toMatchObject({ authorized_unreceived_quantity: 0, received_quantity: 1, available_quantity: 2 });
  const next = await authorize(s, 2); await checked(rpc('close_return', { return_id: next.id, cancel: true }, admin.token));
  expect((await summary(s)).lines[0].available_quantity).toBe(2);
  expect((await rpc('receive_return', { return_id: r.id, location_id: location, items: [{ return_line_id: r.lines[0].id, quantity: 1 }], idempotency_key: crypto.randomUUID() }, admin.token)).status).toBe(400);
  expect((await rpc('close_return', { return_id: next.id }, admin.token)).status).toBe(400);
  // Closing receipt acceptance does not guess an inspection result.
  expect((await disposition(receipt, 1, 'discard')).quantity).toBe(1);
  expect((await api(`/rest/v1/fulfillments?id=eq.${s.id}`, { service: true, method: 'PATCH', body: { status: 'cancelled' } })).status).toBe(400);
});

test('未收货授权会阻止撤销发货，取消授权后才可撤销且不改变库存', async () => {
  const s = await shipped(1); const r = await authorize(s); const before = await stockOf(fixture.sku);
  expect((await api(`/rest/v1/fulfillments?id=eq.${s.id}`, { service: true, method: 'PATCH', body: { status: 'cancelled' } })).status).toBe(400);
  await checked(rpc('close_return', { return_id: r.id, cancel: true }, admin.token));
  await checked(api(`/rest/v1/fulfillments?id=eq.${s.id}`, { service: true, method: 'PATCH', body: { status: 'cancelled' } }));
  expect((await summary(s)).lines[0]).toMatchObject({ shipped_quantity: 0, available_quantity: 0 }); expect(await stockOf(fixture.sku)).toBe(before);
});

test('实收地点必须显式、活跃；回库至该地点而非默认仓，停用后只能报废或恢复地点后再回库', async () => {
  const s = await shipped(2); const r = await authorize(s, 2); const before = await stockOf(fixture.sku);
  const receipt = await receive(r, 2, secondary); const secondaryBefore=await otherStock();
  await disposition(receipt, 1);
  expect(await stockOf(fixture.sku)).toBe(before);
  const [level] = await checked<Array<{ on_hand: number }>>(api(`/rest/v1/inventory_levels?variant_id=eq.${fixture.variantId}&location_id=eq.${secondary}&select=on_hand`, { service: true })); expect(level.on_hand).toBe(secondaryBefore+1);
  await checked(api(`/rest/v1/locations?id=eq.${secondary}`, { service: true, method: 'PATCH', body: { is_active: false } }));
  try {
    expect((await rpc('dispose_return_receipt', { receipt_line_id: receipt.lines[0].id, quantity: 1, disposition: 'restock', idempotency_key: crypto.randomUUID() }, admin.token)).status).toBe(400);
    await disposition(receipt, 1, 'discard');
    const another = await authorize(await shipped(1));
    expect((await rpc('receive_return', { return_id: another.id, location_id: secondary, items: [{ return_line_id: another.lines[0].id, quantity: 1 }], idempotency_key: crypto.randomUUID() }, admin.token)).status).toBe(400);
  } finally { await checked(api(`/rest/v1/locations?id=eq.${secondary}`, { service: true, method: 'PATCH', body: { is_active: true } })); }
});

for (const beforeRefund of [true,false]) test(`已发货商品${beforeRefund ? '先回库后退款' : '先退款后收货'}，restock=true 不造成双重回库`, async () => {
  const s = await shipped(2); const before = await stockOf(fixture.sku);
  const r = await authorize(s, 2);
  if (beforeRefund) await disposition(await receive(r, 2), 2);
  await checked(rpc('refund_order', { order_id: s.order.id, items: lineItems(s.order.itemId, 2), restock: true, idempotency_key: crypto.randomUUID() }, admin.token));
  expect(await stockOf(fixture.sku)).toBe(before + (beforeRefund ? 2 : 0));
  expect((await ledger(s)).refunds[0].lines[0]).toMatchObject({ quantity: 2, cancelled_quantity: 0, restocked_quantity: 0 });
  if (!beforeRefund) await disposition(await receive(r, 2), 2);
  expect(await stockOf(fixture.sku)).toBe(before + 2);
  expect((await ledger(s)).balances).toMatchObject({ refunded: 20, is_balanced: true });
});

test('混合退款仅释放未发货取消量；实收报废不回库，实收回库量与取消量合计不超过原扣减', async () => {
  const s = await shipped(4, 2); const before = await stockOf(fixture.sku);
  await checked(rpc('refund_order', { idempotency_key: crypto.randomUUID(), order_id: s.order.id, items: lineItems(s.order.itemId, 4), restock: true }, admin.token));
  expect((await ledger(s)).refunds[0].lines[0]).toMatchObject({ quantity: 4, cancelled_quantity: 2, restocked_quantity: 2 });
  expect(await stockOf(fixture.sku)).toBe(before + 2);
  const r = await authorize(s, 2); const receipt = await receive(r, 2);
  await disposition(receipt, 1); await disposition(receipt, 1, 'discard');
  expect(await stockOf(fixture.sku)).toBe(before + 3);
  const moves = await checked<Array<{ reason: string; delta: number }>>(api(`/rest/v1/inventory_movements?order_id=eq.${s.order.id}&delta=gt.0&select=reason,delta&order=id.asc`, { service: true }));
  expect(moves).toEqual([{ reason: 'cancel', delta: 2 }, { reason: 'return', delta: 1 }]);
});

test('退回另一仓后再退款，未发货量仍只恢复原扣减仓，不重复恢复目的仓', async () => {
  const s=await shipped(2,1); const before=await stockOf(fixture.sku);
  const receipt=await receive(await authorize(s),1,secondary);
  const prior=await otherStock();
  await disposition(receipt);
  await checked(rpc('refund_order',{ idempotency_key: crypto.randomUUID(),order_id:s.order.id,items:lineItems(s.order.itemId,2),restock:true},admin.token));
  expect(await stockOf(fixture.sku)).toBe(before+1);
  expect(await otherStock()).toBe(prior+1);
  expect((await ledger(s)).refunds[0].lines[0]).toMatchObject({restocked_quantity:1,cancelled_quantity:1});
});

test('保留未发货量时可选择纯金额退款；Return 不自动改写既有商品退款的取消语义', async () => {
  const s=await shipped(2,1); await disposition(await receive(await authorize(s)));
  await checked(rpc('refund_order',{ idempotency_key: crypto.randomUUID(),order_id:s.order.id,amount:10},admin.token));
  const balance=await checked<{lines:Array<{available_quantity:number;cancelled_quantity:number}>}>(rpc('get_order_fulfillment_balance',{order_id:s.order.id},s.buyer.token));
  expect(balance.lines[0]).toMatchObject({available_quantity:1,cancelled_quantity:0});
  await checked(rpc('create_fulfillment',{idempotency_key:crypto.randomUUID(),order_id:s.order.id,items:lineItems(s.order.itemId,1)},admin.token));
  expect((await ledger(s)).balances).toMatchObject({captured:20,refunded:10,is_balanced:true});
});

test('PayPal 退款请求与 Return 独立，异步成功只释放原取消预留；回库与事件重放不重复改库存', async () => {
  const s = await shipped(3, 2, true); const before = await stockOf(fixture.sku);
  const request = await checked<{ id: string; amount: number; currency: string }>(rpc('create_refund_request', { order_id: s.order.id, actor_id: admin.userId, provider: 'paypal', items: lineItems(s.order.itemId, 3), restock: true, idempotency_key: crypto.randomUUID() }, undefined, true));
  const r = await authorize(s, 2); const receipt = await receive(r, 2); await disposition(receipt, 2);
  expect(await stockOf(fixture.sku)).toBe(before + 2);
  const reference = `RETURNREFUND${crypto.randomUUID().replaceAll('-','')}`;
  await checked(rpc('bind_refund_request_provider', { refund_request_id: request.id, provider_reference: reference, provider_status: 'pending', amount: request.amount, currency: request.currency }, undefined, true));
  const data = { object_type: 'refund', status: 'completed', amount: request.amount.toFixed(2), currency: 'USD', capture_reference: `CAPTURE${s.intent!.id.replaceAll('-','')}`, metadata: { tera_refund_request_id: request.id } };
  for (let i=0;i<2;i++) expect(await paymentEvent('paypal','paypal.refund.api_result',reference,data)).toMatchObject({ status: 'processed', outcome: 'refunded' });
  expect(await stockOf(fixture.sku)).toBe(before + 3);
  expect((await ledger(s)).refunds[0].lines[0]).toMatchObject({ quantity: 3, cancelled_quantity: 1, restocked_quantity: 1 });
  expect((await ledger(s)).balances).toMatchObject({ refunded: 30, is_balanced: true });
});

test('退款回库触发器不能凭无资金关联的成功头生成库存，失败整笔回滚', async () => {
  const s=await shipped(2,1); const before=await stockOf(fixture.sku);
  await expect(database.begin(async tx=>{
    const [r]=await tx`insert into commerce.refunds(order_id,status,source,amount,currency,restock_requested)
      values (${s.order.id}::uuid,'succeeded','items',10,'USD',true) returning id`;
    await tx`insert into commerce.refund_lines(refund_id,order_id,order_item_id,quantity,amount)
      values (${r.id}::uuid,${s.order.id}::uuid,${s.order.itemId}::uuid,1,10)`;
  })).rejects.toThrow('successful refund payment');
  expect(await stockOf(fixture.sku)).toBe(before);
});

test('只退金额也可以稍后收货处置，不猜商品退款数量', async () => {
  const s = await shipped(2); await checked(rpc('refund_order', { idempotency_key: crypto.randomUUID(), order_id: s.order.id }, admin.token));
  const r = await authorize(s, 2); await disposition(await receive(r, 2), 2);
  const current = await ledger(s); expect(current.refunds[0].lines).toEqual([]); expect(current.balances.refunded).toBe(20);
  const [item] = await database`select refunded_quantity from public.order_items where id=${s.order.itemId}::uuid`; expect(item.refunded_quantity).toBe(0);
});

test('零价商品仍可实际收货和回库，不通过虚构零金额退款驱动库存', async () => {
  const free = await paymentFixture(admin); extraProducts.push(free.productId);
  await checked(api(`/rest/v1/product_variants?id=eq.${free.variantId}`, { service:true, method:'PATCH', body:{price:0} }));
  const buyer=await signup();
  const order=await checked<{id:string}>(rpc('create_order',{idempotency_key:crypto.randomUUID(),address:TEST_ADDRESS,items:[{variant_id:free.variantId,quantity:1},{variant_id:fixture.variantId,quantity:1}]},buyer.token));
  await checked(rpc('mark_order_paid',{order_id:order.id},admin.token));
  const [line]=await checked<Array<{id:string}>>(api(`/rest/v1/order_items?order_id=eq.${order.id}&variant_id=eq.${free.variantId}&select=id`,{token:buyer.token}));
  const f=await checked<{id:string}>(rpc('create_fulfillment',{idempotency_key:crypto.randomUUID(),order_id:order.id,items:lineItems(line.id,1)},admin.token));
  expect((await rpc('refund_order',{ idempotency_key: crypto.randomUUID(),order_id:order.id,items:lineItems(line.id,1),restock:true},admin.token)).status).toBe(400);
  const r=await checked<Return>(rpc('create_return',{fulfillment_id:f.id,items:lineItems(line.id,1),idempotency_key:crypto.randomUUID()},admin.token));
  await disposition(await receive(r),1);
  expect(await stockOf(free.sku)).toBe(100);
  expect(await checked(rpc('get_order_ledger',{order_id:order.id},buyer.token))).toMatchObject({balances:{captured:10,refunded:0,is_balanced:true}});
});

test('按原扣减事实判断是否可回库，而不是当前 track_inventory；无扣减的商品只能记录收货/报废', async () => {
  const tracked = await shipped(1); const before = await stockOf(fixture.sku);
  await checked(api(`/rest/v1/product_variants?id=eq.${fixture.variantId}`, { service: true, method: 'PATCH', body: { track_inventory: false } }));
  let untracked: Shipment;
  try {
    await disposition(await receive(await authorize(tracked)),1);
    expect(await stockOf(fixture.sku)).toBe(before + 1);
    untracked = await shipped(1);
  } finally { await checked(api(`/rest/v1/product_variants?id=eq.${fixture.variantId}`, { service: true, method: 'PATCH', body: { track_inventory: true } })); }
  const receipt = await receive(await authorize(untracked!));
  expect((await rpc('dispose_return_receipt', { receipt_line_id: receipt.lines[0].id, quantity: 1, disposition: 'restock', idempotency_key: crypto.randomUUID() }, admin.token)).status).toBe(400);
  expect((await disposition(receipt,1,'discard')).inventory_movement_id).toBeNull();
});

test('写操作仅管理员；读取限定订单客户/admin/service；明文幂等指纹和内部表不向客户开放', async () => {
  const s = await shipped(1); const other = await signup(); const r = await authorize(s); const receipt = await receive(r);
  for (const [name, body] of [
    ['create_return',{fulfillment_id:s.id,items:lineItems(s.order.itemId,1),idempotency_key:crypto.randomUUID()}],
    ['receive_return',{return_id:r.id,location_id:location,items:[{return_line_id:r.lines[0].id,quantity:1}],idempotency_key:crypto.randomUUID()}],
    ['dispose_return_receipt',{receipt_line_id:receipt.lines[0].id,quantity:1,disposition:'discard',idempotency_key:crypto.randomUUID()}],
    ['close_return',{return_id:r.id}],
  ] as Array<[string,object]>) {
    expect((await rpc(name,body)).status).toBe(401); expect((await rpc(name,body,s.buyer.token)).status).toBe(400);
  }
  expect((await rpc('get_order_returns',{order_id:s.order.id})).status).toBe(401);
  expect((await rpc('get_order_returns',{order_id:s.order.id},other.token)).status).toBe(400);
  expect((await rpc('get_order_returns',{order_id:s.order.id},undefined,true)).status).toBe(200);
  await checked(rpc('anonymize_customer',{customer_id:other.customerId},admin.token));
  expect((await rpc('get_order_returns',{order_id:s.order.id},other.token)).status).toBe(400);
  const visible = JSON.stringify(await summary(s)); expect(visible).not.toContain('request_hash'); expect(visible).not.toContain('idempotency_key');
  for (const role of ['anon','authenticated','service_role']) for (const table of ['returns','return_lines','return_receipts','return_receipt_lines','return_dispositions']) await expect(database.begin(async tx => {
    await tx.unsafe(`set local role ${role}`); await tx.unsafe(`select * from commerce.${table}`);
  })).rejects.toMatchObject({ errno:'42501' });
});

for (const action of ['authorize','receive','dispose']) test(`受控 ${action} 竞争不超额，相同订单父锁串行化数量检查`, async () => {
  const s = await shipped(1); const r = action==='authorize' ? undefined : await authorize(s); const receipt = action==='dispose' ? await receive(r!) : undefined;
  const before = await stockOf(fixture.sku);
  const result = await heldTransactionRace(database, async tx => {
    await tx`select set_config('request.jwt.claims',${claims()},true)`;
    if (action==='authorize') await tx`select public.create_return(${s.id}::uuid,${JSON.stringify(lineItems(s.order.itemId,1))}::text::jsonb,${crypto.randomUUID()})`;
    else if (action==='receive') await tx`select public.receive_return(${r!.id}::uuid,${location}::uuid,${JSON.stringify([{return_line_id:r!.lines[0].id,quantity:1}])}::text::jsonb,${crypto.randomUUID()})`;
    else await tx`select public.dispose_return_receipt(${receipt!.lines[0].id}::uuid,1,'restock',${crypto.randomUUID()})`;
  }, () => action==='authorize' ? rpc('create_return',{fulfillment_id:s.id,items:lineItems(s.order.itemId,1),idempotency_key:crypto.randomUUID()},admin.token)
    : action==='receive' ? rpc('receive_return',{return_id:r!.id,location_id:location,items:[{return_line_id:r!.lines[0].id,quantity:1}],idempotency_key:crypto.randomUUID()},admin.token)
    : rpc('dispose_return_receipt',{receipt_line_id:receipt!.lines[0].id,quantity:1,disposition:'discard',idempotency_key:crypto.randomUUID()},admin.token));
  expect(result.status).toBe(400); expect(await stockOf(fixture.sku)).toBe(before+(action==='dispose'?1:0));
});

for (const action of ['authorize','receive','dispose']) test(`REPEATABLE READ 旧快照不能绕过 ${action} 已提交的数量占用`, async () => {
  const s = await shipped(1); const r = action==='authorize' ? undefined : await authorize(s); const receipt = action==='dispose' ? await receive(r!) : undefined;
  const result = await staleAfterCommit(database, async tx => {
    await tx`select set_config('request.jwt.claims',${claims()},true)`;
    if (action==='authorize') await tx`select public.create_return(${s.id}::uuid,${JSON.stringify(lineItems(s.order.itemId,1))}::text::jsonb,${crypto.randomUUID()})`;
    else if (action==='receive') await tx`select public.receive_return(${r!.id}::uuid,${location}::uuid,${JSON.stringify([{return_line_id:r!.lines[0].id,quantity:1}])}::text::jsonb,${crypto.randomUUID()})`;
    else await tx`insert into commerce.return_dispositions(receipt_line_id,receipt_id,order_id,quantity,disposition,idempotency_key,request_hash)
      values (${receipt!.lines[0].id}::uuid,${receipt!.id}::uuid,${s.order.id}::uuid,1,'restock',${crypto.randomUUID()},
        private.command_request_hash(jsonb_build_object('receipt_line_id',${receipt!.lines[0].id}::uuid,'quantity',1,'disposition','restock','note',null)))`;
  }, () => action === 'authorize' ? authorize(s) : action === 'receive' ? receive(r!) : disposition(receipt!));
  expect(result.error).toMatchObject({ errno: '40001' });
});

test('处置与其他客户 Quote 共用确定的库存锁顺序，FK 锁兼容，不形成回库/报价死锁', async () => {
  const s=await shipped(1); const receipt=await receive(await authorize(s)); const buyer=await signup();
  const result=await heldTransactionRace(database, async tx=>{
    await tx`select set_config('request.jwt.claims',${claims()},true)`;
    await tx`select public.dispose_return_receipt(${receipt.lines[0].id}::uuid,1,'restock',${crypto.randomUUID()})`;
  },()=>rpc('create_checkout_quote',{items:[{variant_id:fixture.variantId,quantity:1}],address:TEST_ADDRESS,idempotency_key:crypto.randomUUID()},buyer.token));
  expect(result.status).toBe(200); await checked(rpc('cancel_checkout_quote',{quote_id:(result.data as {id:string}).id},buyer.token));
});

test('授权持订单锁时，撤销发货以 NOWAIT 失败，不形成子行→订单反向等待', async () => {
  const s=await shipped(1);
  await database.begin(async tx=>{
    await tx`select set_config('request.jwt.claims',${claims()},true)`;
    await tx`select public.create_return(${s.id}::uuid,${JSON.stringify(lineItems(s.order.itemId,1))}::text::jsonb,${crypto.randomUUID()})`;
    const result=await api(`/rest/v1/fulfillments?id=eq.${s.id}`,{service:true,method:'PATCH',body:{status:'cancelled'}});
    expect(result.status).toBeGreaterThanOrEqual(400); expect(result.data).toMatchObject({code:'55P03'});
  });
});

test('撤销发货先提交时，旧 REPEATABLE READ 快照不能对已失效发货创建退货授权', async () => {
  const s = await shipped(1);
  const result = await staleAfterCommit(database, async tx => {
    await tx`select set_config('request.jwt.claims',${claims()},true)`;
    await tx`select public.create_return(${s.id}::uuid,${JSON.stringify(lineItems(s.order.itemId,1))}::text::jsonb,${crypto.randomUUID()})`;
  }, () => checked(api(`/rest/v1/fulfillments?id=eq.${s.id}`, { service: true, method: 'PATCH', body: { status: 'cancelled' } })));
  expect(result.error).toMatchObject({ errno: '40001' });
});

test('事实不可修改/删除；完整指纹防止事后添行，空头/伪造库存流水/超量失败不留下部分事实', async () => {
  const s=await shipped(3); const r=await authorize(s,2); const receipt=await receive(r,1); const d=await disposition(receipt,1); const before=await stockOf(fixture.sku);
  for (const [table,id] of [['returns',r.id],['return_lines',r.lines[0].id],['return_receipts',receipt.id],['return_receipt_lines',receipt.lines[0].id],['return_dispositions',d.id]]) {
    await expect(database.unsafe(`delete from commerce.${table} where id=$1::uuid`,[id]).execute()).rejects.toThrow();
  }
  await expect(database`update commerce.return_receipts set note='changed' where id=${receipt.id}::uuid`.execute()).rejects.toThrow('append-only');
  await expect(database`update commerce.return_lines set quantity=3 where id=${r.lines[0].id}::uuid`.execute()).rejects.toThrow('immutable');
  // Use the command's order-first lock sequence: fingerprint assertions must
  // not depend on pooled connections finishing a previous failed COMMIT's
  // cleanup before the next NOWAIT child insert. Lock races are tested above.
  await expect(database.begin(async tx=>{
    await tx`select id from public.orders where id=${s.order.id}::uuid for update`;
    await tx`insert into commerce.return_receipts(return_id,order_id,location_id,idempotency_key,request_hash) values (${r.id}::uuid,${s.order.id}::uuid,${location}::uuid,${crypto.randomUUID()},${'a'.repeat(64)})`;
  })).rejects.toThrow('receipt fingerprint');
  await expect(database.begin(async tx=>{
    await tx`select id from public.orders where id=${s.order.id}::uuid for update`;
    await tx`insert into commerce.returns(order_id,fulfillment_id,idempotency_key,request_hash) values (${s.order.id}::uuid,${s.id}::uuid,${crypto.randomUUID()},${'a'.repeat(64)})`;
  })).rejects.toThrow('authorization fingerprint');
  const next=await receive(r,1);
  await expect(database.begin(async tx=>{
    await tx`select id from public.orders where id=${s.order.id}::uuid for update`;
    await tx`insert into commerce.return_dispositions(receipt_line_id,receipt_id,order_id,quantity,disposition,inventory_movement_id,idempotency_key,request_hash)
      values (${next.lines[0].id}::uuid,${next.id}::uuid,${s.order.id}::uuid,1,'restock',${d.inventory_movement_id!},${crypto.randomUUID()},${'a'.repeat(64)})`;
  })).rejects.toThrow('assigned by disposition');
  await expect(database.begin(async tx=>{
    await tx`select id from public.orders where id=${s.order.id}::uuid for update`;
    await tx`insert into commerce.return_dispositions(receipt_line_id,receipt_id,order_id,quantity,disposition,idempotency_key,request_hash)
      values (${next.lines[0].id}::uuid,${next.id}::uuid,${s.order.id}::uuid,1,'restock',${crypto.randomUUID()},${'a'.repeat(64)})`;
  })).rejects.toThrow('fingerprint or stock movement');
  expect(await stockOf(fixture.sku)).toBe(before);
});

test('数量/类型/空输入有界，拒绝无效处置方式和不能认证的字段，失败不会耗掉幂等键', async () => {
  const s=await shipped(1); const r=await authorize(s); const receipt=await receive(r); const key=crypto.randomUUID();
  for (const body of [{quantity:0},{quantity:-1},{quantity:null},{disposition:'quarantine'},{disposition:null}]) {
    expect((await rpc('dispose_return_receipt',{receipt_line_id:receipt.lines[0].id,quantity:1,disposition:'restock',idempotency_key:key,...body},admin.token)).status).toBe(400);
  }
  for (const items of [[],null,[{order_item_id:s.order.itemId,quantity:0}],[{order_item_id:s.order.itemId,quantity:1,price:0}],Array.from({length:101},()=>({order_item_id:s.order.itemId,quantity:1}))]) {
    expect((await rpc('create_return',{fulfillment_id:s.id,items,idempotency_key:crypto.randomUUID()},admin.token)).status).toBe(400);
  }
  expect((await disposition(receipt,1,'discard',key)).quantity).toBe(1);
});

test('新增事实仅允许 actor 单向匿名化，客户匿名化保留交易/收货处置历史', async () => {
  const staff=await signup(); await makeAdmin(staff.userId); const s=await shipped(1);
  const r=await authorize(s,1,crypto.randomUUID(),staff.token); const receipt=await receive(r,1,location,crypto.randomUUID(),staff.token); const d=await disposition(receipt,1,'restock',crypto.randomUUID(),staff.token);
  await checked(rpc('anonymize_user',{p_user_id:staff.userId},admin.token));
  for (const [table,id] of [['returns',r.id],['return_receipts',receipt.id],['return_dispositions',d.id]]) {
    const [row]=await database.unsafe(`select actor_id from commerce.${table} where id=$1::uuid`,[id]); expect(row.actor_id).toBeNull();
    await expect(database.unsafe(`update commerce.${table} set actor_id=$1::uuid where id=$2::uuid`,[staff.userId,id]).execute()).rejects.toThrow();
  }
  await checked(rpc('anonymize_customer',{customer_id:s.buyer.customerId},admin.token));
  expect((await rpc('get_order_returns',{order_id:s.order.id},s.buyer.token)).status).toBe(400);
  expect((await rpc('get_order_returns',{order_id:s.order.id},admin.token)).status).toBe(200);
});
