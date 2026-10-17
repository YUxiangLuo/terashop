import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { api, rpc, signup, makeAdmin, TEST_ADDRESS, installTestTax, type TestUser } from './helpers';
import { checked, fixtureOrder, fixtureIntent, paymentFixture, paymentEvent, type PaymentFixture } from './payment-fixtures';
import { heldTransactionRace, testDatabase } from './database-concurrency';

const database = testDatabase();
let admin: TestUser;
let buyer: TestUser;
let fixture: PaymentFixture;
const OTHER_ADDRESS = { ...TEST_ADDRESS, country: 'CA' };
let removeTax: (() => Promise<void>) | undefined;
beforeAll(async () => {
  removeTax = await installTestTax();
  admin = await signup(); await makeAdmin(admin.userId);
  fixture = await paymentFixture(admin);
});
// Tests are independent; each uses a fresh customer.
beforeEach(async () => { buyer = await signup(); });
afterAll(async () => {
  await removeTax?.();
  if (fixture) await api(`/rest/v1/products?id=eq.${fixture.productId}`, {
    service: true, method: 'PATCH', body: { status: 'archived' },
  });
  await database.close();
});

for (const [provider, bound] of [['paypal', false], ['paypal', true]] as const) {
  test(`${provider} ${bound ? '已绑定' : '未绑定'}活动意图锁定兼容订单的地址和金额`, async () => {
    const order = await fixtureOrder(fixture, buyer, 1, false);
    if (bound) await fixtureIntent(order, buyer, provider);
    else await checked(rpc('create_payment_intent_for_customer', {
      order_id: order.id, actor_id: buyer.userId, provider, idempotency_key: crypto.randomUUID(),
    }, undefined, true));
    for (const token of [buyer.token, admin.token]) {
      const result = await rpc('update_order_address', { order_id: order.id, address: OTHER_ADDRESS }, token);
      expect(result.status).toBe(400);
      expect(result.data).toMatchObject({ message: expect.stringContaining('payment intent') });
    }
    const [current] = await checked<Array<{ total: number; shipping_address: { country: string } }>>(api(
      `/rest/v1/orders?id=eq.${order.id}&select=total,shipping_address`, { token: buyer.token },
    ));
    expect(current.total).toBe(order.total);
    expect(current.shipping_address.country).toBe('US');
  });
}

test('订单创建时即冻结快照；改价需取消并创建新 checkout', async () => {
  const order = await checked<{ id: string; total: number; shipping_address: { country: string } }>(rpc('create_order', {
    idempotency_key: crypto.randomUUID(), items: [{ variant_id: fixture.variantId, quantity: 1 }], address: TEST_ADDRESS,
  }, buyer.token));
  const changed = await rpc('update_order_address', {
    order_id: order.id, address: OTHER_ADDRESS,
  }, buyer.token);
  expect(changed.status).toBe(400);
  expect(changed.data).toMatchObject({ message: expect.stringContaining('immutable') });
  const [unchanged] = await checked<Array<{ total: number; shipping_address: { country: string } }>>(api(
    `/rest/v1/orders?id=eq.${order.id}&select=total,shipping_address`, { token: buyer.token },
  ));
  expect(unchanged).toEqual({ total: order.total, shipping_address: order.shipping_address });
  await checked(rpc('cancel_order', { order_id: order.id }, buyer.token));
  const replacement = await checked<{ id: string; total: number; shipping_address: { country: string } }>(rpc('create_order', {
    idempotency_key: crypto.randomUUID(), items: [{ variant_id: fixture.variantId, quantity: 1 }], address: OTHER_ADDRESS,
  }, buyer.token));
  expect(replacement.id).not.toBe(order.id);
  expect(replacement.shipping_address.country).toBe('CA');
  const intent = await checked<{ amount: number }>(rpc('create_payment_intent_for_customer', {
    order_id: replacement.id, actor_id: buyer.userId, provider: 'paypal', idempotency_key: crypto.randomUUID(),
  }, undefined, true));
  expect(intent.amount).toBe(replacement.total);
});

test('地址簿引用不能穿透锁；service role 也不能直接改商业快照或商品行', async () => {
  const order = await fixtureOrder(fixture, buyer, 1, false);
  await fixtureIntent(order, buyer);
  const [address] = await checked<Array<{ id: string }>>(api('/rest/v1/addresses', {
    token: buyer.token, method: 'POST', body: OTHER_ADDRESS,
  }));
  expect((await rpc('update_order_address', { order_id: order.id, address_id: address.id }, buyer.token)).status).toBe(400);
  const direct = await api(`/rest/v1/orders?id=eq.${order.id}`, {
    service: true, method: 'PATCH', body: { shipping_address: OTHER_ADDRESS, tax_total: 0, total: 10 },
  });
  expect(direct.status).toBe(400);
  expect(direct.data).toMatchObject({ message: expect.stringContaining('payment intent') });
  const item = await api(`/rest/v1/order_items?id=eq.${order.itemId}`, {
    service: true, method: 'PATCH', body: { name: 'changed while paying' },
  });
  expect(item.status).toBe(400);
  expect(item.data).toMatchObject({ message: expect.stringContaining('payment intent') });
});

test('PayPal declined 后原订单仍冻结，取消后新 checkout 使用新地址和新意图', async () => {
  const order = await fixtureOrder(fixture, buyer, 1, false);
  const intent = await fixtureIntent(order, buyer);
  const result = await paymentEvent('paypal', 'PAYMENT.CAPTURE.DECLINED', `CAPTURE${intent.id}`, {
    status: 'declined', amount: intent.amount.toFixed(2), currency: intent.currency,
    order_reference: intent.provider_reference, metadata: { tera_payment_intent_id: intent.id },
  });
  expect(result.outcome).toBe('failed');
  const edit = await rpc('update_order_address', { order_id: order.id, address: OTHER_ADDRESS }, buyer.token);
  expect(edit.status).toBe(400);
  expect(edit.data).toMatchObject({ message: expect.stringContaining('immutable') });
  await checked(rpc('cancel_order', { order_id: order.id }, buyer.token));
  const replacement = await checked<{ id: string; total: number; currency: string }>(rpc('create_order', {
    idempotency_key: crypto.randomUUID(), items: [{ variant_id: fixture.variantId, quantity: 1 }], address: OTHER_ADDRESS,
  }, buyer.token));
  const next = await fixtureIntent({ ...replacement, itemId: '', quoteId: null }, buyer);
  expect(next.id).not.toBe(intent.id);
  expect(next.amount).toBe(replacement.total);
});

for (const first of ['intent', 'admin_note']) {
  test(`受控并发：${first} 先取得订单锁，不会生成旧金额意图与新金额订单`, async () => {
    const order = await fixtureOrder(fixture, buyer, 1, false);
    const key = crypto.randomUUID();
    const claims = JSON.stringify(first === 'intent'
      ? { role: 'service_role' } : { role: 'authenticated', sub: buyer.userId });
    const result = await heldTransactionRace(database, async transaction => {
      await transaction`select set_config('request.jwt.claims', ${claims}, true)`;
      if (first === 'intent') {
        await transaction`select public.create_payment_intent_for_customer(
          order_id => ${order.id}::uuid, actor_id => ${buyer.userId}::uuid,
          provider => 'paypal', idempotency_key => ${key})`;
      } else await transaction`update public.orders set admin_note='lock holder' where id=${order.id}::uuid`;
    }, () => rpc('update_order_address', { order_id: order.id, address: OTHER_ADDRESS }, buyer.token));
    expect(result.status).toBe(400);
    const [row] = await database`select total, shipping_address, admin_note from public.orders where id=${order.id}::uuid`;
    expect(row.shipping_address.country).toBe('US');
    expect(row.admin_note).toBe(first === 'admin_note' ? 'lock holder' : null);
    if (first === 'intent') {
      const [payment] = await database`select amount from commerce.payment_intents where order_id=${order.id}::uuid`;
      expect(String(row.total)).toBe(String(payment.amount));
    }
  });
}

test('受支持的 admin_note 持有订单锁时，受保护商品行写入快速失败且事实不变', async () => {
  const order = await fixtureOrder(fixture, buyer, 1, false);
  await database.begin(async transaction => {
    await transaction`select 1 from public.orders where id = ${order.id}::uuid for update`;
    const result = await api(`/rest/v1/order_items?id=eq.${order.itemId}`, {
      service: true, method: 'PATCH', body: { name: 'concurrent direct write' },
    });
    expect(result.status).toBe(409);
    expect(result.data).toMatchObject({ message: expect.stringContaining('order is busy') });
    await transaction`update public.orders set admin_note = 'serialized command' where id = ${order.id}::uuid`;
  });
  const [item] = await database`select name from public.order_items where id=${order.itemId}::uuid`;
  expect(item.name).not.toBe('concurrent direct write');
});
