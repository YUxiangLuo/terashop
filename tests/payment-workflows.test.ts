import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { handlePayPalCreateRefund } from '../supabase/functions/paypal-create-refund/handler.ts';
import { handlePayPalCaptureOrder } from '../supabase/functions/paypal-capture-order/handler.ts';
import { type PayPalRefund } from '../supabase/functions/_shared/paypal.ts';
import { api, rpc, signup, makeAdmin, stockOf, TEST_ADDRESS, type TestUser } from './helpers';
import {
  checked, paymentFixture, fixtureOrder, fixtureIntent, paymentEvent, settleIntent,
  type PaymentFixture, type FixtureIntent,
} from './payment-fixtures';
import { paymentRequest, withPaymentProviderMock } from './payment-handler-harness';

let admin: TestUser;
let buyer: TestUser;
let fixture: PaymentFixture;

beforeAll(async () => {
  admin = await signup();
  buyer = await signup();
  await makeAdmin(admin.userId);
  fixture = await paymentFixture(admin);
});
afterAll(async () => {
  if (fixture) await api(`/rest/v1/products?id=eq.${fixture.productId}`, {
    service: true, method: 'PATCH', body: { status: 'archived' },
  });
});

interface Operations {
  payment_intents: Array<{ id: string; status: string }>;
  refund_requests: Array<{ id: string; status: string; provider_reference: string | null }>;
  provider_money_movements: Array<{ kind: string; reconciliation_status: string }>;
}
function operations(orderId: string): Promise<Operations> {
  return checked(rpc('get_payment_operations', { order_id: orderId }, buyer.token));
}

function refundFixture(body: Record<string, any>, status: string): PayPalRefund {
  return {
    id: `REFUND${crypto.randomUUID().replaceAll('-', '')}`,
    amount: body.amount,
    status,
    create_time: new Date().toISOString(),
    invoice_id: body.invoice_id,
    // custom_id is optional in the official Payments v2 Refund schema.
  };
}

function approvedPayPalOrder(intent: FixtureIntent) {
  return {
    id: intent.provider_reference,
    intent: 'CAPTURE', status: 'APPROVED',
    purchase_units: [{
      reference_id: intent.order_id, custom_id: intent.id,
      amount: { value: intent.amount.toFixed(2), currency_code: intent.currency },
    }],
  };
}
function capturedPayPalOrder(intent: FixtureIntent) {
  const order = approvedPayPalOrder(intent);
  const unit = order.purchase_units[0];
  return {
    ...order, status: 'COMPLETED',
    purchase_units: [{ ...unit, payments: { captures: [{
      id: `CAPTURE${intent.id.replaceAll('-', '')}`, status: 'COMPLETED',
      amount: unit.amount, custom_id: intent.id, final_capture: true,
      create_time: new Date().toISOString(),
    }] } }],
  };
}

function oauthResponse(request: Request): Response | null {
  return new URL(request.url).pathname === '/v1/oauth2/token'
    ? Response.json({ access_token: 'workflow-mock-token', expires_in: 3600 }) : null;
}

describe('PayPal refund handler contracts', () => {
  test('官方未返回 custom_id 的 Refund 响应可落账；重试同一命令不重复退款或回库', async () => {
    const order = await fixtureOrder(fixture, buyer, 2);
    const intent = await fixtureIntent(order, buyer);
    await settleIntent(intent);
    const before = await stockOf(fixture.sku);
    const command = {
      order_id: order.id, idempotency_key: crypto.randomUUID(),
      items: [{ order_item_id: order.itemId, quantity: 1 }], restock: true,
    };
    let refund: PayPalRefund;
    let posts = 0;
    let gets = 0;
    const modes: boolean[] = [];
    await withPaymentProviderMock(async request => {
      const oauth = oauthResponse(request);
      if (oauth) return oauth;
      expect(new URL(request.url).hostname).toBe('api-m.sandbox.paypal.com');
      if (request.method === 'POST') {
        posts += 1;
        const body = await request.json();
        refund = refundFixture(body, 'COMPLETED');
        expect(request.headers.get('PayPal-Request-Id')).toBe(body.custom_id);
        expect(Object.hasOwn(refund, 'custom_id')).toBe(false);
      } else gets += 1;
      return Response.json(refund!);
    }, async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await handlePayPalCreateRefund(paymentRequest(command, admin.token));
        const data = await response.json();
        expect({ status: response.status, data }).toMatchObject({
          status: 200, data: { processing_status: 'refunded', pending_reconciliation: false },
        });
      }
    }, {}, async request => {
      if (request.url.endsWith('/rpc/ingest_payment_provider_event')) {
        modes.push((await request.json()).livemode);
      }
    });
    expect(modes).toEqual([false, false]);
    expect(posts).toBe(1);
    expect(gets).toBe(1);
    expect(await stockOf(fixture.sku)).toBe(before + 1);
    const state = await operations(order.id);
    expect(state.refund_requests).toEqual([expect.objectContaining({ status: 'succeeded' })]);
    expect(state.provider_money_movements.filter(row => row.kind === 'refund'))
      .toEqual([expect.objectContaining({ reconciliation_status: 'matched' })]);
  });

  for (const [initial, terminal] of [
    ['PENDING', 'COMPLETED'], ['PENDING', 'FAILED'], ['PENDING', 'CANCELLED'],
  ]) {
    test(`${initial} 退款重试观察到 ${terminal}，不回退 submitted 且可处理终态`, async () => {
      const order = await fixtureOrder(fixture, buyer);
      const intent = await fixtureIntent(order, buyer);
      await settleIntent(intent);
      const command = { order_id: order.id, idempotency_key: crypto.randomUUID(), amount: '1.00' };
      let refund: PayPalRefund;
      await withPaymentProviderMock(async request => {
        const oauth = oauthResponse(request);
        if (oauth) return oauth;
        if (request.method === 'POST') {
          refund = refundFixture(await request.json(), initial);
        } else refund = { ...refund!, status: terminal };
        return Response.json(refund);
      }, async () => {
        const pending = await handlePayPalCreateRefund(paymentRequest(command, admin.token));
        expect(pending.status).toBe(200);
        expect((await operations(order.id)).refund_requests[0].status)
          .toBe('processing');
        const complete = await handlePayPalCreateRefund(paymentRequest(command, admin.token));
        expect({ status: complete.status, data: await complete.json() }).toMatchObject({
          status: 200, data: { processing_status: terminal === 'COMPLETED' ? 'refunded' : terminal.toLowerCase() },
        });
      });
      expect((await operations(order.id)).refund_requests[0].status).toBe(terminal === 'COMPLETED' ? 'succeeded' : terminal.toLowerCase());
    });
  }

  test('API 入箱的 live 模式来自已校验的配置，而不是 Refund 上的假字段', async () => {
    const order = await fixtureOrder(fixture, buyer);
    await settleIntent(await fixtureIntent(order, buyer));
    const modes: boolean[] = [];
    await withPaymentProviderMock(async request => {
      expect(new URL(request.url).hostname).toBe('api-m.paypal.com');
      const oauth = oauthResponse(request);
      if (oauth) return oauth;
      return Response.json(refundFixture(await request.json(), 'COMPLETED'));
    }, async () => {
      const response = await handlePayPalCreateRefund(paymentRequest({
        order_id: order.id, idempotency_key: crypto.randomUUID(), amount: '1.00',
      }, admin.token));
      expect(response.status).toBe(200);
    }, { PAYPAL_LIVEMODE: 'true' }, async request => {
      if (request.url.endsWith('/rpc/ingest_payment_provider_event')) modes.push((await request.json()).livemode);
    });
    expect(modes).toEqual([true]);
  });

  test('普通客户不能通过完整退款 handler 触发渠道请求', async () => {
    const order = await fixtureOrder(fixture, buyer);
    await settleIntent(await fixtureIntent(order, buyer));
    let calls = 0;
    await withPaymentProviderMock(() => { calls += 1; throw new Error('unexpected provider request'); }, async () => {
      const response = await handlePayPalCreateRefund(paymentRequest({
        order_id: order.id, idempotency_key: crypto.randomUUID(), amount: '1.00',
      }, buyer.token));
      expect(response.status).toBeGreaterThanOrEqual(400);
    });
    expect(calls).toBe(0);
  });
});

describe('PayPal capture dispatch and cancellation', () => {
  for (const cancelDuringGet of [false, true]) {
    test(`订单${cancelDuringGet ? '在渠道 GET 期间取消' : '已取消'}时，不发送 Capture POST`, async () => {
      const order = await fixtureOrder(fixture, buyer);
      const intent = await fixtureIntent(order, buyer, 'paypal');
      if (!cancelDuringGet) await checked(rpc('cancel_order', { order_id: order.id }, buyer.token));
      let captures = 0;
      await withPaymentProviderMock(async request => {
        const oauth = oauthResponse(request);
        if (oauth) return oauth;
        if (request.method === 'POST') { captures += 1; return Response.json(capturedPayPalOrder(intent)); }
        if (cancelDuringGet) await checked(rpc('cancel_order', { order_id: order.id }, buyer.token));
        return Response.json(approvedPayPalOrder(intent));
      }, async () => {
        const response = await handlePayPalCaptureOrder(paymentRequest({ payment_intent_id: intent.id }, buyer.token));
        expect(response.status).toBeGreaterThanOrEqual(400);
      });
      expect(captures).toBe(0);
      expect((await operations(order.id)).provider_money_movements).toEqual([]);
    });
  }

  test('捕获已登记后取消被阻止，渠道成功后正常消费库存且重试不重复扣款', async () => {
    const order = await fixtureOrder(fixture, buyer);
    const intent = await fixtureIntent(order, buyer, 'paypal');
    const before = await stockOf(fixture.sku);
    const captured = capturedPayPalOrder(intent);
    let captures = 0;
    await withPaymentProviderMock(async request => {
      const oauth = oauthResponse(request);
      if (oauth) return oauth;
      if (request.method === 'POST') {
        captures += 1;
        expect(request.headers.get('PayPal-Request-Id')).toBe(intent.id);
        const cancel = await rpc('cancel_order', { order_id: order.id }, buyer.token);
        expect(cancel.status).toBe(400);
        expect(cancel.data).toMatchObject({ message: expect.stringContaining('capture is in progress') });
        const cancelQuote = await rpc('cancel_checkout_quote', { quote_id: order.quoteId }, buyer.token);
        expect(cancelQuote.status).toBe(400);
        return Response.json(captured);
      }
      return Response.json(captures ? captured : approvedPayPalOrder(intent));
    }, async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await handlePayPalCaptureOrder(paymentRequest({ payment_intent_id: intent.id }, buyer.token));
        expect({ status: response.status, data: await response.json() }).toMatchObject({
          status: 200, data: { processing_status: 'captured' },
        });
      }
    });
    expect(captures).toBe(1);
    expect(await stockOf(fixture.sku)).toBe(before - 1);
  });

  test('捕获网络结果不明时不释放取消保护，重试继续使用相同幂等键', async () => {
    const order = await fixtureOrder(fixture, buyer);
    const intent = await fixtureIntent(order, buyer, 'paypal');
    const keys: Array<string | null> = [];
    await withPaymentProviderMock(request => {
      const oauth = oauthResponse(request);
      if (oauth) return oauth;
      if (request.method === 'GET') return Response.json(approvedPayPalOrder(intent));
      keys.push(request.headers.get('PayPal-Request-Id'));
      if (keys.length === 1) throw new TypeError('simulated network failure');
      return Response.json(capturedPayPalOrder(intent));
    }, async () => {
      const first = await handlePayPalCaptureOrder(paymentRequest({ payment_intent_id: intent.id }, buyer.token));
      expect(first.status).toBe(502);
      const cancel = await rpc('cancel_order', { order_id: order.id }, buyer.token);
      expect(cancel.status).toBe(400);
      const retry = await handlePayPalCaptureOrder(paymentRequest({ payment_intent_id: intent.id }, buyer.token));
      expect({ status: retry.status, data: await retry.json() }).toMatchObject({
        status: 200, data: { processing_status: 'captured' },
      });
    });
    expect(keys).toEqual([intent.id, intent.id]);
  });

  test('prepare RPC 限制 service role 和订单归属，并串行化与取消的竞争', async () => {
    const order = await fixtureOrder(fixture, buyer);
    const intent = await fixtureIntent(order, buyer, 'paypal');
    const body = { payment_intent_id: intent.id, actor_id: buyer.userId };
    expect((await rpc('prepare_paypal_capture', body, buyer.token)).status).toBe(403);
    expect((await rpc('prepare_paypal_capture', { ...body, actor_id: admin.userId }, undefined, true)).status).toBe(400);
    expect((await rpc('prepare_paypal_capture', { ...body, actor_id: null }, undefined, true)).status).toBe(400);
    const [prepared, cancelled] = await Promise.all([
      rpc('prepare_paypal_capture', body, undefined, true),
      rpc('cancel_order', { order_id: order.id }, buyer.token),
    ]);
    expect([prepared.status, cancelled.status].filter(status => status === 200)).toHaveLength(1);
    if (prepared.status === 200) await settleIntent(intent);
  });

  test('订单快照始终不可变，捕获登记后保护取消；结算消费预占且不重复扣库存', async () => {
    const order = await fixtureOrder(fixture, buyer, 1, false);
    const intent = await fixtureIntent(order, buyer, 'paypal');
    const before = await stockOf(fixture.sku);
    const command = { payment_intent_id: intent.id, actor_id: buyer.userId };
    const beforeCapture = await rpc('update_order_address', {
      order_id: order.id, address: { ...TEST_ADDRESS, country: 'CA' },
    }, buyer.token);
    expect(beforeCapture.status).toBe(400);
    expect(beforeCapture.data).toMatchObject({ message: expect.stringContaining('payment intent') });
    await checked(rpc('prepare_paypal_capture', command, undefined, true));
    const change = await rpc('update_order_address', { order_id: order.id, address: { ...TEST_ADDRESS, country: 'CA' } }, buyer.token);
    expect(change.status).toBe(400);
    expect((await rpc('cancel_order', { order_id: order.id }, buyer.token)).status).toBe(400);
    await settleIntent(intent);
    expect(await stockOf(fixture.sku)).toBe(before - 1);
    const events = await checked<Array<{ type: string }>>(api(`/rest/v1/order_events?order_id=eq.${order.id}&type=eq.inventory_reservation_consumed&select=type`, { token: buyer.token }));
    expect(events).toEqual([{ type: 'inventory_reservation_consumed' }]);
  });

  test('捕获请求不会无限延长 Quote；过期后拒绝新 POST，但已发生资金仍被记录', async () => {
    const order = await fixtureOrder(fixture, buyer);
    const intent = await fixtureIntent(order, buyer, 'paypal');
    await checked(rpc('prepare_paypal_capture', { payment_intent_id: intent.id, actor_id: buyer.userId }, undefined, true));
    await checked(rpc('expire_checkout_quotes', { max_quotes: 500, as_of: '2100-01-01T00:00:00Z' }, undefined, true));
    const prepared = await rpc('prepare_paypal_capture', { payment_intent_id: intent.id, actor_id: buyer.userId }, undefined, true);
    expect(prepared.status).toBe(400);
    await withPaymentProviderMock(request => oauthResponse(request) ?? Response.json(capturedPayPalOrder(intent)), async () => {
      const response = await handlePayPalCaptureOrder(paymentRequest({ payment_intent_id: intent.id }, buyer.token));
      expect({ status: response.status, data: await response.json() }).toMatchObject({
        status: 200, data: { processing_status: 'action_required' },
      });
    });
    expect((await operations(order.id)).provider_money_movements).toEqual([
      expect.objectContaining({ kind: 'capture', reconciliation_status: 'action_required' }),
    ]);
  });
});

describe('Manual payment with PayPal intents', () => {
  for (const [provider, bound] of [
    ['paypal', false], ['paypal', true],
  ] as const) {
    test(`${provider} ${bound ? '已绑定' : '未绑定'}意图未终结时，手工支付不得先取消本地意图再记收款`, async () => {
      const order = await fixtureOrder(fixture, buyer);
      const intent = bound ? await fixtureIntent(order, buyer, provider)
        : await checked<{ status: string }>(rpc('create_payment_intent_for_customer', {
            order_id: order.id, actor_id: buyer.userId, provider, idempotency_key: crypto.randomUUID(),
          }, undefined, true));
      const before = await stockOf(fixture.sku);
      const paid = await rpc('mark_order_paid', { order_id: order.id }, admin.token);
      expect(paid.status).toBe(400);
      expect(paid.data).toMatchObject({ message: expect.stringContaining('online payment intent') });
      expect((await operations(order.id)).payment_intents[0].status).toBe(intent.status);
      expect(await stockOf(fixture.sku)).toBe(before);
      await checked(rpc('cancel_order', { order_id: order.id }, buyer.token));
    });
  }

  test('PayPal Capture declined 终结意图后允许手工支付', async () => {
    const order = await fixtureOrder(fixture, buyer);
    const intent = await fixtureIntent(order, buyer);
    expect(await paymentEvent('paypal', 'PAYMENT.CAPTURE.DECLINED', `CAPTURE${intent.id}`, {
      status: 'declined', amount: intent.amount.toFixed(2), currency: intent.currency,
      order_reference: intent.provider_reference,
    })).toMatchObject({ outcome: 'failed' });
    expect((await rpc('mark_order_paid', { order_id: order.id }, admin.token)).status).toBe(200);
  });
});
