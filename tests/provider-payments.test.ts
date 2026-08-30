import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  api, rpc, signup, makeAdmin, stockOf, CN_ADDRESS,
  type TestUser,
} from './helpers';

interface Fixture {
  productId: string;
  variantId: string;
  sku: string;
}

interface PaymentIntentDto {
  id: string;
  order_id: string;
  status: string;
  amount: number;
  currency: string;
  provider_reference: string | null;
}

interface RefundRequestDto {
  id: string;
  order_id: string;
  status: string;
  amount: number;
  currency: string;
  provider_reference: string | null;
  lines: Array<{ order_item_id: string; quantity: number; amount: number }>;
}

interface Operations {
  payment_intents: PaymentIntentDto[];
  provider_money_movements: Array<{
    kind: string;
    provider_reference: string;
    reconciliation_status: string;
    payment_transaction_id: string | null;
    refund_request_id: string | null;
    error: string | null;
  }>;
  provider_events: Array<{
    provider_event_id: string;
    status: string;
    outcome: string;
    attempts: number;
  }>;
  refund_requests: RefundRequestDto[];
}

let admin: TestUser;
let buyer: TestUser;
let stranger: TestUser;
let fixture: Fixture;
let orderId: string;
let orderItemId: string;
let intent: PaymentIntentDto;
let providerIntentRef: string;
let refundStockBefore: number;
const createdProducts: string[] = [];

async function hash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function minorUnits(amount: number | string): string {
  const [whole, fraction = ''] = String(amount).split('.');
  return `${whole}${fraction.padEnd(2, '0').slice(0, 2)}`.replace(/^0+(?=\d)/, '');
}

async function providerEvent(input: {
  eventId: string;
  eventType: string;
  objectReference: string;
  data: Record<string, unknown>;
  source?: 'webhook' | 'api_response';
}) {
  const payloadHash = await hash({
    id: input.eventId,
    type: input.eventType,
    object: input.objectReference,
    data: input.data,
  });
  return rpc('ingest_payment_provider_event', {
    provider: 'stripe',
    provider_event_id: input.eventId,
    source: input.source ?? 'webhook',
    event_type: input.eventType,
    object_reference: input.objectReference,
    livemode: false,
    occurred_at: '2026-08-30T00:00:00.000Z',
    payload_hash: payloadHash,
    data: input.data,
  }, undefined, true);
}

async function operations(id = orderId, token = buyer.token): Promise<Operations> {
  const result = await rpc('get_payment_operations', { order_id: id }, token);
  if (result.status >= 400) throw new Error(JSON.stringify(result.data));
  return result.data as Operations;
}

async function createFixture(): Promise<Fixture> {
  const suffix = crypto.randomUUID();
  const sku = `PROVIDER-${suffix}`;
  const products = await api('/rest/v1/products?select=id', {
    service: true,
    method: 'POST',
    body: { slug: `provider-${suffix}`, name: 'Provider payment fixture', status: 'active' },
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
    delta: 8,
    reason: 'restock',
    note: 'provider payment tests',
  }, admin.token);
  if (stocked.status >= 400) throw new Error(JSON.stringify(stocked.data));
  return { productId, variantId, sku };
}

async function createQuotedOrder(quantity: number): Promise<{
  id: string;
  itemId: string;
  intent: PaymentIntentDto;
}> {
  const quote = await rpc('create_checkout_quote', {
    items: [{ variant_id: fixture.variantId, quantity }],
    idempotency_key: `provider-quote-${crypto.randomUUID()}`,
    address: CN_ADDRESS,
  }, buyer.token);
  if (quote.status >= 400) throw new Error(JSON.stringify(quote.data));
  const converted = await rpc('create_order_from_quote', {
    quote_id: (quote.data as { id: string }).id,
  }, buyer.token);
  if (converted.status >= 400) throw new Error(JSON.stringify(converted.data));
  const id = (converted.data as { id: string }).id;
  const items = await api(`/rest/v1/order_items?order_id=eq.${id}&select=id`, {
    token: buyer.token,
  });
  const createdIntent = await rpc('create_payment_intent_for_customer', {
    order_id: id,
    customer_id: buyer.userId,
    provider: 'stripe',
    idempotency_key: `provider-intent-${crypto.randomUUID()}`,
    metadata: { edge: true },
  }, undefined, true);
  if (createdIntent.status >= 400) throw new Error(JSON.stringify(createdIntent.data));
  return {
    id,
    itemId: (items.data as Array<{ id: string }>)[0].id,
    intent: createdIntent.data as PaymentIntentDto,
  };
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
  stranger = await signup();
  await makeAdmin(admin.userId);
  fixture = await createFixture();
  const created = await createQuotedOrder(2);
  orderId = created.id;
  orderItemId = created.itemId;
  intent = created.intent;
  providerIntentRef = `pi_${crypto.randomUUID().replaceAll('-', '')}`;
});

describe('Stripe Provider Event Inbox', () => {
  test('支付服务 RPC 只允许 service role，绑定时校验金额与币种', async () => {
    const denied = await rpc('create_payment_intent_for_customer', {
      order_id: orderId,
      customer_id: buyer.userId,
      provider: 'stripe',
      idempotency_key: `denied-${crypto.randomUUID()}`,
    }, buyer.token);
    expect(denied.status).toBe(403);
    const duplicateActive = await rpc('create_payment_intent_for_customer', {
      order_id: orderId,
      customer_id: buyer.userId,
      provider: 'stripe',
      idempotency_key: `second-active-${crypto.randomUUID()}`,
    }, undefined, true);
    expect(duplicateActive.status).toBe(400);
    expect((duplicateActive.data as { message: string }).message).toContain('active payment intent');

    const mismatch = await rpc('bind_payment_intent_provider', {
      payment_intent_id: intent.id,
      provider_reference: providerIntentRef,
      provider_status: 'requires_payment_method',
      amount: Number(intent.amount) + 1,
      currency: intent.currency,
    }, undefined, true);
    expect(mismatch.status).toBe(400);
    expect((mismatch.data as { message: string }).message).toContain('amount or currency mismatch');

    const bound = await rpc('bind_payment_intent_provider', {
      payment_intent_id: intent.id,
      provider_reference: providerIntentRef,
      provider_status: 'requires_payment_method',
      amount: intent.amount,
      currency: intent.currency,
    }, undefined, true);
    expect(bound.status).toBe(200);
    expect(bound.data).toMatchObject({
      id: intent.id,
      provider_reference: providerIntentRef,
      status: 'requires_payment_method',
    });
  });

  test('processing / payment_failed 可重试，成功事件原子捕获并消费库存预占', async () => {
    const baseData = {
      amount_minor: minorUnits(intent.amount),
      currency: intent.currency.toLowerCase(),
      metadata: { tera_payment_intent_id: intent.id, tera_order_id: orderId },
    };
    const processing = await providerEvent({
      eventId: `evt_processing_${crypto.randomUUID()}`,
      eventType: 'payment_intent.processing',
      objectReference: providerIntentRef,
      data: { ...baseData, status: 'processing' },
    });
    expect(processing.data).toMatchObject({ status: 'processed', outcome: 'processing' });

    const failed = await providerEvent({
      eventId: `evt_failed_${crypto.randomUUID()}`,
      eventType: 'payment_intent.payment_failed',
      objectReference: providerIntentRef,
      data: {
        ...baseData,
        status: 'requires_payment_method',
        failure_code: 'card_declined',
        failure_message: 'The card was declined.',
      },
    });
    expect(failed.data).toMatchObject({ status: 'processed', outcome: 'requires_payment_method' });
    let current = await operations();
    expect(current.payment_intents[0].status).toBe('requires_payment_method');
    expect(await stockOf(fixture.sku)).toBe(8);

    const eventId = `evt_succeeded_${crypto.randomUUID()}`;
    const data = { ...baseData, status: 'succeeded' };
    const succeeded = await providerEvent({
      eventId,
      eventType: 'payment_intent.succeeded',
      objectReference: providerIntentRef,
      data,
    });
    const replay = await providerEvent({
      eventId,
      eventType: 'payment_intent.succeeded',
      objectReference: providerIntentRef,
      data,
    });
    expect(succeeded.data).toMatchObject({ status: 'processed', outcome: 'captured' });
    expect(replay.data).toMatchObject({ status: 'processed', outcome: 'captured' });

    current = await operations();
    expect(current.payment_intents[0].status).toBe('succeeded');
    expect(current.provider_money_movements).toEqual([
      expect.objectContaining({
        kind: 'capture',
        provider_reference: providerIntentRef,
        reconciliation_status: 'matched',
      }),
    ]);
    expect(await stockOf(fixture.sku)).toBe(6);

    const order = await api(`/rest/v1/orders?id=eq.${orderId}&select=financial_status`, {
      token: buyer.token,
    });
    expect((order.data as Array<{ financial_status: string }>)[0].financial_status).toBe('paid');

    const conflict = await rpc('ingest_payment_provider_event', {
      provider: 'stripe',
      provider_event_id: eventId,
      source: 'webhook',
      event_type: 'payment_intent.succeeded',
      object_reference: providerIntentRef,
      livemode: false,
      occurred_at: new Date(0).toISOString(),
      payload_hash: 'a'.repeat(64),
      data,
    }, undefined, true);
    expect(conflict.status).toBe(400);
    expect((conflict.data as { message: string }).message).toContain('different facts');
  });

  test('外部成功金额不匹配仍记录资金事实并产生 reconciliation，不误标订单已支付', async () => {
    const created = await createQuotedOrder(1);
    const reference = `pi_${crypto.randomUUID().replaceAll('-', '')}`;
    await rpc('bind_payment_intent_provider', {
      payment_intent_id: created.intent.id,
      provider_reference: reference,
      provider_status: 'requires_payment_method',
      amount: created.intent.amount,
      currency: created.intent.currency,
    }, undefined, true);
    const result = await providerEvent({
      eventId: `evt_mismatch_${crypto.randomUUID()}`,
      eventType: 'payment_intent.succeeded',
      objectReference: reference,
      data: {
        amount_minor: String(Number(minorUnits(created.intent.amount)) + 100),
        currency: created.intent.currency.toLowerCase(),
        status: 'succeeded',
        metadata: { tera_payment_intent_id: created.intent.id },
      },
    });
    expect(result.data).toMatchObject({ status: 'processed', outcome: 'action_required' });
    const state = await operations(created.id);
    expect(state.provider_money_movements[0]).toMatchObject({
      reconciliation_status: 'action_required',
      payment_transaction_id: null,
    });
    const order = await api(`/rest/v1/orders?id=eq.${created.id}&select=financial_status`, {
      token: buyer.token,
    });
    expect((order.data as Array<{ financial_status: string }>)[0].financial_status).toBe('pending');
  });

  test('渠道成功晚于 reservation 过期时保留外部资金事实并告警，不伪造库存扣减', async () => {
    const created = await createQuotedOrder(1);
    const reference = `pi_${crypto.randomUUID().replaceAll('-', '')}`;
    await rpc('bind_payment_intent_provider', {
      payment_intent_id: created.intent.id,
      provider_reference: reference,
      provider_status: 'requires_payment_method',
      amount: created.intent.amount,
      currency: created.intent.currency,
    }, undefined, true);
    const stockBefore = await stockOf(fixture.sku);
    const expired = await rpc('expire_checkout_quotes', {
      max_quotes: 100,
      as_of: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }, undefined, true);
    expect(expired.status).toBe(200);

    const result = await providerEvent({
      eventId: `evt_expired_${crypto.randomUUID()}`,
      eventType: 'payment_intent.succeeded',
      objectReference: reference,
      data: {
        amount_minor: minorUnits(created.intent.amount),
        currency: created.intent.currency.toLowerCase(),
        status: 'succeeded',
        metadata: { tera_payment_intent_id: created.intent.id },
      },
    });
    expect(result.data).toMatchObject({ status: 'processed', outcome: 'action_required' });
    const state = await operations(created.id);
    expect(state.provider_money_movements[0]).toMatchObject({
      kind: 'capture', reconciliation_status: 'action_required',
      payment_transaction_id: null, error: null,
    });
    const adminState = await operations(created.id, admin.token);
    expect(adminState.provider_money_movements[0].error).toMatch(/expired|not payable/);
    expect(await stockOf(fixture.sku)).toBe(stockBefore);
  });

  test('Webhook 早于本地 provider bind 时先记 unmatched 资金，绑定后 worker 可安全重试', async () => {
    const created = await createQuotedOrder(1);
    const reference = `pi_${crypto.randomUUID().replaceAll('-', '')}`;
    const early = await providerEvent({
      eventId: `evt_early_${crypto.randomUUID()}`,
      eventType: 'payment_intent.succeeded',
      objectReference: reference,
      data: {
        amount_minor: minorUnits(created.intent.amount),
        currency: created.intent.currency.toLowerCase(),
        status: 'succeeded',
        metadata: {},
      },
    });
    expect(early.data).toMatchObject({ status: 'received', outcome: 'unmatched_payment_intent' });

    const bound = await rpc('bind_payment_intent_provider', {
      payment_intent_id: created.intent.id,
      provider_reference: reference,
      provider_status: 'requires_payment_method',
      amount: created.intent.amount,
      currency: created.intent.currency,
    }, undefined, true);
    expect(bound.status).toBe(200);
    const retried = await rpc('retry_payment_provider_events', { max_events: 10 }, undefined, true);
    expect((retried.data as Array<{ outcome: string }>).some((row) => row.outcome === 'captured')).toBe(true);
    const state = await operations(created.id);
    expect(state.provider_money_movements[0]).toMatchObject({ reconciliation_status: 'matched' });
    const order = await api(`/rest/v1/orders?id=eq.${created.id}&select=financial_status`, {
      token: buyer.token,
    });
    expect((order.data as Array<{ financial_status: string }>)[0].financial_status).toBe('paid');
  });

  test('陌生人看不到支付运维 DTO', async () => {
    const denied = await rpc('get_payment_operations', { order_id: orderId }, stranger.token);
    expect(denied.status).toBe(400);
    expect((denied.data as { message: string }).message).toBe('order not found');
  });
});

describe('Stripe 异步退款状态机', () => {
  test('渠道确认前只预留退款，不改订单、库存或成功资金账本', async () => {
    refundStockBefore = await stockOf(fixture.sku);
    const requested = await rpc('create_refund_request', {
      order_id: orderId,
      actor_id: admin.userId,
      provider: 'stripe',
      idempotency_key: `refund-request-${crypto.randomUUID()}`,
      items: [{ order_item_id: orderItemId, quantity: 1 }],
      reason: '异步退款测试',
      restock: true,
      metadata: { requested_by: 'edge' },
    }, undefined, true);
    expect(requested.status).toBe(200);
    const request = requested.data as RefundRequestDto;
    expect(request.status).toBe('requested');
    expect(request.lines).toEqual([
      expect.objectContaining({ order_item_id: orderItemId, quantity: 1, amount: 10 }),
    ]);
    expect(await stockOf(fixture.sku)).toBe(refundStockBefore);

    const items = await api(
      `/rest/v1/order_items?id=eq.${orderItemId}&select=refunded_quantity,refunded_amount`,
      { token: buyer.token },
    );
    expect(items.data).toEqual([{ refunded_quantity: 0, refunded_amount: 0 }]);

    const blockedManual = await rpc('refund_order', {
      order_id: orderId,
      items: [{ order_item_id: orderItemId, quantity: 1 }],
      reason: '不能穿透 pending request',
      restock: true,
    }, admin.token);
    expect(blockedManual.status).toBe(400);
    expect((blockedManual.data as { message: string }).message).toContain('active asynchronous refund');

    const providerReference = `re_${crypto.randomUUID().replaceAll('-', '')}`;
    const bound = await rpc('bind_refund_request_provider', {
      refund_request_id: request.id,
      provider_reference: providerReference,
      provider_status: 'pending',
      amount: request.amount,
      currency: request.currency,
    }, undefined, true);
    expect(bound.data).toMatchObject({ status: 'processing', provider_reference: providerReference });

    const pending = await providerEvent({
      eventId: `evt_refund_pending_${crypto.randomUUID()}`,
      eventType: 'refund.created',
      objectReference: providerReference,
      data: {
        amount_minor: minorUnits(request.amount),
        currency: request.currency.toLowerCase(),
        status: 'pending',
        metadata: { tera_refund_request_id: request.id },
      },
    });
    expect(pending.data).toMatchObject({ status: 'processed', outcome: 'pending' });
  });

  test('渠道 succeeded 后一次性落退款账本、订单状态与回补库存，重放不重复', async () => {
    let state = await operations();
    const request = state.refund_requests[0];
    const trackingChanged = await api(`/rest/v1/product_variants?id=eq.${fixture.variantId}`, {
      service: true,
      method: 'PATCH',
      body: { track_inventory: false },
    });
    expect(trackingChanged.status).toBe(200);
    const data = {
      amount_minor: minorUnits(request.amount),
      currency: request.currency.toLowerCase(),
      status: 'succeeded',
      metadata: { tera_refund_request_id: request.id },
    };
    const apiResult = await providerEvent({
      eventId: `api:refund:${request.provider_reference}:succeeded`,
      eventType: 'refund.api_result',
      objectReference: request.provider_reference!,
      data,
      source: 'api_response',
    });
    const webhook = await providerEvent({
      eventId: `evt_refund_succeeded_${crypto.randomUUID()}`,
      eventType: 'refund.updated',
      objectReference: request.provider_reference!,
      data,
    });
    expect(apiResult.data).toMatchObject({ status: 'processed', outcome: 'refunded' });
    expect(webhook.data).toMatchObject({ status: 'processed', outcome: 'refunded' });

    state = await operations();
    expect(state.refund_requests[0].status).toBe('succeeded');
    const refundMovements = state.provider_money_movements.filter((row) => row.kind === 'refund');
    expect(refundMovements).toEqual([
      expect.objectContaining({
        kind: 'refund',
        refund_request_id: request.id,
        reconciliation_status: 'matched',
      }),
    ]);
    expect(await stockOf(fixture.sku)).toBe(refundStockBefore + 1);
    const items = await api(
      `/rest/v1/order_items?id=eq.${orderItemId}&select=refunded_quantity,refunded_amount`,
      { token: buyer.token },
    );
    expect(items.data).toEqual([{ refunded_quantity: 1, refunded_amount: 10 }]);
    const order = await api(`/rest/v1/orders?id=eq.${orderId}&select=financial_status`, {
      token: buyer.token,
    });
    expect((order.data as Array<{ financial_status: string }>)[0].financial_status)
      .toBe('partially_refunded');
  });

  test('failed 请求释放数量/金额预留，新的请求可继续；并发活跃请求不能超量', async () => {
    const first = await rpc('create_refund_request', {
      order_id: orderId,
      actor_id: admin.userId,
      provider: 'stripe',
      idempotency_key: `refund-fail-${crypto.randomUUID()}`,
      items: [{ order_item_id: orderItemId, quantity: 1 }],
      reason: '模拟失败',
      restock: false,
    }, undefined, true);
    const failedRequest = first.data as RefundRequestDto;
    const ref = `re_${crypto.randomUUID().replaceAll('-', '')}`;
    await rpc('bind_refund_request_provider', {
      refund_request_id: failedRequest.id,
      provider_reference: ref,
      provider_status: 'pending',
      amount: failedRequest.amount,
      currency: failedRequest.currency,
    }, undefined, true);
    const failed = await providerEvent({
      eventId: `evt_refund_failed_${crypto.randomUUID()}`,
      eventType: 'refund.failed',
      objectReference: ref,
      data: {
        amount_minor: minorUnits(failedRequest.amount),
        currency: failedRequest.currency.toLowerCase(),
        status: 'failed',
        failure_code: 'declined',
        failure_message: 'Refund was declined.',
        metadata: { tera_refund_request_id: failedRequest.id },
      },
    });
    expect(failed.data).toMatchObject({ status: 'processed', outcome: 'failed' });

    const replacement = await rpc('create_refund_request', {
      order_id: orderId,
      actor_id: admin.userId,
      provider: 'stripe',
      idempotency_key: `refund-replacement-${crypto.randomUUID()}`,
      items: [{ order_item_id: orderItemId, quantity: 1 }],
      reason: '失败后重试',
      restock: false,
    }, undefined, true);
    expect(replacement.status).toBe(200);

    const over = await rpc('create_refund_request', {
      order_id: orderId,
      actor_id: admin.userId,
      provider: 'stripe',
      idempotency_key: `refund-over-${crypto.randomUUID()}`,
      items: [{ order_item_id: orderItemId, quantity: 1 }],
      reason: '不能重复预留',
      restock: false,
    }, undefined, true);
    expect(over.status).toBe(400);
    expect((over.data as { message: string }).message).toContain('quantity exceeds');

    const cancelled = await rpc('cancel_refund_request', {
      refund_request_id: (replacement.data as RefundRequestDto).id,
      actor_id: admin.userId,
      provider_confirmed: false,
      reason: '未提交渠道，管理员释放预留',
    }, undefined, true);
    expect(cancelled.data).toMatchObject({ status: 'cancelled' });
    const afterCancel = await rpc('create_refund_request', {
      order_id: orderId,
      actor_id: admin.userId,
      provider: 'stripe',
      idempotency_key: `refund-after-cancel-${crypto.randomUUID()}`,
      items: [{ order_item_id: orderItemId, quantity: 1 }],
      reason: '取消后重新创建',
      restock: false,
    }, undefined, true);
    expect(afterCancel.status).toBe(200);
  });
});
