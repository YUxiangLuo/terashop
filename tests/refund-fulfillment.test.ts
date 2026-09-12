import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { api, rpc, signup, makeAdmin, stockOf, shippingByName, installTestTax, type TestUser } from './helpers';
import {
  checked, paymentFixture, fixtureOrder, fixtureIntent, paymentEvent, settleIntent,
  type PaymentFixture, type FixtureOrder,
} from './payment-fixtures';
import { normalizeCheckoutAmount } from '../supabase/functions/_shared/paypal.ts';

let admin: TestUser;
let buyer: TestUser;
let fixture: PaymentFixture;
let removeTax: (() => Promise<void>) | undefined;
beforeAll(async () => {
  removeTax = await installTestTax();
  admin = await signup(); buyer = await signup();
  await makeAdmin(admin.userId);
  fixture = await paymentFixture(admin);
});
afterAll(async () => {
  await removeTax?.();
  if (fixture) await api(`/rest/v1/products?id=eq.${fixture.productId}`, {
    service: true, method: 'PATCH', body: { status: 'archived' },
  });
});

interface LineBalance {
  ordered_quantity: number;
  fulfilled_quantity: number;
  cancelled_quantity: number;
  reserved_quantity: number;
  available_quantity: number;
}
interface Balance { is_fulfillable: boolean; lines: LineBalance[] }
interface RefundRequest { id: string; amount: number; currency: string }
const shipmentItems = (order: FixtureOrder, quantity: number) => [{ order_item_id: order.itemId, quantity }];
const fulfill = (order: FixtureOrder, quantity: number) => rpc('create_fulfillment', {
  order_id: order.id, items: shipmentItems(order, quantity),
}, admin.token);
const balance = (order: FixtureOrder): Promise<Balance> => checked(rpc('get_order_fulfillment_balance', {
  order_id: order.id,
}, buyer.token));
async function manualOrder(quantity: number, withShipping = false): Promise<FixtureOrder> {
  const order = await fixtureOrder(fixture, buyer, quantity, true,
    withShipping ? { shipping_method_id: await shippingByName('Standard shipping') } : {});
  await checked(rpc('mark_order_paid', { order_id: order.id }, admin.token));
  return order;
}
async function itemRefund(order: FixtureOrder, quantity: number): Promise<void> {
  await checked(rpc('refund_order', {
    order_id: order.id, items: shipmentItems(order, quantity), restock: true,
  }, admin.token));
}
async function requestRefund(order: FixtureOrder, quantity: number): Promise<RefundRequest> {
  return checked(rpc('create_refund_request', {
    order_id: order.id, actor_id: admin.userId, provider: 'paypal',
    idempotency_key: crypto.randomUUID(), items: shipmentItems(order, quantity), restock: true,
  }, undefined, true));
}

describe('Refund cancellation and fulfillment quantities', () => {
  test('未发货商品退款回库后不能再发货，RPC 和受信表写入都被限制', async () => {
    // Keep shipping payable so quantity guards run before the fully-refunded guard.
    const order = await manualOrder(1, true);
    const before = await stockOf(fixture.sku);
    await itemRefund(order, 1);
    expect((await balance(order)).lines[0]).toMatchObject({
      cancelled_quantity: 1, available_quantity: 0, fulfilled_quantity: 0,
    });
    const blocked = await fulfill(order, 1);
    expect(blocked.status).toBe(400);
    expect(blocked.data).toMatchObject({ message: expect.stringContaining('exceeds remaining') });
    const direct = await api('/rest/v1/fulfillments', {
      service: true, method: 'POST', body: { order_id: order.id, items: shipmentItems(order, 1) },
    });
    expect(direct.status).toBe(400);
    expect(await stockOf(fixture.sku)).toBe(before + 1);
    await checked(rpc('refund_order', { order_id: order.id }, admin.token));
    expect((await fulfill(order, 1)).status).toBe(400);
    expect((await balance(order)).is_fulfillable).toBe(false);
  });

  test('部分取消只扣对应数量，其余商品仍可正常履约', async () => {
    const order = await manualOrder(3);
    await itemRefund(order, 1);
    expect((await balance(order)).lines[0]).toMatchObject({ cancelled_quantity: 1, available_quantity: 2 });
    expect((await fulfill(order, 3)).status).toBe(400);
    expect((await fulfill(order, 2)).status).toBe(200);
    expect((await balance(order)).lines[0]).toMatchObject({
      ordered_quantity: 3, fulfilled_quantity: 2, cancelled_quantity: 1, available_quantity: 0,
    });
    const rows = await checked<Array<{ fulfillment_status: string }>>(api(
      `/rest/v1/orders?id=eq.${order.id}&select=fulfillment_status`, { token: buyer.token },
    ));
    expect(rows[0].fulfillment_status).toBe('fulfilled');
  });

  test('手工退款首次 DTO 与 V2 重试一致，已履约加已取消覆盖订单时立即更新汇总', async () => {
    const order = await manualOrder(2);
    await checked(fulfill(order, 1));
    const command = {
      order_id: order.id, idempotency_key: crypto.randomUUID(),
      items: shipmentItems(order, 1), restock: true,
    };
    const first = await checked<Record<string, unknown>>(rpc('refund_order_v2', command, admin.token));
    const retry = await checked<Record<string, unknown>>(rpc('refund_order_v2', command, admin.token));
    expect(first).toMatchObject({ status: 'completed', fulfillment_status: 'fulfilled' });
    expect(retry).toEqual(first);
  });

  test('退款优先取消未发货部分，其余已发货退款不重复算作取消', async () => {
    const order = await manualOrder(3);
    const shipment = await checked<{ id: string }>(fulfill(order, 2));
    await itemRefund(order, 2);
    expect((await balance(order)).lines[0]).toMatchObject({
      ordered_quantity: 3, fulfilled_quantity: 2, cancelled_quantity: 1, available_quantity: 0,
    });
    const cancelShipment = await api(`/rest/v1/fulfillments?id=eq.${shipment.id}`, {
      service: true, method: 'PATCH', body: { status: 'cancelled' },
    });
    expect(cancelShipment.status).toBe(400);
    expect(cancelShipment.data).toMatchObject({ message: expect.stringContaining('refunded items') });
    expect((await fulfill(order, 1)).status).toBe(400);
  });

  test('纯金额部分退款不猜测商品取消数量，未发货商品仍能履约', async () => {
    const order = await manualOrder(3);
    await checked(fulfill(order, 1));
    await checked(rpc('refund_order', { order_id: order.id, amount: 1 }, admin.token));
    expect((await balance(order)).lines[0]).toMatchObject({ cancelled_quantity: 0, available_quantity: 2 });
    expect((await fulfill(order, 2)).status).toBe(200);
  });

  test('无商品行的全额退款也禁止新增履约', async () => {
    const order = await manualOrder(1);
    await checked(rpc('refund_order', { order_id: order.id }, admin.token));
    expect((await balance(order)).lines[0]).toMatchObject({ cancelled_quantity: 0, available_quantity: 0 });
    expect((await fulfill(order, 1)).status).toBe(400);
    const direct = await api('/rest/v1/fulfillments', {
      service: true, method: 'POST', body: { order_id: order.id, items: shipmentItems(order, 1) },
    });
    expect(direct.status).toBe(400);
  });

  test('pending 退款预留取消数量；取消请求释放预留，不能提前发货穿透退款', async () => {
    const order = await fixtureOrder(fixture, buyer, 3);
    await settleIntent(await fixtureIntent(order, buyer));
    const request = await requestRefund(order, 2);
    expect((await balance(order)).lines[0]).toMatchObject({
      cancelled_quantity: 0, reserved_quantity: 2, available_quantity: 1,
    });
    expect((await fulfill(order, 2)).status).toBe(400);
    await checked(rpc('cancel_refund_request', {
      refund_request_id: request.id, actor_id: admin.userId,
    }, undefined, true));
    expect((await balance(order)).lines[0]).toMatchObject({ reserved_quantity: 0, available_quantity: 3 });
    expect((await fulfill(order, 3)).status).toBe(200);
  });

  test('渠道退款失败释放取消数量；成功则消费预留且不重复扣可履约数量', async () => {
    const order = await fixtureOrder(fixture, buyer, 2);
    const intent = await fixtureIntent(order, buyer);
    await settleIntent(intent);
    const before = await stockOf(fixture.sku);
    for (const status of ['failed', 'succeeded']) {
      const request = await requestRefund(order, 1);
      const reference = `re_${crypto.randomUUID().replaceAll('-', '')}`;
      await checked(rpc('bind_refund_request_provider', {
        refund_request_id: request.id, provider_reference: reference, provider_status: 'pending',
        amount: request.amount, currency: request.currency,
      }, undefined, true));
      if (status === 'succeeded') {
        // The other unit can ship while this unit remains reserved for cancellation.
        expect((await fulfill(order, 1)).status).toBe(200);
        expect((await fulfill(order, 1)).status).toBe(400);
      }
      const result = await paymentEvent('paypal', 'paypal.refund.api_result', reference, {
        object_type: 'refund', status: status === 'succeeded' ? 'completed' : status,
        amount: normalizeCheckoutAmount(request.amount, request.currency), currency: request.currency,
        capture_reference: `CAPTURE${intent.id.replaceAll('-', '')}`,
        metadata: { tera_refund_request_id: request.id },
      });
      expect(result).toMatchObject({ status: 'processed', outcome: status === 'succeeded' ? 'refunded' : 'failed' });
      if (status === 'failed') expect((await balance(order)).lines[0]).toMatchObject({ reserved_quantity: 0, available_quantity: 2 });
    }
    expect((await balance(order)).lines[0]).toMatchObject({
      fulfilled_quantity: 1, cancelled_quantity: 1, reserved_quantity: 0, available_quantity: 0,
    });
    expect(await stockOf(fixture.sku)).toBe(before + 1);
  });

  test('并发退款请求与发货共用订单锁，取消预留与已发货数量之和不超过订购数量', async () => {
    const order = await fixtureOrder(fixture, buyer);
    await settleIntent(await fixtureIntent(order, buyer));
    const [request, shipment] = await Promise.all([requestRefund(order, 1), fulfill(order, 1)]);
    expect([200, 400]).toContain(shipment.status);
    const line = (await balance(order)).lines[0];
    expect(line.fulfilled_quantity + line.reserved_quantity).toBe(1);
    await checked(rpc('cancel_refund_request', {
      refund_request_id: request.id, actor_id: admin.userId,
    }, undefined, true));
  });

  test('可履约数量 DTO 不泄露给匿名或其他客户', async () => {
    const order = await manualOrder(1);
    const stranger = await signup();
    const body = { order_id: order.id };
    expect((await rpc('get_order_fulfillment_balance', body)).status).toBe(401);
    expect((await rpc('get_order_fulfillment_balance', body, stranger.token)).status).toBe(400);
    expect((await rpc('get_order_fulfillment_balance', body, buyer.token)).status).toBe(200);
    expect((await rpc('get_order_fulfillment_balance', body, admin.token)).status).toBe(200);
  });
});
