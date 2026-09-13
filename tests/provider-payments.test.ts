import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { api, rpc, signup, makeAdmin, stockOf, type TestUser } from './helpers';
import {
  checked, fixtureOrder, fixtureIntent, paymentFixture, paymentEvent, settleIntent,
  type PaymentFixture, type FixtureIntent,
} from './payment-fixtures';
import { testDatabase } from './database-concurrency';
import { sha256Hex } from '../supabase/functions/_shared/provider-events';

const database = testDatabase();
let admin: TestUser;
let buyer: TestUser;
let stranger: TestUser;
let fixture: PaymentFixture;
beforeAll(async () => {
  admin = await signup(); buyer = await signup(); stranger = await signup();
  await makeAdmin(admin.userId);
  fixture = await paymentFixture(admin);
});
afterAll(async () => {
  if (fixture) await api(`/rest/v1/products?id=eq.${fixture.productId}`, {
    service: true, method: 'PATCH', body: { status: 'archived' },
  });
  await database.close();
});

interface Refund {
  id: string; status: string; amount: number; currency: string;
  provider_reference: string | null; parent_provider_reference: string;
}
interface Operations {
  payment_intents: Array<{ id: string; status: string }>;
  refund_requests: Refund[];
  provider_money_movements: Array<{
    kind: string; reconciliation_status: string; error: string | null;
    amount: number; currency: string; payment_transaction_id: string | null;
  }>;
}
const operations = (id: string, token = buyer.token) => checked<Operations>(
  rpc('get_payment_operations', { order_id: id }, token),
);
const captureData = (intent: FixtureIntent) => ({
  amount: intent.amount.toFixed(2), currency: intent.currency, status: 'completed',
  order_reference: intent.provider_reference, metadata: { tera_payment_intent_id: intent.id },
});
const requestRefund = (orderId: string, extra: Record<string, unknown> = {}) => checked<Refund>(
  rpc('create_refund_request', {
    order_id: orderId, actor_id: admin.userId, provider: 'paypal',
    idempotency_key: crypto.randomUUID(), amount: '1.00', ...extra,
  }, undefined, true),
);
const bindRefund = (refund: Refund, reference: string) => checked(rpc('bind_refund_request_provider', {
  refund_request_id: refund.id, provider_reference: reference, provider_status: 'pending',
  amount: refund.amount, currency: refund.currency,
}, undefined, true));
const refundData = (refund: Refund, status = 'completed') => ({
  status, amount: refund.amount.toFixed(2), currency: refund.currency,
  capture_reference: refund.parent_provider_reference, metadata: { tera_refund_request_id: refund.id },
});

describe('PayPal provider bindings and Inbox', () => {
  test('service-only、归属、单一活动意图和绑定金额检查保留；拒绝其他线上渠道', async () => {
    const order = await fixtureOrder(fixture, buyer);
    const command = {
      order_id: order.id, actor_id: buyer.userId, provider: 'paypal', idempotency_key: crypto.randomUUID(),
    };
    expect((await rpc('create_payment_intent_for_customer', command, buyer.token)).status).toBe(403);
    expect((await rpc('create_payment_intent_for_customer', { ...command, provider: 'unsupported' }, undefined, true)).status).toBe(400);
    const intent = await fixtureIntent(order, buyer);
    expect((await rpc('create_payment_intent_for_customer', command, undefined, true)).status).toBe(400);
    expect((await rpc('bind_payment_intent_provider', {
      payment_intent_id: intent.id, provider_reference: intent.provider_reference,
      provider_status: 'processing', amount: intent.amount + 1, currency: intent.currency,
    }, undefined, true)).status).toBe(400);
    expect((await rpc('get_payment_operations', { order_id: order.id }, stranger.token)).status).toBe(400);
  });

  test('同一事件幂等，事实冲突拒绝；终态后的旧 pending 不回退或重复扣库存', async () => {
    const order = await fixtureOrder(fixture, buyer);
    const intent = await fixtureIntent(order, buyer);
    const reference = `CAPTURE${crypto.randomUUID()}`;
    const data = captureData(intent);
    const command = {
      provider: 'paypal', provider_event_id: `WH-${crypto.randomUUID()}`, source: 'webhook',
      event_type: 'PAYMENT.CAPTURE.COMPLETED', object_reference: reference,
      livemode: false, occurred_at: new Date().toISOString(), payload_hash: await sha256Hex(JSON.stringify(data)), data,
    };
    const before = await stockOf(fixture.sku);
    for (let i = 0; i < 2; i++) expect(await checked(rpc('ingest_payment_provider_event', command, undefined, true)))
      .toMatchObject({ status: 'processed', outcome: 'captured' });
    expect((await rpc('ingest_payment_provider_event', { ...command, payload_hash: 'a'.repeat(64) }, undefined, true)).status).toBe(400);
    expect(await paymentEvent('paypal', 'PAYMENT.CAPTURE.PENDING', reference, { ...data, status: 'pending' }))
      .toMatchObject({ status: 'ignored', outcome: 'stale_payment_event' });
    expect(await stockOf(fixture.sku)).toBe(before - 1);
  });

  test('只有 metadata 的早到成功不自动绑定；API 绑定后 Worker 匹配原资金事实', async () => {
    const order = await fixtureOrder(fixture, buyer);
    const intent = await checked<FixtureIntent>(rpc('create_payment_intent_for_customer', {
      order_id: order.id, actor_id: buyer.userId, provider: 'paypal', idempotency_key: crypto.randomUUID(),
    }, undefined, true));
    const orderReference = `ORDER${crypto.randomUUID()}`;
    const reference = `CAPTURE${crypto.randomUUID()}`;
    const before = await stockOf(fixture.sku);
    expect(await paymentEvent('paypal', 'PAYMENT.CAPTURE.COMPLETED', reference, {
      ...captureData(intent), order_reference: orderReference,
    })).toMatchObject({ status: 'received', outcome: 'unmatched_payment_intent' });
    const [unmatched] = await database`select reconciliation_status, payment_intent_id from commerce.provider_money_movements where provider_reference = ${reference}`;
    expect(unmatched).toMatchObject({ reconciliation_status: 'unmatched', payment_intent_id: null });
    expect(await stockOf(fixture.sku)).toBe(before);
    await checked(rpc('bind_payment_intent_provider', {
      payment_intent_id: intent.id, provider_reference: orderReference, provider_status: 'processing',
      amount: intent.amount, currency: intent.currency,
    }, undefined, true));
    await checked(rpc('retry_payment_provider_events', { max_events: 100 }, undefined, true));
    expect((await operations(order.id)).provider_money_movements).toEqual([
      expect.objectContaining({ reconciliation_status: 'matched' }),
    ]);
    expect(await stockOf(fixture.sku)).toBe(before - 1);
  });

  test('已绑定 Order ID 优先于另一个订单的可变 metadata', async () => {
    const first = await fixtureOrder(fixture, buyer);
    const second = await fixtureOrder(fixture, buyer);
    const a = await fixtureIntent(first, buyer); const b = await fixtureIntent(second, buyer);
    expect(await paymentEvent('paypal', 'PAYMENT.CAPTURE.COMPLETED', `CAPTURE${crypto.randomUUID()}`, {
      ...captureData(a), metadata: { tera_payment_intent_id: b.id },
    })).toMatchObject({ outcome: 'captured' });
    expect((await operations(first.id)).payment_intents[0].status).toBe('succeeded');
    expect((await operations(second.id)).payment_intents[0].status).toBe('requires_action');
  });

  for (const mismatch of [{ amount: '11.00', currency: 'USD' }, { amount: '1234.00', currency: 'JPY' }]) {
    test(`成功 ${mismatch.currency} ${mismatch.amount} 不结算 USD 订单，但保留资金与告警`, async () => {
      const order = await fixtureOrder(fixture, buyer);
      const intent = await fixtureIntent(order, buyer);
      const before = await stockOf(fixture.sku);
      expect(await paymentEvent('paypal', 'PAYMENT.CAPTURE.COMPLETED', `CAPTURE${crypto.randomUUID()}`, {
        ...captureData(intent), ...mismatch,
      })).toMatchObject({ outcome: 'action_required' });
      expect((await operations(order.id)).provider_money_movements).toEqual([
        expect.objectContaining({ amount: Number(mismatch.amount), currency: mismatch.currency,
          reconciliation_status: 'action_required', payment_transaction_id: null, error: null }),
      ]);
      expect((await operations(order.id, admin.token)).provider_money_movements[0].error).toContain('mismatch');
      expect(await stockOf(fixture.sku)).toBe(before);
    });
  }
});

describe('PayPal refund binding and ledger protections', () => {
  test('早到退款不靠 metadata 自动落账；绑定后重试且不重复回补，即使关闭库存跟踪', async () => {
    const isolated = await paymentFixture(admin);
    try {
      const order = await fixtureOrder(isolated, buyer, 2);
      await settleIntent(await fixtureIntent(order, buyer));
      const request = await requestRefund(order.id, {
        amount: null, items: [{ order_item_id: order.itemId, quantity: 1 }], restock: true,
      });
      const before = await stockOf(isolated.sku);
      const reference = `REFUND${crypto.randomUUID()}`;
      expect(await paymentEvent('paypal', 'paypal.refund.api_result', reference, refundData(request)))
        .toMatchObject({ status: 'received', outcome: 'unmatched_refund' });
      expect((await operations(order.id)).refund_requests[0].status).toBe('requested');
      expect(await stockOf(isolated.sku)).toBe(before);
      expect((await rpc('refund_order', { idempotency_key: crypto.randomUUID(), order_id: order.id, amount: 1 }, admin.token)).status).toBe(400);
      await bindRefund(request, reference);
      await checked(api(`/rest/v1/product_variants?id=eq.${isolated.variantId}`, {
        service: true, method: 'PATCH', body: { track_inventory: false },
      }));
      await checked(rpc('retry_payment_provider_events', { max_events: 100 }, undefined, true));
      expect(await paymentEvent('paypal', 'paypal.refund.api_result', reference, refundData(request)))
        .toMatchObject({ outcome: 'refunded' });
      expect(await stockOf(isolated.sku)).toBe(before + 1);
      const state = await operations(order.id);
      expect(state.refund_requests[0].status).toBe('succeeded');
      expect(state.provider_money_movements.filter(row => row.kind === 'refund')).toHaveLength(1);
    } finally {
      await api(`/rest/v1/products?id=eq.${isolated.productId}`, { service: true, method: 'PATCH', body: { status: 'archived' } });
    }
  });

  for (const mismatch of ['parent', 'amount', 'currency']) {
    test(`成功退款 ${mismatch} 冲突仍保存资金，不退款/回库；重放不重复事实`, async () => {
      const order = await fixtureOrder(fixture, buyer, 2);
      await settleIntent(await fixtureIntent(order, buyer));
      const request = await requestRefund(order.id, {
        amount: null, items: [{ order_item_id: order.itemId, quantity: 1 }], restock: true,
      });
      const reference = `REFUND${crypto.randomUUID()}`;
      await bindRefund(request, reference);
      const data = { ...refundData(request), ...(mismatch === 'parent'
        ? { capture_reference: 'CAPTUREWRONG' } : mismatch === 'amount'
          ? { amount: '9.00' } : { currency: 'EUR' }) };
      const before = await stockOf(fixture.sku);
      for (let i = 0; i < 2; i++) expect(await paymentEvent('paypal', 'paypal.refund.api_result', reference, data))
        .toMatchObject({ status: 'processed', outcome: 'action_required' });
      const state = await operations(order.id, admin.token);
      expect(state.refund_requests[0].status).toBe('processing');
      expect(state.provider_money_movements.filter(row => row.kind === 'refund')).toEqual([
        expect.objectContaining({ reconciliation_status: 'action_required', error: expect.stringContaining('mismatch') }),
      ]);
      expect(await stockOf(fixture.sku)).toBe(before);
    });
  }

  test('pending 预留不能超量；failed/cancelled 释放，可新建而不能改写旧请求', async () => {
    const order = await fixtureOrder(fixture, buyer, 2);
    await settleIntent(await fixtureIntent(order, buyer));
    const extra = { amount: null, items: [{ order_item_id: order.itemId, quantity: 2 }] };
    const request = await requestRefund(order.id, extra);
    await expect(requestRefund(order.id, extra)).rejects.toThrow('no refundable balance');
    const reference = `REFUND${crypto.randomUUID()}`;
    await bindRefund(request, reference);
    expect(await paymentEvent('paypal', 'PAYMENT.REFUND.FAILED', reference, refundData(request, 'failed')))
      .toMatchObject({ outcome: 'failed' });
    expect(await paymentEvent('paypal', 'PAYMENT.REFUND.PENDING', reference, refundData(request, 'pending')))
      .toMatchObject({ outcome: 'stale_refund_event' });
    const replacement = await requestRefund(order.id, extra);
    expect(await checked(rpc('cancel_refund_request', {
      refund_request_id: replacement.id, actor_id: admin.userId, provider_confirmed: false,
    }, undefined, true))).toMatchObject({ status: 'cancelled' });
    expect((await requestRefund(order.id, extra)).status).toBe('requested');
  });
});
