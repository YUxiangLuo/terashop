import { afterAll, beforeAll, expect, test } from 'bun:test';
import { handlePayPalCreateOrder } from '../supabase/functions/paypal-create-order/handler';
import { handlePayPalCreateRefund } from '../supabase/functions/paypal-create-refund/handler';
import { handlePayPalReconcileRefunds } from '../supabase/functions/paypal-reconcile-refunds/handler';
import { handlePayPalWebhook } from '../supabase/functions/paypal-webhook/handler';
import { api, rpc, signup, makeAdmin, stockOf, SERVICE_KEY, type TestUser } from './helpers';
import { checked, fixtureOrder, fixtureIntent, paymentFixture, settleIntent, withRefundPolling, type PaymentFixture } from './payment-fixtures';
import { testDatabase } from './database-concurrency';
import { paymentRequest, withPaymentProviderMock } from './payment-handler-harness';
import type { PayPalRefund } from '../supabase/functions/_shared/paypal';

const database = testDatabase();
let admin: TestUser;
let buyer: TestUser;
let fixture: PaymentFixture;
beforeAll(async () => {
  admin = await signup(); buyer = await signup(); await makeAdmin(admin.userId);
  fixture = await paymentFixture(admin);
});
afterAll(async () => {
  try {
    if (fixture) await checked(api(`/rest/v1/products?id=eq.${fixture.productId}`, {
      service: true, method: 'PATCH', body: { status: 'archived' },
    }));
  } finally { await database.close(); }
});
const oauth = (request: Request) => request.url.endsWith('/v1/oauth2/token')
  ? Response.json({ access_token: 'endpoint-mock-token', expires_in: 3600 }) : null;

const operations = (id: string) => checked<{
  refund_requests: Array<{ id: string; status: string }>;
  provider_money_movements: unknown[];
}>(rpc('get_payment_operations', { order_id: id }, buyer.token));

test('创建 Order 使用数据库金额/地址和配置跳转；重试 GET 不重建，其他客户不能发起渠道请求', async () => {
  const local = await fixtureOrder(fixture, buyer);
  const reference = `ORDER${crypto.randomUUID().replaceAll('-', '')}`;
  const command = { order_id: local.id, idempotency_key: crypto.randomUUID(), amount: '0.01', return_url: 'https://attacker.example' };
  let order: Record<string, unknown>;
  let posts = 0;
  let gets = 0;
  await withPaymentProviderMock(async request => {
    const token = oauth(request); if (token) return token;
    if (request.method === 'POST') {
      posts++;
      const body = await request.json();
      const unit = body.purchase_units[0];
      expect(unit.amount).toEqual({ value: '10.00', currency_code: 'USD' });
      expect(unit.shipping.address.country_code).toBe('US');
      expect(body.payment_source.paypal.experience_context.return_url).toBe('https://shop.example/paypal/return');
      expect(request.headers.get('PayPal-Request-Id')).toBe(unit.custom_id);
      order = { ...body, id: reference, status: 'PAYER_ACTION_REQUIRED', links: [{
        rel: 'payer-action', href: `https://www.sandbox.paypal.com/checkoutnow?token=${reference}`,
      }] };
    } else gets++;
    return Response.json(order!);
  }, async () => {
    expect((await handlePayPalCreateOrder(paymentRequest(command, admin.token))).status).toBeGreaterThanOrEqual(400);
    for (let i = 0; i < 2; i++) {
      const response = await handlePayPalCreateOrder(paymentRequest(command, buyer.token));
      expect({ status: response.status, data: await response.json() }).toMatchObject({
        status: 200, data: { provider_reference: reference, amount: 10, currency: 'USD', status: 'requires_action' },
      });
    }
  });
  expect(posts).toBe(1); expect(gets).toBe(1);
});

test('退款 handler 的 GET 必须匹配已绑定 ID，拒绝错误对象而不污染账本', async () => {
  const order = await fixtureOrder(fixture, buyer);
  await settleIntent(await fixtureIntent(order, buyer));
  const command = { order_id: order.id, idempotency_key: crypto.randomUUID(), amount: '1.00' };
  let refund: PayPalRefund;
  let wrong = true;
  let gets = 0;
  await withPaymentProviderMock(async request => {
    const token = oauth(request); if (token) return token;
    if (request.method === 'POST') {
      const body = await request.json();
      refund = { id: `REFUND${body.custom_id}`, status: 'PENDING', amount: body.amount, create_time: new Date().toISOString() };
      return Response.json(refund);
    }
    gets++;
    return Response.json({ ...refund!, id: wrong ? 'REFUNDWRONG' : refund!.id, status: 'COMPLETED' });
  }, async () => {
    expect((await handlePayPalCreateRefund(paymentRequest(command, admin.token))).status).toBe(200);
    expect((await handlePayPalCreateRefund(paymentRequest(command, admin.token))).status).toBe(409);
    expect((await operations(order.id)).refund_requests[0].status).toBe('processing');
    expect((await operations(order.id)).provider_money_movements).toHaveLength(1);
    wrong = false;
    const response = await handlePayPalCreateRefund(paymentRequest(command, admin.token));
    expect({ status: response.status, data: await response.json() }).toMatchObject({ status: 200, data: { processing_status: 'refunded' } });
  });
  expect(gets).toBe(2);
});

test('退款 Worker 验证 service token；隔离错误 ID，正常 Refund GET 可完成入账', async () => {
  const refunds = new Map<string, { refund: PayPalRefund; wrong: boolean; localId: string; orderId: string }>();
  await withPaymentProviderMock(async request => {
    const token = oauth(request); if (token) return token;
    if (request.method === 'POST') {
      const body = await request.json();
      const id = `REFUND${body.custom_id}`;
      const refund: PayPalRefund = { id, amount: body.amount, status: 'PENDING', create_time: new Date().toISOString() };
      // Order association is filled from the production handler response below.
      refunds.set(id, { refund, wrong: refunds.size === 0, localId: body.custom_id, orderId: '' });
      return Response.json(refund);
    }
    const candidate = refunds.get(new URL(request.url).pathname.split('/').at(-1)!);
    if (!candidate) throw new Error('unrelated pending refund fixture');
    return Response.json({ ...candidate.refund, status: 'COMPLETED', id: candidate.wrong ? 'REFUNDWRONG' : candidate.refund.id });
  }, async () => {
    expect((await handlePayPalReconcileRefunds(paymentRequest({}, buyer.token))).status).toBe(401);
    expect((await handlePayPalReconcileRefunds(paymentRequest({ max_events: 21 }, SERVICE_KEY))).status).toBe(400);
    for (let i = 0; i < 2; i++) {
      const order = await fixtureOrder(fixture, buyer);
      await settleIntent(await fixtureIntent(order, buyer));
      const response = await handlePayPalCreateRefund(paymentRequest({
        order_id: order.id, idempotency_key: crypto.randomUUID(), amount: '1.00',
      }, admin.token));
      expect(response.status).toBe(200);
      const data = await response.json();
      refunds.get(data.provider_reference)!.orderId = order.id;
    }
    const results: Array<{ refund_request_id: string; status: string; outcome: string }> = [];
    await withRefundPolling(database, [...refunds.values()].map(row => row.localId), async () => {
      const response = await handlePayPalReconcileRefunds(paymentRequest({ max_events: 20 }, SERVICE_KEY));
      expect(response.status).toBe(200);
      results.push(...(await response.json()).results);
      expect(results).toHaveLength(2);
    });
    for (const row of refunds.values()) {
      expect(results).toContainEqual(expect.objectContaining({
        refund_request_id: row.localId, status: row.wrong ? 'retry_required' : 'processed',
      }));
      expect((await operations(row.orderId)).refund_requests[0].status).toBe(row.wrong ? 'processing' : 'succeeded');
    }
  });
});

test('完整 Webhook 先 postback 验签再入箱；重放不扣库存，失败签名不调用数据库', async () => {
  const order = await fixtureOrder(fixture, buyer);
  const intent = await fixtureIntent(order, buyer);
  const raw = JSON.stringify({
    id: `WH-${crypto.randomUUID()}`, event_type: 'PAYMENT.CAPTURE.COMPLETED', create_time: new Date().toISOString(),
    resource: {
      id: `CAPTURE${crypto.randomUUID()}`, status: 'COMPLETED', amount: { value: '10.00', currency_code: 'USD' },
      custom_id: intent.id, supplementary_data: { related_ids: { order_id: intent.provider_reference } },
    },
  });
  const headers = {
    'Content-Type': 'application/json', 'PayPal-Auth-Algo': 'SHA256withRSA',
    'PayPal-Cert-Url': 'https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-TEST',
    'PayPal-Transmission-Id': 'TRANSMISSION-TEST', 'PayPal-Transmission-Sig': 'test-signature',
    'PayPal-Transmission-Time': new Date().toISOString(),
  };
  let verified = true;
  let ingests = 0;
  const before = await stockOf(fixture.sku);
  await withPaymentProviderMock(async request => {
    const token = oauth(request); if (token) return token;
    expect(request.url).toEndWith('/v1/notifications/verify-webhook-signature');
    expect((await request.json()).webhook_event).toEqual(JSON.parse(raw));
    return Response.json({ verification_status: verified ? 'SUCCESS' : 'FAILURE' });
  }, async () => {
    for (let i = 0; i < 2; i++) {
      const response = await handlePayPalWebhook(new Request('http://webhook.test', { method: 'POST', headers, body: raw }));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ received: true, processed: true });
    }
    verified = false;
    expect((await handlePayPalWebhook(new Request('http://webhook.test', { method: 'POST', headers, body: raw }))).status).toBe(400);
  }, {}, request => { if (request.url.endsWith('/rpc/ingest_payment_provider_event')) ingests++; });
  expect(ingests).toBe(2);
  expect(await stockOf(fixture.sku)).toBe(before - 1);
});
