import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { stockedProduct, type CatalogFixture } from './support/catalog';
import { Cleanup } from './support/cleanup';
import { fixtureOrder } from './payment-fixtures';
import {
  api, rpc, signup, makeAdmin, checked, TEST_ADDRESS, installTestTax,
  type TestUser,
} from './helpers';
import { withRollback } from '../scripts/lib/transactions';
import { testDatabase } from './database-concurrency';

let admin: TestUser;
let buyer: TestUser;
let stranger: TestUser;
let mugId: string;

let product: CatalogFixture;
const fixtures = new Cleanup();
const database = testDatabase();

interface Ledger {
  order: {
    id: string;
    status: string;
    financial_status: string;
    fulfillment_status: string;
    subtotal: number;
    total: number;
  };
  balances: {
    adjustment_total: number;
    captured: number;
    refunded: number;
    net_paid: number;
    is_balanced: boolean;
  };
  adjustments: Array<{ kind: string; amount: number; source_ref: string }>;
  payment_intents: Array<{
    id: string; provider: string; status: string; amount: number;
  }>;
  transactions: Array<{
    id: string;
    payment_intent_id: string | null;
    parent_transaction_id: string | null;
    provider: string;
    kind: string;
    status: string;
    amount: number;
  }>;
  refunds: Array<{
    id: string;
    source: string;
    amount: number;
    reason: string | null;
    restock_requested: boolean;
    lines: Array<{
      order_item_id: string;
      quantity: number;
      amount: number;
      restocked_quantity: number;
    }>;
  }>;
  fulfillments: Array<{
    id: string;
    status: string;
    tracking_number: string;
    lines: Array<{ order_item_id: string; quantity: number }>;
  }>;
}

async function ledger(orderId: string, token = buyer.token): Promise<Ledger> {
  const { status, data } = await rpc('get_order_ledger', { order_id: orderId }, token);
  if (status >= 400) throw new Error(`get_order_ledger failed: ${JSON.stringify(data)}`);
  return data as Ledger;
}

let removeTax: (() => Promise<void>) | undefined;
afterAll(async () => {
  try { await fixtures.run(); } finally {
    try { await removeTax?.(); } finally { await database.close(); }
  }
});
beforeAll(async () => {
  removeTax = await installTestTax();
  admin = await signup();
  stranger = await signup();
  await makeAdmin(admin.userId);
  product = await stockedProduct(admin, { price: 9.9, cleanup: fixtures });
  mugId = product.variantId;
});
beforeEach(async () => { buyer = await signup(); });
const givenPendingOrder = () => fixtureOrder(product, buyer, 1, false);
async function givenPaidOrder(fulfillment: 'none' | 'active' | 'cancelled' = 'none') {
  const order = await fixtureOrder(product, buyer, 2, false);
  await checked(rpc('mark_order_paid', { order_id: order.id }, admin.token));
  const payment = (await ledger(order.id)).transactions.find(transaction => transaction.kind === 'capture');
  if (!payment) throw new Error('paid order has no capture transaction');
  let fulfillmentId: string | undefined;
  if (fulfillment !== 'none') {
    const result = await checked<{ id: string }>(rpc('create_fulfillment', { idempotency_key: crypto.randomUUID(),
      order_id: order.id, items: [{ order_item_id: order.itemId, quantity: 1 }],
    }, admin.token));
    fulfillmentId = result.id;
    if (fulfillment === 'cancelled') await checked(api(`/rest/v1/fulfillments?id=eq.${fulfillmentId}`, {
      service: true, method: 'PATCH', body: { status: 'cancelled' },
    }));
  }
  return { ...order, paymentId: payment.id, fulfillmentId };
}

test('三个幂等写入口只暴露一个无后缀签名，并严格要求 idempotency_key', async () => {
  const names = ['create_order', 'create_fulfillment', 'refund_order'] as const;
  const signatures: Array<{ proname: string; signatures: number }> = await database`
    select proname, count(*)::int signatures from pg_proc
    where pronamespace='public'::regnamespace and proname in (${names[0]},${names[1]},${names[2]})
    group by proname order by proname`;
  expect(signatures).toEqual(names.slice().sort().map(proname => ({ proname, signatures: 1 })));
  for (const name of names) {
    const [legacy] = await database`select count(*)::int signatures from pg_proc
      where pronamespace='public'::regnamespace and proname=${`${name}_v2`}`;
    expect(legacy.signatures).toBe(0);
    expect((await rpc(`${name}_v2`, {}, admin.token)).status).toBe(404);
    const base = name === 'create_order' ? { items: [], address: TEST_ADDRESS }
      : name === 'create_fulfillment' ? { order_id: crypto.randomUUID(), items: [] }
      : { order_id: crypto.randomUUID() };
    const token = name === 'create_order' ? buyer.token : admin.token;
    for (const key of [undefined, null, '', '   ']) {
      const body = key === undefined ? base : { ...base, idempotency_key: key };
      const result = await rpc(name, body, token);
      expect(result.status).toBe(key === undefined ? 404 : 400);
      expect(result.data).toMatchObject(key === undefined
        ? { code: 'PGRST202' }
        : { message: 'idempotency_key is required and must be at most 200 characters' });
    }
  }
});

describe('关系化订单账本', () => {
  test('订单金额自动双写 adjustment ledger，且只通过安全 DTO 暴露', async () => {
    const { data: created } = await rpc('create_order', {
      idempotency_key: crypto.randomUUID(), items: [{ variant_id: mugId, quantity: 1 }], address: TEST_ADDRESS,
    }, buyer.token);
    const adjustmentOrderId = (created as { id: string }).id;

    const value = await ledger(adjustmentOrderId);
    expect(value.balances.is_balanced).toBe(true);
    expect(Number(value.balances.adjustment_total)).toBeCloseTo(1.29);
    expect(value.adjustments.map((row) => row.kind)).toEqual(['tax']);
    expect(Number(value.order.subtotal) + Number(value.balances.adjustment_total))
      .toBeCloseTo(Number(value.order.total));

    // commerce schema 未列入 PostgREST exposed schemas，物理账本不可直接探测。
    const hidden = await api('/rest/v1/order_adjustments?select=*', { service: true });
    expect(hidden.status).toBe(404);
  });

  test('create_order 对语义相同的重试只建一单、只预占一次库存', async () => {
    const key = `order-${crypto.randomUUID()}`;
    const before = await checked<{ on_hand: number; reserved: number; available: number }>(rpc(
      'get_inventory_availability', { variant_id: mugId }, admin.token,
    ));
    const [first, replay] = await Promise.all([
      rpc('create_order', {
        items: [
          { variant_id: mugId, quantity: 1 },
          { variant_id: mugId, quantity: 1 },
        ],
        address: TEST_ADDRESS,
        idempotency_key: key,
      }, buyer.token),
      rpc('create_order', {
        items: [{ variant_id: mugId, quantity: 2 }],
        address: TEST_ADDRESS,
        idempotency_key: key,
      }, buyer.token),
    ]);
    expect(first.status).toBe(200);
    expect((replay.data as { id: string }).id).toBe((first.data as { id: string }).id);

    const orderId = (first.data as { id: string }).id;
    const { data: movements } = await api(
      `/rest/v1/inventory_movements?order_id=eq.${orderId}&reason=eq.order&select=delta`,
      { service: true },
    );
    expect(movements).toEqual([]);
    expect(await checked(rpc('get_inventory_availability', { variant_id: mugId }, admin.token)))
      .toMatchObject({ on_hand: before.on_hand, reserved: before.reserved + 2, available: before.available - 2 });

    const mismatch = await rpc('create_order', {
      items: [{ variant_id: mugId, quantity: 3 }],
      address: TEST_ADDRESS,
      idempotency_key: key,
    }, buyer.token);
    expect(mismatch.status).toBe(400);
    expect((mismatch.data as { message: string }).message).toContain('different order parameters');
  });

  test('pending 订单拒绝重算税且 adjustment 快照不变', async () => {
    const { id: adjustmentOrderId } = await givenPendingOrder();
    const update = await rpc('update_order_address', {
      order_id: adjustmentOrderId,
      address: { recipient_name: 'John', phone: '1', country: 'CA', line1: '1 Main St' },
    }, buyer.token);

    const value = await ledger(adjustmentOrderId);
    expect(update.status).toBe(400);
    expect((update.data as { message: string }).message).toContain('immutable');
    const taxes = value.adjustments.filter((row) => row.kind === 'tax');
    expect(taxes.length).toBe(1);
    expect(taxes.map((row) => Number(row.amount))).toEqual([1.29]);
    expect(Number(value.balances.adjustment_total)).toBeCloseTo(1.29);
    expect(value.balances.is_balanced).toBe(true);
  });

  test('陌生人读不到订单账本', async () => {
    const { id: adjustmentOrderId } = await givenPendingOrder();
    const { status, data } = await rpc('get_order_ledger', {
      order_id: adjustmentOrderId,
    }, stranger.token);
    expect(status).toBe(400);
    expect((data as { message: string }).message).toBe('order not found');
    expect((await rpc('get_order_ledger', { order_id: adjustmentOrderId }, admin.token)).status).toBe(200);
    expect((await rpc('get_order_ledger', { order_id: adjustmentOrderId }, undefined, true)).status).toBe(200);
  });
});

describe('支付交易与已支付快照', () => {
  test('mark_order_paid 直接生成 capture transaction', async () => {
    const { data: created } = await rpc('create_order', {
      idempotency_key: crypto.randomUUID(), items: [{ variant_id: mugId, quantity: 2 }], address: TEST_ADDRESS,
    }, buyer.token);
    const order = created as { id: string; total: number };
    const paidOrderId = order.id;

    await rpc('mark_order_paid', {
      order_id: paidOrderId, provider: 'manual', provider_ref: `cash-${crypto.randomUUID()}`,
    }, admin.token);

    const value = await ledger(paidOrderId);
    expect(value.transactions.length).toBe(1);
    expect(value.transactions[0]).toMatchObject({
      provider: 'manual', kind: 'capture', status: 'succeeded',
    });
    expect(Number(value.balances.captured)).toBeCloseTo(Number(order.total));
    expect(Number(value.balances.net_paid)).toBeCloseTo(Number(order.total));
  });

  test('即使数据库写入也不能改写成功交易或超额 capture', async () => {
    const { id: paidOrderId, itemId: paidOrderItemId, paymentId: paidPaymentId } = await givenPaidOrder();
    const orderMutation = await api(`/rest/v1/orders?id=eq.${paidOrderId}`, {
      service: true, method: 'PATCH', body: { total: 0.01, tax_total: 0.01 },
    });
    expect(orderMutation.status).toBe(400);
    expect((orderMutation.data as { message: string }).message).toContain('snapshot is immutable');

    await expect(withRollback(database, sql => sql`
      update commerce.payment_transactions set amount=0.01 where id=${paidPaymentId}::uuid
    `)).rejects.toThrow('commercial fields are immutable');

    await expect(withRollback(database, sql => sql`
      insert into commerce.payment_transactions(order_id,provider,kind,status,amount,currency)
      values (${paidOrderId}::uuid,'manual','capture','succeeded',1,'USD')
    `)).rejects.toThrow('exceeds order total');

    const forgedRefund = await api(`/rest/v1/order_items?id=eq.${paidOrderItemId}`, {
      service: true, method: 'PATCH', body: { refunded_quantity: 1, refunded_amount: 9.9 },
    });
    expect(forgedRefund.status).toBe(400);
    expect((forgedRefund.data as { message: string }).message).toContain('snapshot is immutable');

    const forgedStatus = await api(`/rest/v1/orders?id=eq.${paidOrderId}`, {
      service: true, method: 'PATCH', body: { financial_status: 'refunded' },
    });
    expect(forgedStatus.status).toBe(400);
    expect((forgedStatus.data as { message: string }).message).toContain('refund status');
  });

  test('service-only Payment Intent 捕获具备幂等性并原子推进订单', async () => {
    const owner = await signup();
    const { data: created } = await rpc('create_order', {
      idempotency_key: crypto.randomUUID(), items: [{ variant_id: mugId, quantity: 1 }], address: TEST_ADDRESS,
    }, owner.token);
    const orderId = (created as { id: string }).id;
    const intentKey = `pi-${crypto.randomUUID()}`;

    const denied = await rpc('create_payment_intent', {
      order_id: orderId, provider: 'paypal', idempotency_key: intentKey,
    }, owner.token);
    expect(denied.status).toBe(403);
    expect((denied.data as { code: string }).code).toBe('42501');

    const first = await rpc('create_payment_intent', {
      order_id: orderId,
      provider: 'PAYPAL',
      idempotency_key: intentKey,
      metadata: { checkout: 'test' },
    }, undefined, true);
    const second = await rpc('create_payment_intent', {
      order_id: orderId, provider: 'paypal', idempotency_key: intentKey,
    }, undefined, true);
    expect(first.status).toBe(200);
    expect((second.data as { id: string }).id).toBe((first.data as { id: string }).id);

    const captureKey = `evt-${crypto.randomUUID()}`;
    const reference = `pi_provider_${crypto.randomUUID()}`;
    const captured = await rpc('capture_payment_intent', {
      payment_intent_id: (first.data as { id: string }).id,
      provider_reference: reference,
      idempotency_key: captureKey,
    }, undefined, true);
    const replay = await rpc('capture_payment_intent', {
      payment_intent_id: (first.data as { id: string }).id,
      provider_reference: reference,
      idempotency_key: captureKey,
    }, undefined, true);
    expect(captured.status).toBe(200);
    expect((replay.data as { id: string }).id).toBe((captured.data as { id: string }).id);

    const mismatchedReplay = await rpc('capture_payment_intent', {
      payment_intent_id: (first.data as { id: string }).id,
      provider_reference: `${reference}-different`,
      idempotency_key: captureKey,
    }, undefined, true);
    expect(mismatchedReplay.status).toBe(400);
    expect((mismatchedReplay.data as { message: string }).message).toContain('different capture parameters');

    const value = await ledger(orderId, owner.token);
    expect(value.order.financial_status).toBe('paid');
    expect(value.payment_intents[0].status).toBe('succeeded');
    expect(value.transactions[0]).toMatchObject({
      payment_intent_id: (first.data as { id: string }).id,
      provider: 'paypal', kind: 'capture', status: 'succeeded',
    });

    const conflictingReplay = await rpc('capture_payment_intent', {
      payment_intent_id: (first.data as { id: string }).id,
      provider_reference: reference,
      idempotency_key: `different-${crypto.randomUUID()}`,
    }, undefined, true);
    expect(conflictingReplay.status).toBe(400);
    expect((conflictingReplay.data as { message: string }).message).toContain('already captured');

    const reserved = await rpc('create_refund_request', {
      order_id: orderId,
      actor_id: admin.userId,
      provider: 'paypal',
      idempotency_key: `refund-${crypto.randomUUID()}`,
      amount: Number((created as { total: number }).total),
    }, undefined, true);
    expect(reserved.status).toBe(200);
    expect((reserved.data as { status: string }).status).toBe('requested');
    await expect(withRollback(database, sql => sql`
      insert into commerce.payment_transactions(order_id,provider,kind,status,amount,currency)
      values (${orderId}::uuid,'manual','refund','succeeded',0.01,'USD')
    `)).rejects.toThrow('active asynchronous refund request');
    expect((await ledger(orderId, owner.token)).transactions).toHaveLength(1);
    const overReserved = await rpc('create_refund_request', {
      order_id: orderId,
      actor_id: admin.userId,
      provider: 'paypal',
      idempotency_key: `refund-${crypto.randomUUID()}`,
      amount: 0.01,
    }, undefined, true);
    expect(overReserved.status).toBe(400);
    expect((overReserved.data as { message: string }).message).toContain('refundable balance');
  });
});

describe('履约行、退款行与 Outbox', () => {
  test('履约幂等写入关系化 fulfillment_lines，并成为汇总依据', async () => {
    const { id: paidOrderId, itemId: paidOrderItemId } = await givenPaidOrder();
    const key = `fulfillment-${crypto.randomUUID()}`;
    const trackingNumber = `SF-${crypto.randomUUID()}`;
    const body = {
      order_id: paidOrderId,
      items: [{ order_item_id: paidOrderItemId, quantity: 1 }],
      idempotency_key: key,
      carrier: 'Example carrier', tracking_number: trackingNumber,
    };
    const [first, replay] = await Promise.all([
      rpc('create_fulfillment', body, admin.token),
      rpc('create_fulfillment', body, admin.token),
    ]);
    expect(first.status).toBe(200);
    const fulfillmentId = (first.data as { id: string }).id;
    expect((replay.data as { id: string }).id).toBe(fulfillmentId);

    const mismatch = await rpc('create_fulfillment', {
      ...body, items: [{ order_item_id: paidOrderItemId, quantity: 2 }],
    }, admin.token);
    expect(mismatch.status).toBe(400);
    expect((mismatch.data as { message: string }).message).toContain('different fulfillment parameters');

    const value = await ledger(paidOrderId);
    const fulfillment = value.fulfillments.find((row) => row.id === fulfillmentId);
    expect(fulfillment?.lines).toEqual([{ order_item_id: paidOrderItemId, quantity: 1 }]);
    expect(value.order.fulfillment_status).toBe('partially_fulfilled');

    const mutation = await api(`/rest/v1/fulfillments?id=eq.${fulfillmentId}`, {
      service: true,
      method: 'PATCH',
      body: { items: [{ order_item_id: paidOrderItemId, quantity: 2 }] },
    });
    expect(mutation.status).toBe(400);
    expect((mutation.data as { message: string }).message).toContain('commercial fields are immutable');
  });

  test('取消履约后按关系化行重算订单，保留不可变履约事实', async () => {
    const { id: paidOrderId, itemId: paidOrderItemId, fulfillmentId } = await givenPaidOrder('active');
    const cancelled = await api(`/rest/v1/fulfillments?id=eq.${fulfillmentId}`, {
      service: true, method: 'PATCH', body: { status: 'cancelled' },
    });
    expect(cancelled.status).toBe(200);

    const value = await ledger(paidOrderId);
    expect(value.order.fulfillment_status).toBe('unfulfilled');
    expect(value.fulfillments.find((row) => row.id === fulfillmentId)?.status).toBe('cancelled');
    expect(value.fulfillments.find((row) => row.id === fulfillmentId)?.lines)
      .toEqual([{ order_item_id: paidOrderItemId, quantity: 1 }]);
  });

  test('按行退款生成 refund header/lines，并关联父 capture transaction', async () => {
    const { id: paidOrderId, itemId: paidOrderItemId } = await givenPaidOrder('cancelled');
    const before = await ledger(paidOrderId);
    const capture = before.transactions.find((row) => row.kind === 'capture');

    const key = `refund-${crypto.randomUUID()}`;
    const body = {
      order_id: paidOrderId,
      idempotency_key: key,
      items: [{ order_item_id: paidOrderItemId, quantity: 1 }],
      restock: true,
      reason: '账本退款测试',
    };
    const [refunded, replay] = await Promise.all([
      rpc('refund_order', body, admin.token),
      rpc('refund_order', body, admin.token),
    ]);
    expect(refunded.status).toBe(200);
    expect(replay.data).toEqual(refunded.data);

    const mismatch = await rpc('refund_order', {
      ...body, items: [{ order_item_id: paidOrderItemId, quantity: 2 }],
    }, admin.token);
    expect(mismatch.status).toBe(400);
    expect((mismatch.data as { message: string }).message).toContain('different refund parameters');

    const value = await ledger(paidOrderId);
    expect(value.refunds.length).toBe(1);
    expect(value.refunds[0]).toMatchObject({
      source: 'items', reason: '账本退款测试', restock_requested: true,
    });
    expect(value.refunds[0].lines).toEqual([
      expect.objectContaining({
        order_item_id: paidOrderItemId, quantity: 1, restocked_quantity: 1,
      }),
    ]);

    const refundTransaction = value.transactions.find((row) => row.kind === 'refund');
    expect(refundTransaction?.parent_transaction_id).toBe(capture?.id);
    expect(Number(value.balances.refunded)).toBeCloseTo(Number(value.refunds[0].amount));
    expect(Number(value.balances.net_paid)).toBeCloseTo(
      Number(value.balances.captured) - Number(value.balances.refunded),
    );
  });

  test('Outbox 支持并发 claim、租约归属和幂等 complete', async () => {
    await givenPendingOrder(); // Own an eligible event; do not rely on earlier tests.
    const customerClaim = await rpc('claim_outbox_events', {
      worker_id: 'customer', max_events: 1,
    }, buyer.token);
    expect(customerClaim.status).toBe(403);
    expect((customerClaim.data as { code: string }).code).toBe('42501');

    const workerA = `worker-a-${crypto.randomUUID()}`;
    const workerB = `worker-b-${crypto.randomUUID()}`;
    const [a, b] = await Promise.all([
      rpc('claim_outbox_events', {
        worker_id: workerA, max_events: 10, lease_seconds: 60,
      }, undefined, true),
      rpc('claim_outbox_events', {
        worker_id: workerB, max_events: 10, lease_seconds: 60,
      }, undefined, true),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    const eventsA = a.data as Array<{ event_id: string; event_type: string; attempt: number; lease_token: string }>;
    const eventsB = b.data as Array<{ event_id: string; event_type: string; attempt: number; lease_token: string }>;
    expect(eventsA.length + eventsB.length).toBeGreaterThan(0);
    const idsA = new Set(eventsA.map((event) => event.event_id));
    expect(eventsB.some((event) => idsA.has(event.event_id))).toBe(false);

    const event = eventsA[0] ?? eventsB[0];
    const owner = eventsA.length > 0 ? workerA : workerB;
    const completed = await rpc('complete_outbox_event', {
      event_id: event.event_id, worker_id: owner, lease_token: event.lease_token, succeeded: true,
    }, undefined, true);
    const replay = await rpc('complete_outbox_event', {
      event_id: event.event_id, worker_id: owner, lease_token: event.lease_token, succeeded: true,
    }, undefined, true);
    expect(completed.data).toBe(true);
    expect(replay.data).toBe(false);
  });
});
