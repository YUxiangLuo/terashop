import { afterAll, beforeAll, expect, test } from 'bun:test';
import { handlePayPalCreateOrder } from '../supabase/functions/paypal-create-order/handler';
import { handlePayPalCaptureOrder } from '../supabase/functions/paypal-capture-order/handler';
import { handlePayPalCreateRefund } from '../supabase/functions/paypal-create-refund/handler';
import { handlePayPalReconcileRefunds } from '../supabase/functions/paypal-reconcile-refunds/handler';
import { handlePayPalWebhook } from '../supabase/functions/paypal-webhook/handler';
import { api, rpc, signup, makeAdmin, stockOf, SERVICE_KEY, type TestUser } from './helpers';
import { checked, fixtureOrder, fixtureIntent, paymentFixture, paymentEvent, settleIntent, withRefundPolling, type PaymentFixture } from './payment-fixtures';
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
      expect(request.headers.get('PayPal-Request-Id')).toBe(`ord_${unit.custom_id.replaceAll('-', '')}`);
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

test('同一意图创建和 Capture 的渠道键不同，各自响应丢失后重试键保持稳定', async () => {
  const local = await fixtureOrder(fixture, buyer);
  const command = { order_id: local.id, idempotency_key: crypto.randomUUID() };
  const keys: Record<string, string[]> = { order: [], capture: [] };
  let unit: Record<string, unknown>;
  let intentId = '';
  await withPaymentProviderMock(async request => {
    const token = oauth(request); if (token) return token;
    if (request.method === 'POST') {
      const operation = request.url.endsWith('/capture') ? 'capture' : 'order';
      keys[operation].push(request.headers.get('PayPal-Request-Id')!);
      if (operation === 'order') unit = (await request.json()).purchase_units[0];
      if (keys[operation].length === 1) throw new TypeError('ambiguous provider response');
    }
    const captured = keys.capture.length === 2;
    return Response.json({ id: `ORDER${local.id}`, intent: 'CAPTURE', status: captured ? 'COMPLETED' : 'APPROVED',
      purchase_units: [{ ...unit!, ...(captured ? { payments: { captures: [{
        id: `CAPTURE${local.id}`, status: 'COMPLETED', amount: unit!.amount,
        create_time: '2026-09-01T00:00:00Z',
      }] } } : {}) }],
      links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/checkoutnow?token=test' }],
    });
  }, async () => {
    expect((await handlePayPalCreateOrder(paymentRequest(command, buyer.token))).status).toBe(502);
    const created = await handlePayPalCreateOrder(paymentRequest(command, buyer.token));
    expect(created.status).toBe(200);
    intentId = (await created.json()).payment_intent_id;
    for (const status of [502, 200]) {
      expect((await handlePayPalCaptureOrder(paymentRequest({ payment_intent_id: intentId }, buyer.token))).status).toBe(status);
    }
  });
  expect(keys.order).toEqual(Array(2).fill(`ord_${intentId.replaceAll('-', '')}`));
  expect(keys.capture).toEqual(Array(2).fill(`cap_${intentId.replaceAll('-', '')}`));
  expect(new Set([...keys.order, ...keys.capture]).size).toBe(2);
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
  }, null, 2);
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
    expect(await request.text()).toEndWith(`,"webhook_event":${raw}}`);
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

for (const mode of ['bound', 'response-lost', 'external'] as const)
test(`真实 Refund 形态的成功 Webhook：${mode}，资金只记录一次且不凭 metadata 认领`, async () => {
  const order = await fixtureOrder(fixture, buyer);
  const intent = await fixtureIntent(order, buyer);
  await settleIntent(intent);
  const captureId = `CAPTURE${intent.id.replaceAll('-', '')}`;
  const refundId = `REFUND${crypto.randomUUID()}`;
  let requestId: string | null = null;
  if (mode !== 'external') {
    const local = await checked<{ id: string }>(rpc('create_refund_request', {
      order_id: order.id, actor_id: admin.userId, provider: 'paypal',
      idempotency_key: crypto.randomUUID(), items: [{ order_item_id: order.itemId, quantity: 1 }], restock: true,
    }, undefined, true));
    requestId = local.id;
    await checked(rpc('prepare_paypal_refund', { refund_request_id: requestId, actor_id: admin.userId }, undefined, true));
  }
  const bind = () => checked(rpc('bind_refund_request_provider', {
    refund_request_id: requestId, provider_reference: refundId,
    provider_status: 'pending', amount: '10.00', currency: 'USD',
  }, undefined, true));
  if (mode === 'bound') await bind();
  const event = {
    id: `WH-${crypto.randomUUID()}`, event_type: 'PAYMENT.CAPTURE.REFUNDED', resource_type: 'refund',
    create_time: '2026-09-01T00:00:00Z', resource: {
      id: refundId, status: 'COMPLETED', amount: { value: '10.00', currency_code: 'USD' },
      custom_id: requestId ?? crypto.randomUUID(),
      links: [{ rel: 'up', href: `https://api-m.sandbox.paypal.com/v2/payments/captures/${captureId}` }],
    },
  };
  const stock = await stockOf(fixture.sku);
  await withPaymentProviderMock(request => oauth(request) ?? Response.json({ verification_status: 'SUCCESS' }), async () => {
    const deliver = () => handlePayPalWebhook(new Request('https://webhook.test', { method: 'POST',
      headers: {
        'PayPal-Auth-Algo': 'SHA256withRSA', 'PayPal-Cert-Url': 'https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-TEST',
        'PayPal-Transmission-Id': 'TRANSMISSION-TEST', 'PayPal-Transmission-Sig': 'signature',
        'PayPal-Transmission-Time': '2026-09-01T00:00:00Z',
      }, body: JSON.stringify(event),
    }));
    for (let i = 0; i < 2; i++) expect((await deliver()).status).toBe(200);
    const rows = await database`select order_id,kind,amount::text,refund_request_id,reconciliation_status
      from commerce.provider_money_movements where provider='paypal' and provider_reference=${refundId}`;
    expect(rows).toEqual([{ order_id: order.id, kind: 'refund', amount: '10.00000000',
      refund_request_id: mode === 'bound' ? requestId : null,
      reconciliation_status: mode === 'bound' ? 'matched' : 'action_required',
    }]);
    expect(await stockOf(fixture.sku)).toBe(stock + (mode === 'bound' ? 1 : 0));
    if (mode === 'response-lost') {
      expect((await database`select provider_reference from commerce.refund_requests where id=${requestId}::uuid`)[0].provider_reference).toBeNull();
      await bind();
      expect((await deliver()).status).toBe(200);
      expect((await deliver()).status).toBe(200);
      expect(await stockOf(fixture.sku)).toBe(stock + 1);
    }
    const [{ n }] = await database`select count(*)::int n from commerce.payment_transactions
      where order_id=${order.id}::uuid and kind='refund'`;
    expect(n).toBe(mode === 'external' ? 0 : 1);
  });
});

for (const verified of [false, true])
test(`重复手工 Capture 引用不能误关联外部退款：verified=${verified}`, async () => {
  const wrong = await fixtureOrder(fixture, buyer), correct = await fixtureOrder(fixture, buyer);
  const intent = verified ? await fixtureIntent(correct, buyer) : null;
  const capture = `CAPTURE${(intent?.id ?? crypto.randomUUID()).replaceAll('-', '')}`;
  // Insert the misleading ledger entry first, through the supported admin RPC.
  await checked(rpc('mark_order_paid', { order_id: wrong.id, provider: 'paypal', provider_ref: capture }, admin.token));
  if (intent) await settleIntent(intent);
  else await checked(rpc('mark_order_paid', { order_id: correct.id, provider: 'paypal', provider_ref: capture }, admin.token));
  expect(await database`select id from commerce.payment_transactions
    where provider='paypal' and kind='capture' and provider_reference=${capture}`).toHaveLength(2);
  const request = await checked<{ id: string }>(rpc('create_refund_request', { order_id: correct.id,
    actor_id: admin.userId, provider: 'paypal', idempotency_key: crypto.randomUUID(), amount: '1.00',
  }, undefined, true));
  const reference = `REFUND${crypto.randomUUID()}`;
  const deliver = () => paymentEvent('paypal', 'PAYMENT.CAPTURE.REFUNDED', reference,
    { status: 'completed', amount: '1.00', currency: 'USD', capture_reference: capture });
  expect(await deliver()).toMatchObject({ status: 'received', outcome: 'unmatched_refund' });
  const observed = await database`select order_id,reconciliation_status from commerce.provider_money_movements
    where provider='paypal' and kind='refund' and provider_reference=${reference}`;
  expect(observed).toEqual([{ order_id: verified ? correct.id : null, reconciliation_status: 'action_required' }]);
  expect(await checked(rpc('get_order_fulfillment_balance', { order_id: wrong.id }, buyer.token)))
    .toMatchObject({ payment_hold: false });
  // A later trusted Refund binding must still be able to settle on the correct order.
  await checked(rpc('bind_refund_request_provider', { refund_request_id: request.id,
    provider_reference: reference, provider_status: 'pending', amount: '1.00', currency: 'USD',
  }, undefined, true));
  expect(await deliver()).toMatchObject({ status: 'processed', outcome: 'refunded' });
  const settled = await database`select order_id,reconciliation_status from commerce.provider_money_movements
    where provider='paypal' and kind='refund' and provider_reference=${reference}`;
  expect(settled).toEqual([{ order_id: correct.id, reconciliation_status: 'matched' }]);
});

test('退款入账耗尽后轮询不再 GET/重开 Inbox，可信人工重投仍可恢复', async () => {
  const order = await fixtureOrder(fixture, buyer);
  await settleIntent(await fixtureIntent(order, buyer));
  const local = await checked<{ id: string }>(rpc('create_refund_request', { order_id: order.id,
    actor_id: admin.userId, provider: 'paypal', idempotency_key: crypto.randomUUID(), amount: '1.00',
  }, undefined, true));
  const reference = `REFUND${local.id}`;
  await checked(rpc('bind_refund_request_provider', { refund_request_id: local.id, provider_reference: reference,
    provider_status: 'pending', amount: '1.00', currency: 'USD',
  }, undefined, true));
  await database.unsafe(`create function private.test_refund_poll_exhaustion() returns trigger language plpgsql as $$
    begin if new.order_id='${order.id}'::uuid then raise exception 'injected refund conflict' using errcode='55P03'; end if; return new; end $$`);
  try {
    await database.unsafe('create trigger test_refund_poll_exhaustion before insert on commerce.refunds for each row execute function private.test_refund_poll_exhaustion()');
    let gets = 0;
    await withPaymentProviderMock(request => {
      const token = oauth(request); if (token) return token;
      expect(request.method).toBe('GET'); gets++;
      return Response.json({ id: reference, status: 'COMPLETED', amount: { value: '1.00', currency_code: 'USD' }, create_time: '2026-09-01T00:00:00Z' });
    }, async () => {
      await withRefundPolling(database, [local.id], async () => {
        expect((await handlePayPalReconcileRefunds(paymentRequest({}, SERVICE_KEY))).status).toBe(200);
      });
      const [event] = await database`select id from commerce.payment_provider_events where object_reference=${reference}`;
      for (let attempt = 2; attempt <= 25; attempt++) {
        await database`update commerce.payment_provider_events set next_attempt_at=clock_timestamp()-interval '1 second' where id=${event.id}::uuid`;
        await database`select private.process_payment_provider_event(${event.id}::uuid)`;
      }
      await database`update commerce.payment_provider_events set next_attempt_at=clock_timestamp()-interval '1 second' where id=${event.id}::uuid`;
      await database`update commerce.refund_requests set last_provider_poll_at=clock_timestamp()-interval '6 minutes' where id=${local.id}::uuid`;
      await withRefundPolling(database, [local.id], async () => {
        const response = await handlePayPalReconcileRefunds(paymentRequest({}, SERVICE_KEY));
        expect(response.status).toBe(200);
        expect((await response.json()).results).toEqual([]);
      });
      expect(gets).toBe(1);
      expect((await database`select attempts from commerce.payment_provider_events where id=${event.id}::uuid`)[0].attempts).toBe(25);
      await database.unsafe('drop trigger test_refund_poll_exhaustion on commerce.refunds');
      await database.begin(async tx => {
        await tx`select set_config('request.jwt.claims','{"role":"service_role"}',true)`;
        await tx`select public.ingest_payment_provider_event(provider,provider_event_id,source,event_type,object_reference,
          livemode,occurred_at,payload_hash,data) from commerce.payment_provider_events where id=${event.id}::uuid`;
      });
      expect((await database`select status,attempts from commerce.payment_provider_events where id=${event.id}::uuid`)[0])
        .toEqual({ status: 'processed', attempts: 26 });
      expect((await database`select count(*)::int n from commerce.payment_transactions where order_id=${order.id}::uuid and kind='refund'`)[0].n).toBe(1);
    });
  } finally {
    await database.unsafe('drop trigger if exists test_refund_poll_exhaustion on commerce.refunds');
    await database.unsafe('drop function private.test_refund_poll_exhaustion()');
  }
});
