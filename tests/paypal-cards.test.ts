import { afterAll, beforeAll, expect, test } from 'bun:test';
import { handlePayPalClientToken } from '../supabase/functions/paypal-client-token/handler';
import { handlePayPalCreateOrder } from '../supabase/functions/paypal-create-order/handler';
import { handlePayPalCaptureOrder } from '../supabase/functions/paypal-capture-order/handler';
import { validatePayPalCardForCapture, type PayPalOrder } from '../supabase/functions/_shared/paypal';
import { api, rpc, signup, makeAdmin, type TestUser } from './helpers';
import { checked, fixtureIntent, fixtureOrder, paymentFixture, type PaymentFixture } from './payment-fixtures';
import { paymentRequest, withPaymentProviderMock } from './payment-handler-harness';
import { testDatabase } from './database-concurrency';

const database = testDatabase();
const enabled = { PAYPAL_CARDS_ENABLED: 'true', PAYPAL_STOREFRONT_DOMAIN: 'shop.example' };
let fixture: PaymentFixture;
let buyer: TestUser;
beforeAll(async () => {
  const admin = await signup(); await makeAdmin(admin.userId);
  fixture = await paymentFixture(admin); buyer = await signup();
});
afterAll(async () => {
  try {
    if (fixture) await checked(api(`/rest/v1/products?id=eq.${fixture.productId}`, {
      service: true, method: 'PATCH', body: { status: 'archived' },
    }));
  } finally { await database.close(); }
});
const unexpected = (request: Request): Response => { throw new Error(`Unexpected ${request.method} ${request.url}`); };
const oauth = (request: Request) => request.url.endsWith('/v1/oauth2/token')
  ? Response.json({ access_token: 'server-only-token', expires_in: 3600 }) : null;

test('SDK token authenticates, defaults off, rejects origins, and never exposes server OAuth', async () => {
  await withPaymentProviderMock(unexpected, async () => {
    expect((await handlePayPalClientToken(paymentRequest({}, 'invalid'))).status).toBe(401);
    expect((await handlePayPalClientToken(paymentRequest({}, buyer.token))).status).toBe(409);
    const denied = paymentRequest({}, buyer.token); denied.headers.set('Origin', 'https://evil.example');
    expect((await handlePayPalClientToken(denied)).status).toBe(403);
  });
  let calls = 0;
  await withPaymentProviderMock(async request => {
    calls++;
    expect(new URL(request.url).pathname).toBe('/v1/oauth2/token');
    expect(request.headers.get('Authorization')).toMatch(/^Basic /);
    expect(Object.fromEntries(new URLSearchParams(await request.text()))).toEqual({
      grant_type: 'client_credentials', response_type: 'client_token', intent: 'sdk_init',
      'domains[]': 'shop.example',
    });
    return Response.json({ access_token: 'browser-only-token', expires_in: 300, secret: 'do-not-forward' });
  }, async () => {
    const response = await handlePayPalClientToken(paymentRequest({ domain: 'evil.example' }, buyer.token));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ client_token: 'browser-only-token', expires_in: 300 });
  }, enabled);
  expect(calls).toBe(1);
});

test('SDK token provider failure is sanitized and invalid deployment domain never reaches PayPal', async () => {
  await withPaymentProviderMock(() => Response.json({ access_token: 'secret', expires_in: 0 }), async () => {
    const response = await handlePayPalClientToken(paymentRequest({}, buyer.token));
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('secret');
  }, enabled);
  await withPaymentProviderMock(unexpected, async () => {
    expect((await handlePayPalClientToken(paymentRequest({}, buyer.token))).status).toBe(500);
  }, { ...enabled, PAYPAL_STOREFRONT_DOMAIN: 'https://evil.example/path' });
});

test('card create uses DB money and SCA policy, works without approve URL, and replays the bound Order', async () => {
  const order = await fixtureOrder(fixture, buyer);
  const input = { order_id: order.id, idempotency_key: crypto.randomUUID(), payment_method: 'card', amount: '0.01' };
  await withPaymentProviderMock(unexpected, async () => {
    expect((await handlePayPalCreateOrder(paymentRequest(input, buyer.token))).status).toBe(409);
  });
  let stored: PayPalOrder;
  let posts = 0;
  await withPaymentProviderMock(async request => {
    if (request.url.endsWith('/v1/oauth2/token')) {
      const params = new URLSearchParams(await request.text());
      return Response.json({ access_token: params.has('response_type') ? 'browser-only-token' : 'server-only-token', expires_in: 300 });
    }
    expect(request.headers.get('Authorization')).toBe('Bearer server-only-token');
    if (request.method === 'POST') {
      posts++;
      const body = await request.json();
      expect(body.purchase_units[0].amount).toEqual({ currency_code: 'USD', value: '10.00' });
      expect(body.payment_source).toEqual({ card: {
        attributes: { verification: { method: 'SCA_WHEN_REQUIRED' } },
        experience_context: { return_url: 'https://shop.example/paypal/return', cancel_url: 'https://shop.example/paypal/cancel' },
      } });
      expect(request.headers.get('PayPal-Request-Id')).toBe(body.purchase_units[0].custom_id);
      stored = { ...body, id: `CARD${order.id.replaceAll('-', '')}`, status: 'CREATED' };
    }
    return Response.json(stored!);
  }, async () => {
    expect((await handlePayPalClientToken(paymentRequest({}, buyer.token))).status).toBe(200);
    const response = await handlePayPalCreateOrder(paymentRequest(input, buyer.token));
    expect(response.status).toBe(200);
    const first = await response.json();
    expect(first.payment_method).toBe('card'); expect(first.approve_url).toBeNull();
    const replay = await handlePayPalCreateOrder(paymentRequest(input, buyer.token));
    expect(replay.status).toBe(200);
    expect((await replay.json()).payment_intent_id).toBe(first.payment_intent_id);
    for (const idempotency_key of [input.idempotency_key, crypto.randomUUID()]) {
      const mismatch = await handlePayPalCreateOrder(paymentRequest({ ...input, idempotency_key, payment_method: 'paypal' }, buyer.token));
      expect(mismatch.status).toBe(400);
      expect((await mismatch.json()).error.message).toMatch(/idempotency key|active payment intent/);
    }
    await expect(Promise.resolve(database`update commerce.payment_intents set payment_method='paypal' where id=${first.payment_intent_id}::uuid`)).rejects.toThrow('immutable');
  }, enabled);
  expect(posts).toBe(1);
});

test('card authentication policy distinguishes optional SCA, explicit failure, and wrong source', () => {
  const order = { id: 'TEST', intent: 'CAPTURE', status: 'APPROVED', purchase_units: [] };
  for (const authentication_result of [undefined, { liability_shift: 'YES' }, {
    liability_shift: 'POSSIBLE', three_d_secure: { authentication_status: 'Y' },
  }, { liability_shift: 'POSSIBLE', three_d_secure: { authentication_status: 'A' } }]) {
    expect(() => validatePayPalCardForCapture({ ...order, payment_source: { card: { authentication_result } } })).not.toThrow();
  }
  for (const authentication_result of [null, {}, { liability_shift: 'NO' }, { liability_shift: 'UNKNOWN' },
    { liability_shift: 'YES', three_d_secure: null },
    ...['N', 'U', 'R', 'C', 'D', 'unknown'].map(authentication_status => ({
      liability_shift: 'YES', three_d_secure: { authentication_status },
    }))]) {
    expect(() => validatePayPalCardForCapture({ ...order, payment_source: { card: { authentication_result } } })).toThrow('authentication');
  }
  for (const payment_source of [undefined, {}, { paypal: {} }, { card: {}, paypal: {} }]) {
    expect(() => validatePayPalCardForCapture({ ...order, payment_source })).toThrow('source');
  }
  expect(() => validatePayPalCardForCapture({ ...order, status: 'PAYER_ACTION_REQUIRED', payment_source: { card: {} } })).toThrow('approved');
});

test('wallet intent cannot bypass card gating, and another customer cannot inspect or capture it', async () => {
  const order = await fixtureOrder(fixture, buyer);
  const intent = await fixtureIntent(order, buyer);
  const stranger = await signup();
  await withPaymentProviderMock(unexpected, async () => {
    expect((await handlePayPalCaptureOrder(paymentRequest({ payment_intent_id: intent.id }, stranger.token))).status).toBe(400);
    expect((await handlePayPalCreateOrder(paymentRequest({ order_id: order.id, idempotency_key: crypto.randomUUID(), payment_method: 'card' }, stranger.token))).status).toBe(400);
  }, enabled);
  let reads = 0;
  await withPaymentProviderMock(request => {
    const token = oauth(request); if (token) return token;
    expect(request.method).toBe('GET'); reads++;
    return Response.json({ id: intent.provider_reference, intent: 'CAPTURE', status: 'APPROVED',
      payment_source: { card: {} }, purchase_units: [{ reference_id: order.id, custom_id: intent.id,
        amount: { value: '10.00', currency_code: 'USD' } }],
    });
  }, async () => {
    const response = await handlePayPalCaptureOrder(paymentRequest({ payment_intent_id: intent.id, payment_method: 'card' }, buyer.token));
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('provider_mismatch');
  });
  expect(reads).toBe(1);
});

test('server checks card before capture marker, ignores browser claims, and reconciles existing money even after disable', async () => {
  const order = await fixtureOrder(fixture, buyer);
  const intent = await checked<{ id: string }>(rpc('create_payment_intent_for_customer', {
    order_id: order.id, actor_id: buyer.userId, provider: 'paypal', payment_method: 'card', idempotency_key: crypto.randomUUID(),
  }, undefined, true));
  const reference = `CARD${intent.id.replaceAll('-', '')}`;
  await checked(rpc('bind_payment_intent_provider', {
    payment_intent_id: intent.id, provider_reference: reference,
    provider_status: 'requires_action', amount: 10, currency: 'USD',
  }, undefined, true));
  const unit = { reference_id: order.id, custom_id: intent.id, amount: { value: '10.00', currency_code: 'USD' } };
  let payment_source: unknown = { card: { authentication_result: { liability_shift: 'NO' } } };
  let captured = false; let posts = 0;
  const mock = (request: Request) => {
    const token = oauth(request); if (token) return token;
    if (request.method === 'POST') {
      posts++; captured = true;
      expect(request.headers.get('PayPal-Request-Id')).toBe(intent.id);
    }
    return Response.json({ id: reference, intent: 'CAPTURE', status: captured ? 'COMPLETED' : 'APPROVED', payment_source,
      purchase_units: [{ ...unit, ...(captured ? { payments: { captures: [{ id: `CAP${intent.id.replaceAll('-', '')}`,
        status: 'COMPLETED', amount: unit.amount, create_time: '2026-09-01T00:00:00Z' }] } } : {}) }],
    });
  };
  const capture = () => handlePayPalCaptureOrder(paymentRequest({ payment_intent_id: intent.id, liabilityShift: 'YES' }, buyer.token));
  await withPaymentProviderMock(mock, async () => { expect((await capture()).status).toBe(409); });
  await withPaymentProviderMock(mock, async () => {
    expect((await capture()).status).toBe(409);
    const [row] = await database`select provider_capture_requested_at from commerce.payment_intents where id=${intent.id}::uuid`;
    expect(row.provider_capture_requested_at).toBeNull();
    expect(posts).toBe(0);
    payment_source = { paypal: {} };
    expect((await capture()).status).toBe(409);
    payment_source = { card: {} };
    expect((await capture()).status).toBe(200);
  }, enabled);
  // An already observed capture is evidence, not a new command: even bad 3DS
  // and an emergency feature disable cannot prevent idempotent local ingestion.
  payment_source = { card: { authentication_result: { liability_shift: 'NO' } } };
  await withPaymentProviderMock(mock, async () => { expect((await capture()).status).toBe(200); });
  expect(posts).toBe(1);
  const [row] = await checked<Array<{ financial_status: string }>>(api(`/rest/v1/orders?id=eq.${order.id}&select=financial_status`, { token: buyer.token }));
  expect(row.financial_status).toBe('paid');
});
