import { beforeAll, describe, expect, test } from 'bun:test';
import {
  api, rpc, signup, makeAdmin, variantBySku, CN_ADDRESS,
  type TestUser,
} from './helpers';

let admin: TestUser;
let buyer: TestUser;
let stranger: TestUser;
let mugId: string;

let adjustmentOrderId: string;
let paidOrderId: string;
let paidOrderItemId: string;
let paidPaymentId: string;
let fulfillmentId: string;

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

beforeAll(async () => {
  admin = await signup();
  buyer = await signup();
  stranger = await signup();
  await makeAdmin(admin.userId);
  mugId = await variantBySku('MUG-350');
});

describe('关系化订单账本', () => {
  test('订单金额自动双写 adjustment ledger，且只通过安全 DTO 暴露', async () => {
    const { data: created } = await rpc('create_order', {
      items: [{ variant_id: mugId, quantity: 1 }], address: CN_ADDRESS,
    }, buyer.token);
    adjustmentOrderId = (created as { id: string }).id;

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

  test('create_order_v2 对语义相同的重试只建一单、只扣一次库存', async () => {
    const key = `order-${crypto.randomUUID()}`;
    const [first, replay] = await Promise.all([
      rpc('create_order_v2', {
        items: [
          { variant_id: mugId, quantity: 1 },
          { variant_id: mugId, quantity: 1 },
        ],
        address: CN_ADDRESS,
        idempotency_key: key,
      }, buyer.token),
      rpc('create_order_v2', {
        items: [{ variant_id: mugId, quantity: 2 }],
        address: CN_ADDRESS,
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
    expect(movements).toEqual([{ delta: -2 }]);

    const mismatch = await rpc('create_order_v2', {
      items: [{ variant_id: mugId, quantity: 3 }],
      address: CN_ADDRESS,
      idempotency_key: key,
    }, buyer.token);
    expect(mismatch.status).toBe(400);
    expect((mismatch.data as { message: string }).message).toContain('different order parameters');
  });

  test('pending 订单重算税时追加差额，不改写已有 adjustment', async () => {
    await rpc('update_order_address', {
      order_id: adjustmentOrderId,
      address: { receiver: 'John', phone: '1', country: 'US', detail: '1 Main St' },
    }, buyer.token);

    const value = await ledger(adjustmentOrderId);
    const taxes = value.adjustments.filter((row) => row.kind === 'tax');
    expect(taxes.length).toBe(2);
    expect(taxes.map((row) => Number(row.amount))).toEqual([1.29, -1.29]);
    expect(Number(value.balances.adjustment_total)).toBe(0);
    expect(value.balances.is_balanced).toBe(true);
  });

  test('陌生人读不到订单账本', async () => {
    const { status, data } = await rpc('get_order_ledger', {
      order_id: adjustmentOrderId,
    }, stranger.token);
    expect(status).toBe(400);
    expect((data as { message: string }).message).toBe('order not found');
  });
});

describe('支付交易与已支付快照', () => {
  test('mark_order_paid 兼容写 payments，同时生成 capture transaction', async () => {
    const { data: created } = await rpc('create_order', {
      items: [{ variant_id: mugId, quantity: 2 }], address: CN_ADDRESS,
    }, buyer.token);
    const order = created as { id: string; total: number };
    paidOrderId = order.id;

    const { data: items } = await api(
      `/rest/v1/order_items?order_id=eq.${paidOrderId}&select=id`, { token: buyer.token },
    );
    paidOrderItemId = (items as { id: string }[])[0].id;

    await rpc('mark_order_paid', {
      order_id: paidOrderId, provider: 'manual', provider_ref: `cash-${crypto.randomUUID()}`,
    }, admin.token);

    const { data: payments } = await api(
      `/rest/v1/payments?order_id=eq.${paidOrderId}&select=id`, { service: true },
    );
    paidPaymentId = (payments as { id: string }[])[0].id;

    const value = await ledger(paidOrderId);
    expect(value.transactions.length).toBe(1);
    expect(value.transactions[0]).toMatchObject({
      provider: 'manual', kind: 'capture', status: 'succeeded',
    });
    expect(Number(value.balances.captured)).toBeCloseTo(Number(order.total));
    expect(Number(value.balances.net_paid)).toBeCloseTo(Number(order.total));
  });

  test('即使 service role 也不能改写已支付订单或 payment 金额', async () => {
    const orderMutation = await api(`/rest/v1/orders?id=eq.${paidOrderId}`, {
      service: true, method: 'PATCH', body: { total: 0.01, tax_total: 0.01 },
    });
    expect(orderMutation.status).toBe(400);
    expect((orderMutation.data as { message: string }).message).toContain('snapshot is immutable');

    const paymentMutation = await api(`/rest/v1/payments?id=eq.${paidPaymentId}`, {
      service: true, method: 'PATCH', body: { amount: 0.01 },
    });
    expect(paymentMutation.status).toBe(400);
    expect((paymentMutation.data as { message: string }).message).toContain('commercial fields are immutable');

    const duplicateCapture = await api('/rest/v1/payments', {
      service: true,
      method: 'POST',
      body: {
        order_id: paidOrderId, provider: 'manual', kind: 'charge',
        status: 'succeeded', amount: 1, currency: 'CNY',
      },
    });
    expect(duplicateCapture.status).toBe(400);
    expect((duplicateCapture.data as { message: string }).message).toContain('exceeds order total');

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
      items: [{ variant_id: mugId, quantity: 1 }], address: CN_ADDRESS,
    }, owner.token);
    const orderId = (created as { id: string }).id;
    const intentKey = `pi-${crypto.randomUUID()}`;

    const denied = await rpc('create_payment_intent', {
      order_id: orderId, provider: 'stripe', idempotency_key: intentKey,
    }, owner.token);
    expect(denied.status).toBe(403);
    expect((denied.data as { code: string }).code).toBe('42501');

    const first = await rpc('create_payment_intent', {
      order_id: orderId,
      provider: 'STRIPE',
      idempotency_key: intentKey,
      metadata: { checkout: 'test' },
    }, undefined, true);
    const second = await rpc('create_payment_intent', {
      order_id: orderId, provider: 'stripe', idempotency_key: intentKey,
    }, undefined, true);
    expect(first.status).toBe(200);
    expect((second.data as { id: string }).id).toBe((first.data as { id: string }).id);

    const captureKey = `evt-${crypto.randomUUID()}`;
    const reference = `pi_provider_${crypto.randomUUID()}`;
    const captured = await rpc('capture_payment_intent', {
      payment_intent_id: (first.data as { id: string }).id,
      provider_reference: reference,
      idempotency_key: captureKey,
      raw: { verified_webhook: true },
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
      provider: 'stripe', kind: 'capture', status: 'succeeded',
    });

    const conflictingReplay = await rpc('capture_payment_intent', {
      payment_intent_id: (first.data as { id: string }).id,
      provider_reference: reference,
      idempotency_key: `different-${crypto.randomUUID()}`,
    }, undefined, true);
    expect(conflictingReplay.status).toBe(400);
    expect((conflictingReplay.data as { message: string }).message).toContain('already captured');
  });
});

describe('履约行、退款行与 Outbox', () => {
  test('履约 V2 幂等写入关系化 fulfillment_lines，并成为汇总依据', async () => {
    const key = `fulfillment-${crypto.randomUUID()}`;
    const trackingNumber = `SF-${crypto.randomUUID()}`;
    const body = {
      order_id: paidOrderId,
      items: [{ order_item_id: paidOrderItemId, quantity: 1 }],
      idempotency_key: key,
      carrier: '顺丰', tracking_number: trackingNumber,
    };
    const [first, replay] = await Promise.all([
      rpc('create_fulfillment_v2', body, admin.token),
      rpc('create_fulfillment_v2', body, admin.token),
    ]);
    fulfillmentId = (first.data as { id: string }).id;
    expect((replay.data as { id: string }).id).toBe(fulfillmentId);

    const mismatch = await rpc('create_fulfillment_v2', {
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
      rpc('refund_order_v2', body, admin.token),
      rpc('refund_order_v2', body, admin.token),
    ]);
    expect(refunded.status).toBe(200);
    expect(replay.data).toEqual(refunded.data);

    const mismatch = await rpc('refund_order_v2', {
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

    const eventsA = a.data as Array<{ event_id: string; event_type: string; attempt: number }>;
    const eventsB = b.data as Array<{ event_id: string; event_type: string; attempt: number }>;
    expect(eventsA.length + eventsB.length).toBeGreaterThan(0);
    const idsA = new Set(eventsA.map((event) => event.event_id));
    expect(eventsB.some((event) => idsA.has(event.event_id))).toBe(false);

    const event = eventsA[0] ?? eventsB[0];
    const owner = eventsA.length > 0 ? workerA : workerB;
    const completed = await rpc('complete_outbox_event', {
      event_id: event.event_id, worker_id: owner, succeeded: true,
    }, undefined, true);
    const replay = await rpc('complete_outbox_event', {
      event_id: event.event_id, worker_id: owner, succeeded: true,
    }, undefined, true);
    expect(completed.data).toBe(true);
    expect(replay.data).toBe(false);
  });
});
