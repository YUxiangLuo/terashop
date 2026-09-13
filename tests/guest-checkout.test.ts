import { afterAll, beforeAll, expect, test } from 'bun:test';
import { api, rpc, checked, signup, makeAdmin, stockOf, TEST_ADDRESS, type TestUser } from './helpers';
import { paymentFixture, type PaymentFixture } from './payment-fixtures';
import { paymentRequest, withPaymentProviderMock } from './payment-handler-harness';
import { handlePayPalCreateOrder } from '../supabase/functions/paypal-create-order/handler';
import { handlePayPalCaptureOrder } from '../supabase/functions/paypal-capture-order/handler';
import type { PayPalOrder } from '../supabase/functions/_shared/paypal';

let admin: TestUser, fixture: PaymentFixture;
beforeAll(async () => { admin = await signup(); await makeAdmin(admin.userId); fixture = await paymentFixture(admin); });
afterAll(async () => {
  if (fixture) await checked(api(`/rest/v1/products?id=eq.${fixture.productId}`, {
    service: true, method: 'PATCH', body: { status: 'archived' },
  }));
});
async function guest() {
  const session = await checked<{ access_token: string; user: { id: string; is_anonymous: boolean } }>(
    api('/auth/v1/signup', { method: 'POST', body: {} }));
  expect(session.user.is_anonymous).toBe(true);
  const customerId = await checked<string>(rpc('current_customer_id', {}, session.access_token));
  expect(customerId).not.toBe(session.user.id);
  return { token: session.access_token, userId: session.user.id, customerId };
}
const contact = (owner: { token: string; customerId: string }, email: string | null) => checked(api(
  `/rest/v1/customers?id=eq.${owner.customerId}`, { token: owner.token, method: 'PATCH', body: { email } }));
const input = () => ({ items: [{ variant_id: fixture.variantId, quantity: 2 }], address: TEST_ADDRESS });

test('真实匿名 Auth 会话认领 Cart、报价、支付及重试；同邮箱账户与其他游客不能读单或捕获', async () => {
  const owner = await guest(), stranger = await guest(), registered = await signup();
  await contact(owner, registered.email);
  const cart = await checked<{ id: string; guest_token: string }>(rpc('create_cart', {}));
  await checked(rpc('update_cart', { cart_id: cart.id, guest_token: cart.guest_token, expected_version: 1, ...input() }));
  await checked(rpc('claim_cart', { cart_id: cart.id, guest_token: cart.guest_token, expected_version: 2 }, owner.token));
  expect((await rpc('get_cart', { cart_id: cart.id, guest_token: cart.guest_token })).status).toBeGreaterThanOrEqual(400);
  const before = await stockOf(fixture.sku);
  const quote = await checked<{ id: string }>(rpc('checkout_cart', { cart_id: cart.id, expected_version: 3 }, owner.token));
  const order = await checked<{ id: string; email: string; total: number }>(rpc('create_order_from_quote', { quote_id: quote.id }, owner.token));
  expect(order).toMatchObject({ email: registered.email, total: 20 });
  expect(await stockOf(fixture.sku)).toBe(before);
  expect(await checked(rpc('get_admin_customer', { customer_id: owner.customerId }, admin.token))).toMatchObject({ has_account: false });
  for (const other of [stranger, registered]) {
    expect(await checked(rpc('get_customer_order', { order_id: order.id }, other.token))).toBeNull();
    expect(await checked<unknown[]>(api(`/rest/v1/orders?id=eq.${order.id}&select=id`, { token: other.token }))).toEqual([]);
    expect((await rpc('create_order_from_quote', { quote_id: quote.id }, other.token)).status).toBeGreaterThanOrEqual(400);
    expect((await rpc('get_admin_customer', { customer_id: owner.customerId }, other.token)).status).toBe(403);
  }
  const reference = `ORDER${crypto.randomUUID().replaceAll('-', '')}`;
  let providerOrder: PayPalOrder;
  let creates = 0, captures = 0;
  await withPaymentProviderMock(async request => {
    if (request.url.endsWith('/v1/oauth2/token')) return Response.json({ access_token: 'guest-test', expires_in: 3600 });
    if (request.method === 'POST' && request.url.endsWith('/v2/checkout/orders')) {
      creates++;
      const body = await request.json();
      expect(body.purchase_units[0].amount).toEqual({ currency_code: 'USD', value: '20.00' });
      providerOrder = { ...body, id: reference, status: 'APPROVED' };
    } else if (request.method === 'POST' && request.url.endsWith('/capture')) {
      captures++;
      providerOrder!.status = 'COMPLETED';
      providerOrder!.purchase_units[0].payments = { captures: [{ id: `CAPTURE${reference}`, status: 'COMPLETED',
        amount: { value: '20.00', currency_code: 'USD' }, final_capture: true, create_time: new Date().toISOString() }] };
    } else expect(request.method).toBe('GET');
    return Response.json(providerOrder!);
  }, async () => {
    const args = { order_id: order.id, idempotency_key: crypto.randomUUID() };
    for (const token of [stranger.token, registered.token, cart.guest_token]) {
      expect((await handlePayPalCreateOrder(paymentRequest(args, token))).status).toBeGreaterThanOrEqual(400);
    }
    expect(creates).toBe(0);
    const created = await handlePayPalCreateOrder(paymentRequest(args, owner.token));
    expect(created.status).toBe(200);
    const intent = await created.json();
    for (const token of [stranger.token, registered.token]) {
      expect((await handlePayPalCaptureOrder(paymentRequest({ payment_intent_id: intent.payment_intent_id }, token))).status).toBeGreaterThanOrEqual(400);
    }
    expect(captures).toBe(0);
    for (let i = 0; i < 2; i++) {
      const captured = await handlePayPalCaptureOrder(paymentRequest({ payment_intent_id: intent.payment_intent_id }, owner.token));
      expect({ status: captured.status, data: await captured.json() }).toMatchObject({ status: 200, data: { processing_status: 'captured' } });
    }
  });
  expect(creates).toBe(1); expect(captures).toBe(1);
  expect(await stockOf(fixture.sku)).toBe(before - 2);
  await contact(owner, 'changed@example.test');
  expect(await checked(rpc('get_customer_order', { order_id: order.id }, owner.token)))
    .toMatchObject({ email: registered.email, financial_status: 'paid', total: 20 });
  expect(await checked(rpc('list_customer_orders', {}, owner.token))).toMatchObject({ items: [{ id: order.id }] });
  expect(await checked(rpc('create_order_from_quote', { quote_id: quote.id }, owner.token))).toMatchObject({ id: order.id, email: registered.email });
  await checked(api(`/auth/v1/admin/users/${owner.userId}`, { service: true, method: 'DELETE' }));
  expect((await rpc('get_customer_order', { order_id: order.id }, owner.token)).status).toBeGreaterThanOrEqual(400);
  expect(await checked(rpc('get_admin_order', { order_id: order.id }, admin.token))).toMatchObject({ financial_status: 'paid' });
});

test('游客没有有效联系邮箱不能占库存或建单；Quote 后清邮箱也不能转单，失败不消耗报价', async () => {
  const owner = await guest();
  const before = await stockOf(fixture.sku);
  for (const email of [null, 'no-at-sign', 'two@@example.test', 'bad name@example.test', 'bad\n@example.test']) {
    await contact(owner, email);
    for (const name of ['create_checkout_quote', 'create_order']) {
      const args = { ...input(), idempotency_key: crypto.randomUUID() };
      expect((await rpc(name, args, owner.token)).data).toMatchObject({ code: '22023', message: 'valid customer contact email required for checkout' });
    }
  }
  expect(await stockOf(fixture.sku)).toBe(before);
  expect(await checked(rpc('list_customer_orders', {}, owner.token))).toMatchObject({ items: [] });
  await contact(owner, '  Guest+Checkout@example.test  ');
  const quote = await checked<{ id: string }>(rpc('create_checkout_quote', { ...input(), idempotency_key: crypto.randomUUID() }, owner.token));
  await contact(owner, null);
  expect((await rpc('create_order_from_quote', { quote_id: quote.id }, owner.token)).data).toMatchObject({ code: '22023' });
  expect(await checked(rpc('get_checkout_quote', { quote_id: quote.id }, owner.token))).toMatchObject({ status: 'open' });
  await contact(owner, '  Guest+Checkout@example.test  ');
  const order = await checked<{ id: string }>(rpc('create_order_from_quote', { quote_id: quote.id }, owner.token));
  expect(order).toMatchObject({ email: 'Guest+Checkout@example.test' });
  await checked(rpc('cancel_order', { order_id: order.id }, owner.token));
});
