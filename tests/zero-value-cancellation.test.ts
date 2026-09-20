import { afterAll, beforeAll, expect, test } from 'bun:test';
import { api, checked, makeAdmin, rpc, signup, stockOf, TEST_ADDRESS, type TestUser } from './helpers';
import { stockedProduct } from './support/catalog';
import { Cleanup } from './support/cleanup';
import { fixtureOrder, fixtureIntent, settleIntent } from './payment-fixtures';
import { staleAfterCommit, testDatabase } from './database-concurrency';
import { withRollback } from '../scripts/lib/transactions';

const cleanup = new Cleanup(), database = testDatabase();
let admin: TestUser;
beforeAll(async () => { admin = await signup(); await makeAdmin(admin.userId); });
afterAll(async () => { try { await cleanup.run(); } finally { await database.close(); } });

for (const [price, trackInventory] of [[0,true],[10,true],[0,false]] as const)
test(`零对价取消有独立数量事实、幂等回库和明确终态：price=${price}, tracked=${trackInventory}`, async () => {
  const buyer = await signup();
  const f = await stockedProduct(admin, { price, trackInventory, cleanup });
  if (price > 0) {
    const [promo] = await checked<Array<{ id: string }>>(api('/rest/v1/promotions', { service: true, method: 'POST', body: {
      name: `free-${crypto.randomUUID()}`, type: 'item_percentage', apply_scope: 'selected', params: { percent: 100 },
    } }));
    cleanup.defer(() => checked(api(`/rest/v1/promotions?id=eq.${promo.id}`, { service: true, method: 'PATCH', body: { is_active: false } })));
    await checked(api('/rest/v1/promotion_targets', { service: true, method: 'POST', body: { promotion_id: promo.id, product_id: f.productId } }));
  }
  const order = await fixtureOrder(f, buyer, 2);
  expect(order.total).toBe(0);
  const input = { order_id: order.id, order_item_id: order.itemId, quantity: 1, idempotency_key: crypto.randomUUID() };
  const stranger = await signup();
  expect((await rpc('cancel_zero_value_order_item', input, stranger.token)).status).toBe(400);
  const first = await checked<{ id: string; quantity: number; restocked_quantity: number }>(rpc('cancel_zero_value_order_item', input, buyer.token));
  expect(first).toMatchObject({ quantity: 1, restocked_quantity: trackInventory ? 1 : 0 });
  expect(await checked<typeof first>(rpc('cancel_zero_value_order_item', input, buyer.token))).toEqual(first);
  expect((await rpc('cancel_zero_value_order_item', { ...input, quantity: 2 }, buyer.token)).status).toBe(400);
  await checked(rpc('cancel_zero_value_order_item', { ...input, idempotency_key: crypto.randomUUID() }, admin.token));
  expect(await checked<Array<{ status: string; financial_status: string }>>(api(`/rest/v1/orders?id=eq.${order.id}&select=status,financial_status`, { token: buyer.token })))
    .toEqual([{ status: 'cancelled', financial_status: 'paid' }]);
  const ledger = await checked<{ transactions: unknown[] }>(rpc('get_order_ledger', { order_id: order.id }, buyer.token));
  expect(ledger.transactions).toEqual([]);
  const [facts] = await database`select count(*)::int n, sum(quantity)::int units from commerce.zero_value_cancellations where order_id=${order.id}::uuid`;
  expect(facts).toEqual({ n: 2, units: 2 });
  if (trackInventory) expect(await stockOf(f.sku)).toBe(100);
  await expect(withRollback(database, tx => tx`update commerce.zero_value_cancellations set quantity=2 where id=${first.id}::uuid`)).rejects.toThrow('append-only');
  expect((await rpc('create_fulfillment', { order_id: order.id, items: [{ order_item_id: order.itemId, quantity: 1 }], idempotency_key: crypto.randomUUID() }, admin.token)).status).toBe(400);
});

test('付费订单免费行取消不穿透退款预留；完成退款不重复取消/回库', async () => {
  const buyer = await signup(), free = await stockedProduct(admin, { price: 0, cleanup });
  const paid = await stockedProduct(admin, { cleanup });
  const order = await checked<{ id: string; total: number; currency: string }>(rpc('create_order', {
    items: [{ variant_id: free.variantId, quantity: 3 }, { variant_id: paid.variantId, quantity: 1 }],
    address: TEST_ADDRESS, idempotency_key: crypto.randomUUID(),
  }, buyer.token));
  const lines = await checked<Array<{ id: string; variant_id: string }>>(api(`/rest/v1/order_items?order_id=eq.${order.id}&select=id,variant_id`, { token: buyer.token }));
  const freeId = lines.find(l => l.variant_id === free.variantId)!.id;
  const paidId = lines.find(l => l.variant_id === paid.variantId)!.id;
  await settleIntent(await fixtureIntent({ ...order, itemId: paidId, quoteId: null }, buyer));
  const input = { order_id: order.id, order_item_id: freeId, quantity: 3, idempotency_key: crypto.randomUUID() };
  expect((await rpc('cancel_zero_value_order_item', { ...input, order_item_id: paidId, quantity: 1 }, admin.token)).status).toBe(400);
  const request = await checked<{ id: string }>(rpc('create_refund_request', { order_id: order.id,
    actor_id: admin.userId, provider: 'paypal', idempotency_key: crypto.randomUUID(),
    items: [{ order_item_id: freeId, quantity: 1 }, { order_item_id: paidId, quantity: 1 }], restock: true,
  }, undefined, true));
  expect((await rpc('cancel_zero_value_order_item', input, buyer.token)).status).toBe(400);
  await checked(rpc('cancel_zero_value_order_item', { ...input, quantity: 2 }, buyer.token));
  expect(await stockOf(free.sku)).toBe(99);
  await checked(rpc('cancel_refund_request', { refund_request_id: request.id, actor_id: admin.userId }, undefined, true));
  expect((await rpc('refund_order', { order_id: order.id, idempotency_key: crypto.randomUUID(),
    items: [{ order_item_id: freeId, quantity: 2 }, { order_item_id: paidId, quantity: 1 }], restock: true,
  }, admin.token)).status).toBe(400);
  await checked(rpc('refund_order', { order_id: order.id, idempotency_key: crypto.randomUUID(),
    items: [{ order_item_id: freeId, quantity: 1 }, { order_item_id: paidId, quantity: 1 }], restock: true,
  }, admin.token));
  expect(await stockOf(free.sku)).toBe(100);
  const balance = await checked<{ lines: Array<{ order_item_id: string; cancelled_quantity: number; available_quantity: number }> }>(rpc('get_order_fulfillment_balance', { order_id: order.id }, buyer.token));
  expect(balance.lines.find(l => l.order_item_id === freeId)).toMatchObject({ cancelled_quantity: 3, available_quantity: 0 });
});

test('已发货数量不能取消；旧 RR 快照也不能在已提交取消后继续发货', async () => {
  const buyer = await signup(), f = await stockedProduct(admin, { price: 0, cleanup });
  const order = await fixtureOrder(f, buyer, 3);
  const items = [{ order_item_id: order.itemId, quantity: 1 }];
  await checked(rpc('create_fulfillment', { order_id: order.id, items, idempotency_key: crypto.randomUUID() }, admin.token));
  const cancel = { order_id: order.id, order_item_id: order.itemId, quantity: 2, idempotency_key: crypto.randomUUID() };
  expect((await rpc('cancel_zero_value_order_item', { ...cancel, quantity: 3 }, buyer.token)).status).toBe(400);
  const result = await staleAfterCommit(database, async tx => {
    await tx`select set_config('request.jwt.claims',${JSON.stringify({ role: 'authenticated', sub: admin.userId })},true)`;
    return tx`select public.create_fulfillment(${order.id}::uuid,${JSON.stringify(items)}::text::jsonb,${crypto.randomUUID()})`;
  }, () => checked(rpc('cancel_zero_value_order_item', cancel, buyer.token)));
  expect(result.error).toMatchObject({ errno: '40001' });
  expect(await stockOf(f.sku)).toBe(99);
  expect(await checked<Array<{ status: string; fulfillment_status: string }>>(api(`/rest/v1/orders?id=eq.${order.id}&select=status,fulfillment_status`, { token: buyer.token })))
    .toEqual([{ status: 'completed', fulfillment_status: 'fulfilled' }]);
});
