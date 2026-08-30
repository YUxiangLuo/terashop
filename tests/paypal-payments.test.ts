import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  api, CN_ADDRESS, makeAdmin, rpc, signup, stockOf, type TestUser,
} from './helpers';

interface Fixture {
  productId: string;
  variantId: string;
  sku: string;
}

interface IntentDto {
  id: string;
  order_id: string;
  order_number?: number;
  provider: string;
  status: string;
  amount: number;
  currency: string;
  provider_reference: string | null;
  shipping_address?: Record<string, unknown>;
}

interface CreatedOrder {
  id: string;
  itemId: string;
  intent: IntentDto;
  orderReference: string;
}

interface RefundDto {
  id: string;
  order_id: string;
  status: string;
  amount: number;
  currency: string;
  provider_reference: string | null;
  parent_provider_reference: string;
}

interface Operations {
  payment_intents: IntentDto[];
  provider_money_movements: Array<{
    kind: string;
    provider: string;
    provider_reference: string;
    amount: number;
    currency: string;
    reconciliation_status: string;
    payment_transaction_id: string | null;
    refund_request_id: string | null;
    error: string | null;
  }>;
  refund_requests: RefundDto[];
}

let admin: TestUser;
let buyer: TestUser;
let fixture: Fixture;
const createdProducts: string[] = [];

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function decimal(value: number | string): string {
  const [whole, fraction = ''] = String(value).split('.');
  return `${whole}.${fraction.padEnd(2, '0').slice(0, 2)}`;
}

async function paypalEvent(input: {
  eventId?: string;
  eventType: string;
  objectReference: string;
  data: Record<string, unknown>;
  source?: 'webhook' | 'api_response';
}) {
  const eventId = input.eventId ?? `WH-${crypto.randomUUID()}`;
  const payloadHash = await digest({ eventId, ...input });
  return rpc('ingest_payment_provider_event', {
    provider: 'paypal',
    provider_event_id: eventId,
    source: input.source ?? 'webhook',
    event_type: input.eventType,
    object_reference: input.objectReference,
    livemode: false,
    occurred_at: '2026-08-30T00:00:00.000Z',
    payload_hash: payloadHash,
    data: input.data,
  }, undefined, true);
}

async function operations(orderId: string, token = buyer.token): Promise<Operations> {
  const result = await rpc('get_payment_operations', { order_id: orderId }, token);
  if (result.status >= 400) throw new Error(JSON.stringify(result.data));
  return result.data as Operations;
}

async function createFixture(): Promise<Fixture> {
  const suffix = crypto.randomUUID();
  const sku = `PAYPAL-${suffix}`;
  const products = await api('/rest/v1/products?select=id', {
    service: true,
    method: 'POST',
    body: { slug: `paypal-${suffix}`, name: 'PayPal fixture', status: 'active' },
  });
  const productId = (products.data as Array<{ id: string }>)[0].id;
  createdProducts.push(productId);
  const variants = await api('/rest/v1/product_variants?select=id', {
    service: true,
    method: 'POST',
    body: { product_id: productId, sku, price: 10, track_inventory: true },
  });
  const variantId = (variants.data as Array<{ id: string }>)[0].id;
  const stocked = await rpc('adjust_inventory', {
    variant_id: variantId,
    delta: 12,
    reason: 'restock',
    note: 'PayPal tests',
  }, admin.token);
  if (stocked.status >= 400) throw new Error(JSON.stringify(stocked.data));
  return { productId, variantId, sku };
}

async function createPayPalOrder(quantity: number): Promise<CreatedOrder> {
  const quote = await rpc('create_checkout_quote', {
    items: [{ variant_id: fixture.variantId, quantity }],
    idempotency_key: `paypal-quote-${crypto.randomUUID()}`,
    address: CN_ADDRESS,
  }, buyer.token);
  if (quote.status >= 400) throw new Error(JSON.stringify(quote.data));
  const converted = await rpc('create_order_from_quote', {
    quote_id: (quote.data as { id: string }).id,
  }, buyer.token);
  if (converted.status >= 400) throw new Error(JSON.stringify(converted.data));
  const orderId = (converted.data as { id: string }).id;
  const items = await api(`/rest/v1/order_items?order_id=eq.${orderId}&select=id`, {
    token: buyer.token,
  });
  const intent = await rpc('create_payment_intent_for_customer', {
    order_id: orderId,
    customer_id: buyer.userId,
    provider: 'paypal',
    idempotency_key: `paypal-intent-${crypto.randomUUID()}`,
    metadata: { edge: true },
  }, undefined, true);
  if (intent.status >= 400) throw new Error(JSON.stringify(intent.data));
  const orderReference = `PAYPALORDER${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const row = intent.data as IntentDto;
  const bound = await rpc('bind_payment_intent_provider', {
    payment_intent_id: row.id,
    provider_reference: orderReference,
    provider_status: 'requires_action',
    amount: row.amount,
    currency: row.currency,
  }, undefined, true);
  if (bound.status >= 400) throw new Error(JSON.stringify(bound.data));
  return {
    id: orderId,
    itemId: (items.data as Array<{ id: string }>)[0].id,
    intent: row,
    orderReference,
  };
}

async function capturePayPal(created: CreatedOrder): Promise<string> {
  const captureReference = `CAPTURE${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const result = await paypalEvent({
    eventType: 'PAYMENT.CAPTURE.COMPLETED',
    objectReference: captureReference,
    data: {
      object_type: 'capture',
      status: 'completed',
      amount: decimal(created.intent.amount),
      currency: created.intent.currency,
      order_reference: created.orderReference,
      metadata: {
        tera_payment_intent_id: created.intent.id,
        tera_order_id: created.id,
      },
    },
  });
  expect(result.data).toMatchObject({ status: 'processed', outcome: 'captured' });
  return captureReference;
}

afterAll(async () => {
  if (createdProducts.length > 0) {
    await api(`/rest/v1/products?id=in.(${createdProducts.join(',')})`, {
      service: true,
      method: 'PATCH',
      body: { status: 'archived' },
    });
  }
});

beforeAll(async () => {
  admin = await signup();
  buyer = await signup();
  await makeAdmin(admin.userId);
  fixture = await createFixture();
});

describe('PayPal Orders v2 与 Provider Inbox', () => {
  test('service DTO 返回支付所需快照，PayPal Order ID 与 Capture ID 分离且捕获幂等', async () => {
    const stockBefore = await stockOf(fixture.sku);
    const created = await createPayPalOrder(1);
    expect(created.intent).toMatchObject({
      provider: 'paypal',
      shipping_address: expect.objectContaining({ country: 'CN' }),
    });
    expect(created.intent.order_number).toBeGreaterThan(0);

    const denied = await rpc('get_payment_intent_for_customer', {
      payment_intent_id: created.intent.id,
      customer_id: buyer.userId,
      provider: 'paypal',
    }, buyer.token);
    expect(denied.status).toBe(403);

    const pending = await paypalEvent({
      eventType: 'PAYMENT.CAPTURE.PENDING',
      objectReference: `PENDING${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`,
      data: {
        status: 'pending',
        amount: decimal(created.intent.amount),
        currency: created.intent.currency,
        order_reference: created.orderReference,
        metadata: { tera_payment_intent_id: created.intent.id },
      },
    });
    expect(pending.data).toMatchObject({ status: 'processed', outcome: 'processing' });

    const captureReference = await capturePayPal(created);
    const replay = await paypalEvent({
      eventId: `api:capture:${captureReference}:COMPLETED:replay`,
      eventType: 'paypal.capture.api_result',
      objectReference: captureReference,
      source: 'api_response',
      data: {
        status: 'completed',
        amount: decimal(created.intent.amount),
        currency: created.intent.currency,
        order_reference: created.orderReference,
        metadata: { tera_payment_intent_id: created.intent.id },
      },
    });
    expect(replay.data).toMatchObject({ status: 'processed', outcome: 'captured' });

    const state = await operations(created.id);
    expect(state.payment_intents[0]).toMatchObject({
      status: 'succeeded',
      provider_reference: created.orderReference,
    });
    expect(state.provider_money_movements).toEqual([
      expect.objectContaining({
        kind: 'capture',
        provider: 'paypal',
        provider_reference: captureReference,
        reconciliation_status: 'matched',
      }),
    ]);
    expect(await stockOf(fixture.sku)).toBe(stockBefore - 1);
  });

  test('无法关联的非 CNY Capture 仍先保存为外部资金事实', async () => {
    const result = await paypalEvent({
      eventId: `WH-${crypto.randomUUID()}`,
      eventType: 'PAYMENT.CAPTURE.COMPLETED',
      objectReference: `CAPTURE-${crypto.randomUUID()}`,
      data: {
        kind: 'capture',
        status: 'completed',
        amount: '12.34',
        currency: 'EUR',
        order_reference: null,
        metadata: {},
      },
    });
    expect(result.status).toBe(200);
    expect((result.data as any).status).toBe('received');
    expect((result.data as any).outcome).toBe('unmatched_payment_intent');
    expect((result.data as any).resource_type).toBe('provider_money_movement');
  });

  test('PayPal 成功金额不匹配时保留资金事实但不推进订单', async () => {
    const created = await createPayPalOrder(1);
    const result = await paypalEvent({
      eventType: 'PAYMENT.CAPTURE.COMPLETED',
      objectReference: `CAPTURE${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`,
      data: {
        status: 'completed',
        amount: '11.00',
        currency: 'EUR',
        order_reference: created.orderReference,
        metadata: { tera_payment_intent_id: created.intent.id },
      },
    });
    expect(result.data).toMatchObject({ status: 'processed', outcome: 'action_required' });
    const state = await operations(created.id, admin.token);
    expect(state.provider_money_movements[0]).toMatchObject({
      amount: 11,
      currency: 'EUR',
      reconciliation_status: 'action_required',
      payment_transaction_id: null,
    });
    expect(state.provider_money_movements[0].error).toContain('amount or currency');
    const order = await api(`/rest/v1/orders?id=eq.${created.id}&select=financial_status`, {
      token: buyer.token,
    });
    expect(order.data).toEqual([{ financial_status: 'pending' }]);
  });

  test('PayPal declined 终结当前意图并允许同订单重新选择支付尝试', async () => {
    const created = await createPayPalOrder(1);
    const declined = await paypalEvent({
      eventType: 'PAYMENT.CAPTURE.DECLINED',
      objectReference: `DECLINED${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`,
      data: {
        status: 'declined',
        amount: decimal(created.intent.amount),
        currency: created.intent.currency,
        order_reference: created.orderReference,
        failure_code: 'INSTRUMENT_DECLINED',
        metadata: { tera_payment_intent_id: created.intent.id },
      },
    });
    expect(declined.data).toMatchObject({ status: 'processed', outcome: 'failed' });
    const replacement = await rpc('create_payment_intent_for_customer', {
      order_id: created.id,
      customer_id: buyer.userId,
      provider: 'paypal',
      idempotency_key: `paypal-retry-${crypto.randomUUID()}`,
    }, undefined, true);
    expect(replacement.status).toBe(200);
    expect(replacement.data).toMatchObject({ status: 'requires_action', provider: 'paypal' });
  });

  test('PayPal reversal 记为外部资金异常并阻止继续退款，不伪造本地退款', async () => {
    const created = await createPayPalOrder(1);
    const captureReference = await capturePayPal(created);
    const reversed = await paypalEvent({
      eventType: 'PAYMENT.CAPTURE.REVERSED',
      objectReference: captureReference,
      data: {
        status: 'reversed',
        amount: decimal(created.intent.amount),
        currency: created.intent.currency,
        order_reference: created.orderReference,
        metadata: { tera_payment_intent_id: created.intent.id },
      },
    });
    expect(reversed.data).toMatchObject({ status: 'processed', outcome: 'action_required' });
    const state = await operations(created.id, admin.token);
    expect(state.provider_money_movements.find((row) => row.kind === 'refund')).toMatchObject({
      provider_reference: captureReference,
      reconciliation_status: 'action_required',
      refund_request_id: null,
    });
    const blocked = await rpc('create_refund_request', {
      order_id: created.id,
      actor_id: admin.userId,
      provider: 'paypal',
      idempotency_key: `blocked-reversal-${crypto.randomUUID()}`,
      items: [{ order_item_id: created.itemId, quantity: 1 }],
    }, undefined, true);
    expect(blocked.status).toBe(400);
    expect((blocked.data as { message: string }).message).toContain('unresolved provider reversal');
    const order = await api(`/rest/v1/orders?id=eq.${created.id}&select=financial_status`, {
      token: buyer.token,
    });
    expect(order.data).toEqual([{ financial_status: 'paid' }]);

    const stockBeforeEarlyEvents = await stockOf(fixture.sku);
    const outOfOrder = await createPayPalOrder(1);
    const outOfOrderCapture = `CAPTURE${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const reversalEventId = `WH-${crypto.randomUUID()}`;
    const earlyReversal = await paypalEvent({
      eventId: reversalEventId,
      eventType: 'PAYMENT.CAPTURE.REVERSED',
      objectReference: outOfOrderCapture,
      data: {
        status: 'reversed', amount: decimal(outOfOrder.intent.amount),
        currency: outOfOrder.intent.currency, order_reference: outOfOrder.orderReference,
        metadata: { tera_payment_intent_id: outOfOrder.intent.id },
      },
    });
    expect(earlyReversal.data).toMatchObject({ status: 'received', outcome: 'unmatched_reversal' });
    const lateCompleted = await paypalEvent({
      eventType: 'PAYMENT.CAPTURE.COMPLETED',
      objectReference: outOfOrderCapture,
      data: {
        status: 'completed', amount: decimal(outOfOrder.intent.amount),
        currency: outOfOrder.intent.currency, order_reference: outOfOrder.orderReference,
        metadata: { tera_payment_intent_id: outOfOrder.intent.id },
      },
    });
    expect(lateCompleted.data).toMatchObject({ status: 'processed', outcome: 'action_required' });
    expect(await stockOf(fixture.sku)).toBe(stockBeforeEarlyEvents);
    const outOfOrderState = await operations(outOfOrder.id, admin.token);
    expect(outOfOrderState.provider_money_movements).toHaveLength(2);
    expect(outOfOrderState.provider_money_movements.every(
      (movement) => movement.reconciliation_status === 'action_required',
    )).toBe(true);
    const retried = await rpc('retry_payment_provider_events', { max_events: 100 }, undefined, true);
    expect((retried.data as any[]).find(
      (event) => event.provider_event_id === reversalEventId,
    )).toMatchObject({ status: 'processed', outcome: 'action_required' });
    const outOfOrderOrder = await api(
      `/rest/v1/orders?id=eq.${outOfOrder.id}&select=financial_status`, { token: buyer.token },
    );
    expect(outOfOrderOrder.data).toEqual([{ financial_status: 'pending' }]);
  });
});

describe('PayPal 异步退款', () => {
  test('pending 只预留；API COMPLETED 后落账回补，Capture refunded 信号触发轮询', async () => {
    const created = await createPayPalOrder(2);
    const captureReference = await capturePayPal(created);
    const stockBeforeRefund = await stockOf(fixture.sku);
    const requested = await rpc('create_refund_request', {
      order_id: created.id,
      actor_id: admin.userId,
      provider: 'paypal',
      idempotency_key: `paypal-refund-${crypto.randomUUID()}`,
      items: [{ order_item_id: created.itemId, quantity: 1 }],
      reason: 'PayPal refund test',
      restock: true,
    }, undefined, true);
    expect(requested.status).toBe(200);
    const refund = requested.data as RefundDto;
    const refundReference = `REFUND${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const bound = await rpc('bind_refund_request_provider', {
      refund_request_id: refund.id,
      provider_reference: refundReference,
      provider_status: 'pending',
      amount: refund.amount,
      currency: refund.currency,
    }, undefined, true);
    expect(bound.data).toMatchObject({ status: 'processing' });

    const deniedList = await rpc('list_pending_provider_refunds', {
      provider: 'paypal', max_requests: 10,
    }, buyer.token);
    expect(deniedList.status).toBe(403);
    const pendingList = await rpc('list_pending_provider_refunds', {
      provider: 'paypal', max_requests: 10,
    }, undefined, true);
    expect(pendingList.status).toBe(200);
    expect(pendingList.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: refund.id, parent_provider_reference: captureReference }),
    ]));
    const duplicateClaim = await rpc('list_pending_provider_refunds', {
      provider: 'paypal', max_requests: 10,
    }, undefined, true);
    expect(duplicateClaim.data).toEqual([]);

    const pending = await paypalEvent({
      eventType: 'PAYMENT.REFUND.PENDING',
      objectReference: refundReference,
      data: {
        status: 'pending',
        amount: decimal(refund.amount),
        currency: refund.currency,
        capture_reference: captureReference,
        metadata: { tera_refund_request_id: refund.id },
      },
    });
    expect(pending.data).toMatchObject({ status: 'processed', outcome: 'pending' });
    expect(await stockOf(fixture.sku)).toBe(stockBeforeRefund);

    const completed = await paypalEvent({
      eventType: 'paypal.refund.api_result',
      objectReference: refundReference,
      source: 'api_response',
      data: {
        status: 'completed',
        amount: decimal(refund.amount),
        currency: refund.currency,
        capture_reference: captureReference,
        metadata: { tera_refund_request_id: refund.id },
      },
    });
    expect(completed.data).toMatchObject({ status: 'processed', outcome: 'refunded' });
    expect(await stockOf(fixture.sku)).toBe(stockBeforeRefund + 1);
    const state = await operations(created.id);
    expect(state.refund_requests[0]).toMatchObject({ status: 'succeeded' });
    expect(state.provider_money_movements.find((row) => row.refund_request_id === refund.id))
      .toMatchObject({ kind: 'refund', reconciliation_status: 'matched' });

    const signal = await paypalEvent({
      eventType: 'PAYMENT.CAPTURE.REFUNDED',
      objectReference: captureReference,
      data: {
        status: 'refunded',
        amount: decimal(created.intent.amount),
        currency: created.intent.currency,
        order_reference: created.orderReference,
        metadata: { tera_payment_intent_id: created.intent.id },
      },
    });
    expect(signal.data).toMatchObject({
      status: 'processed', outcome: 'refund_reconciliation_requested',
    });
  });

  test('PAYMENT.REFUND.FAILED 释放预留，可重新发起退款', async () => {
    const created = await createPayPalOrder(1);
    const captureReference = await capturePayPal(created);
    const first = await rpc('create_refund_request', {
      order_id: created.id,
      actor_id: admin.userId,
      provider: 'paypal',
      idempotency_key: `paypal-refund-fail-${crypto.randomUUID()}`,
      items: [{ order_item_id: created.itemId, quantity: 1 }],
    }, undefined, true);
    const refund = first.data as RefundDto;
    const refundReference = `REFUND${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
    await rpc('bind_refund_request_provider', {
      refund_request_id: refund.id,
      provider_reference: refundReference,
      provider_status: 'pending',
      amount: refund.amount,
      currency: refund.currency,
    }, undefined, true);
    const failed = await paypalEvent({
      eventType: 'PAYMENT.REFUND.FAILED',
      objectReference: refundReference,
      data: {
        status: 'failed',
        amount: decimal(refund.amount),
        currency: refund.currency,
        capture_reference: captureReference,
        failure_code: 'REFUND_FAILED',
        metadata: { tera_refund_request_id: refund.id },
      },
    });
    expect(failed.data).toMatchObject({ status: 'processed', outcome: 'failed' });
    const replacement = await rpc('create_refund_request', {
      order_id: created.id,
      actor_id: admin.userId,
      provider: 'paypal',
      idempotency_key: `paypal-refund-retry-${crypto.randomUUID()}`,
      items: [{ order_item_id: created.itemId, quantity: 1 }],
    }, undefined, true);
    expect(replacement.status).toBe(200);
  });
});
