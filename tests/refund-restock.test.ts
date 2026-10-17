import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rpc, signup, makeAdmin, stockOf, type TestUser } from './helpers';
import {
  checked, fixtureOrder, fixtureIntent, paymentEvent, settleIntent,
  type FixtureOrder, type FixtureIntent,
} from './payment-fixtures';
import { stockedProduct, type CatalogFixture } from './support/catalog';
import { Cleanup } from './support/cleanup';
import { testDatabase } from './database-concurrency';
import { normalizeCheckoutAmount } from '../supabase/functions/_shared/paypal.ts';

const database = testDatabase(), cleanup = new Cleanup();
let admin: TestUser, buyer: TestUser;
beforeAll(async () => {
  admin = await signup(); buyer = await signup();
  await makeAdmin(admin.userId);
});
afterAll(async () => { try { await cleanup.run(); } finally { await database.close(); } });

interface Movement { reason: string; delta: number; location_id: string }
interface RefundRequest { id: string; amount: number; currency: string }
const product = () => stockedProduct(admin, { onHand: 20, cleanup });
const line = (order: FixtureOrder, quantity: number, restock_shipped_quantity?: number) => [{
  order_item_id: order.itemId, quantity, ...(restock_shipped_quantity === undefined ? {} : { restock_shipped_quantity }),
}];
async function paidOrder(fixture: CatalogFixture, quantity: number, shipped: number): Promise<FixtureOrder> {
  const order = await fixtureOrder(fixture, buyer, quantity);
  await checked(rpc('mark_order_paid', { idempotency_key: crypto.randomUUID(), order_id: order.id }, admin.token));
  await ship(order, shipped);
  return order;
}
async function ship(order: FixtureOrder, quantity: number) {
  if (quantity) await checked(rpc('create_fulfillment', { idempotency_key: crypto.randomUUID(),
    order_id: order.id, items: line(order, quantity) }, admin.token));
}
const refund = (order: FixtureOrder, items: unknown, key = crypto.randomUUID()) =>
  rpc('refund_order', { idempotency_key: key, order_id: order.id, items }, admin.token);
const movements = (order: FixtureOrder): Promise<Movement[]> => database`
  select reason, delta, location_id::text from public.inventory_movements
  where order_id=${order.id}::uuid and delta > 0 order by id`;
const consumedAt = async (order: FixtureOrder): Promise<string> => (await database`
  select location_id::text from public.inventory_movements where order_id=${order.id}::uuid and reason='order'`)[0].location_id;
const balance = async (order: FixtureOrder) => (await checked<{ lines: Array<Record<string, number>> }>(
  rpc('get_order_fulfillment_balance', { order_id: order.id }, admin.token))).lines[0];
const ledgerLines = async (order: FixtureOrder) => (await checked<{ refunds: Array<{ lines: Array<Record<string, unknown>> }> }>(
  rpc('get_order_ledger', { order_id: order.id }, admin.token))).refunds.flatMap(r => r.lines);

describe('Refund restock of returned shipped units', () => {
  test('手工退款按行回库已发货退回件：同事务写一条原仓 restock 流水，幂等重放不重复回库', async () => {
    const fixture = await product();
    const order = await paidOrder(fixture, 3, 3);
    const before = await stockOf(fixture.sku);
    const key = crypto.randomUUID();
    await checked(refund(order, line(order, 2, 2), key));
    expect(await stockOf(fixture.sku)).toBe(before + 2);
    expect(await movements(order)).toEqual([{ reason: 'restock', delta: 2, location_id: await consumedAt(order) }]);
    expect(await ledgerLines(order)).toEqual([expect.objectContaining({
      quantity: 2, cancelled_quantity: 0, restocked_quantity: 0, restock_shipped_quantity: 2,
    })]);
    // The shipment happened; the restock does not reduce fulfilled quantity.
    expect(await balance(order)).toMatchObject({ fulfilled_quantity: 3, cancelled_quantity: 0, available_quantity: 0 });
    await checked(refund(order, line(order, 2, 2), key));
    expect(await stockOf(fixture.sku)).toBe(before + 2);
    expect(await movements(order)).toHaveLength(1);
    // Amount-only refunds never restock.
    await checked(rpc('refund_order', { idempotency_key: crypto.randomUUID(), order_id: order.id, amount: 1 }, admin.token));
    expect(await stockOf(fixture.sku)).toBe(before + 2);
  });

  test('回库数量受本行退款数量与已发货数量约束，失败不留下资金或库存事实', async () => {
    const fixture = await product();
    const order = await paidOrder(fixture, 3, 1);
    const before = await stockOf(fixture.sku);
    for (const [items, message] of [
      [line(order, 1, 2), 'cannot exceed refunded quantity'],
      [line(order, 2, 2), 'exceeds shipped units not yet restocked'],
      [line(order, 1, -1), 'non-negative integer'],
      [[{ order_item_id: order.itemId, quantity: 1, returned_quantity: 1 }], 'unsupported refund item field'],
    ] as const) {
      const rejected = await refund(order, items);
      expect(rejected.status).toBe(400);
      expect(JSON.stringify(rejected.data)).toContain(message);
    }
    expect(await ledgerLines(order)).toEqual([]);
    expect(await stockOf(fixture.sku)).toBe(before);
    // Declared returned units are not unshipped cancellations; the rest stays shippable.
    await checked(refund(order, line(order, 1, 1)));
    expect(await balance(order)).toMatchObject({ fulfilled_quantity: 1, cancelled_quantity: 0, available_quantity: 2 });
    expect(await stockOf(fixture.sku)).toBe(before + 1);
  });

  test('多次退款累计回库不超过已发货数量，不会重复回库', async () => {
    const fixture = await product();
    const order = await paidOrder(fixture, 3, 2);
    const before = await stockOf(fixture.sku);
    await checked(refund(order, line(order, 1, 1)));
    await checked(refund(order, line(order, 1, 1)));
    const third = await refund(order, line(order, 1, 1));
    expect(third.status).toBe(400);
    expect(JSON.stringify(third.data)).toContain('exceeds shipped units not yet restocked');
    expect(await stockOf(fixture.sku)).toBe(before + 2);
    // The last unit was never shipped: it is cancelled, released only on explicit restock.
    await checked(rpc('refund_order', { idempotency_key: crypto.randomUUID(), order_id: order.id,
      items: line(order, 1), restock: true }, admin.token));
    expect(await stockOf(fixture.sku)).toBe(before + 3);
    expect((await movements(order)).map(m => [m.reason, m.delta])).toEqual([['restock', 1], ['restock', 1], ['cancel', 1]]);
    expect(await balance(order)).toMatchObject({ fulfilled_quantity: 2, cancelled_quantity: 1, available_quantity: 0 });
  });

  test('PayPal 异步退款只在成功时回库；失败释放预留，活动请求预留计入上限，重复事件不重复回库', async () => {
    const fixture = await product();
    const order = await fixtureOrder(fixture, buyer, 3);
    const intent = await fixtureIntent(order, buyer);
    await settleIntent(intent);
    await ship(order, 1);
    const before = await stockOf(fixture.sku);
    const request = (key = crypto.randomUUID()) => rpc('create_refund_request', {
      order_id: order.id, actor_id: admin.userId, provider: 'paypal', idempotency_key: key, items: line(order, 1, 1),
    }, undefined, true);
    const complete = async (refundRequest: RefundRequest, status: 'failed' | 'completed') => {
      const reference = `re_${crypto.randomUUID().replaceAll('-', '')}`;
      await checked(rpc('bind_refund_request_provider', {
        refund_request_id: refundRequest.id, provider_reference: reference, provider_status: 'pending',
        amount: refundRequest.amount, currency: refundRequest.currency,
      }, undefined, true));
      return { reference, result: await event(refundRequest, intent, reference, status) };
    };
    const failed = await checked<RefundRequest>(request());
    expect(await stockOf(fixture.sku)).toBe(before);
    expect((await complete(failed, 'failed')).result).toMatchObject({ outcome: 'failed' });
    expect(await stockOf(fixture.sku)).toBe(before);

    const pending = await checked<RefundRequest>(request());
    expect(await stockOf(fixture.sku)).toBe(before);
    const blocked = await request();
    expect(blocked.status).toBe(400);
    expect(JSON.stringify(blocked.data)).toContain('exceeds shipped units not yet restocked');
    const { reference, result } = await complete(pending, 'completed');
    expect(result).toMatchObject({ outcome: 'refunded' });
    expect(await stockOf(fixture.sku)).toBe(before + 1);
    expect(await event(pending, intent, reference, 'completed')).toMatchObject({ status: 'processed' });
    expect(await stockOf(fixture.sku)).toBe(before + 1);
    expect(await movements(order)).toEqual([{ reason: 'restock', delta: 1, location_id: await consumedAt(order) }]);
    expect(await ledgerLines(order)).toEqual([expect.objectContaining({ quantity: 1, cancelled_quantity: 0, restock_shipped_quantity: 1 })]);
  });
});

function event(request: RefundRequest, intent: FixtureIntent, reference: string, status: 'failed' | 'completed') {
  return paymentEvent('paypal', 'paypal.refund.api_result', reference, {
    object_type: 'refund', status, amount: normalizeCheckoutAmount(request.amount, request.currency),
    currency: request.currency, capture_reference: `CAPTURE${intent.id.replaceAll('-', '')}`,
    metadata: { tera_refund_request_id: request.id },
  });
}
