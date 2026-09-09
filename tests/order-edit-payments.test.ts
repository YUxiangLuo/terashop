import { afterAll, beforeAll, expect, test } from 'bun:test';
import { api, rpc, signup, makeAdmin, CN_ADDRESS, type TestUser } from './helpers';
import { checked, fixtureOrder, fixtureIntent, paymentFixture, paymentEvent, type PaymentFixture } from './payment-fixtures';
import { heldTransactionRace, testDatabase } from './database-concurrency';

const database = testDatabase();
let admin: TestUser;
let buyer: TestUser;
let fixture: PaymentFixture;
const US_ADDRESS = { ...CN_ADDRESS, country: 'US' };
beforeAll(async () => {
  admin = await signup(); buyer = await signup(); await makeAdmin(admin.userId);
  fixture = await paymentFixture(admin);
});
afterAll(async () => {
  if (fixture) await api(`/rest/v1/products?id=eq.${fixture.productId}`, {
    service: true, method: 'PATCH', body: { status: 'archived' },
  });
  await database.close();
});

for (const [provider, bound] of [['stripe', false], ['stripe', true], ['paypal', true]] as const) {
  test(`${provider} ${bound ? '已绑定' : '未绑定'}活动意图锁定兼容订单的地址和金额`, async () => {
    const order = await fixtureOrder(fixture, buyer, 1, false);
    if (bound) await fixtureIntent(order, buyer, provider);
    else await checked(rpc('create_payment_intent_for_customer', {
      order_id: order.id, customer_id: buyer.userId, provider, idempotency_key: crypto.randomUUID(),
    }, undefined, true));
    for (const token of [buyer.token, admin.token]) {
      const result = await rpc('update_order_address', { order_id: order.id, address: US_ADDRESS }, token);
      expect(result.status).toBe(400);
      expect(result.data).toMatchObject({ message: expect.stringContaining('payment intent') });
    }
    const [current] = await checked<Array<{ total: number; shipping_address: { country: string } }>>(api(
      `/rest/v1/orders?id=eq.${order.id}&select=total,shipping_address`, { token: buyer.token },
    ));
    expect(current.total).toBe(order.total);
    expect(current.shipping_address.country).toBe('CN');
  });
}

test('无意图时仍可改价；V2 兼容订单创建意图后也受同样约束', async () => {
  const order = await checked<{ id: string }>(rpc('create_order_v2', {
    idempotency_key: crypto.randomUUID(), items: [{ variant_id: fixture.variantId, quantity: 1 }], address: CN_ADDRESS,
  }, buyer.token));
  const changed = await checked<{ total: number }>(rpc('update_order_address', {
    order_id: order.id, address: US_ADDRESS,
  }, buyer.token));
  expect(changed.total).toBe(10);
  const intent = await checked<{ amount: number }>(rpc('create_payment_intent_for_customer', {
    order_id: order.id, customer_id: buyer.userId, provider: 'stripe', idempotency_key: crypto.randomUUID(),
  }, undefined, true));
  expect(intent.amount).toBe(10);
  expect((await rpc('update_order_address', { order_id: order.id, address: CN_ADDRESS }, buyer.token)).status).toBe(400);
});

test('地址簿引用不能穿透锁；service role 也不能直接改商业快照或商品行', async () => {
  const order = await fixtureOrder(fixture, buyer, 1, false);
  await fixtureIntent(order, buyer);
  const [address] = await checked<Array<{ id: string }>>(api('/rest/v1/addresses', {
    token: buyer.token, method: 'POST', body: US_ADDRESS,
  }));
  expect((await rpc('update_order_address', { order_id: order.id, address_id: address.id }, buyer.token)).status).toBe(400);
  const direct = await api(`/rest/v1/orders?id=eq.${order.id}`, {
    service: true, method: 'PATCH', body: { shipping_address: US_ADDRESS, tax_total: 0, total: 10 },
  });
  expect(direct.status).toBe(400);
  expect(direct.data).toMatchObject({ message: expect.stringContaining('payment intent') });
  const item = await api(`/rest/v1/order_items?id=eq.${order.itemId}`, {
    service: true, method: 'PATCH', body: { name: 'changed while paying' },
  });
  expect(item.status).toBe(400);
  expect(item.data).toMatchObject({ message: expect.stringContaining('payment intent') });
});

test('Stripe 本地 cancelled 不足以解锁；渠道终结后可改价并创建新金额意图', async () => {
  const order = await fixtureOrder(fixture, buyer, 1, false);
  const intent = await fixtureIntent(order, buyer);
  await paymentEvent('stripe', 'payment_intent.canceled', intent.provider_reference, {
    status: 'canceled', amount_minor: String(Math.round(intent.amount * 100)), currency: intent.currency,
    metadata: { tera_payment_intent_id: intent.id },
  });
  expect((await rpc('update_order_address', { order_id: order.id, address: US_ADDRESS }, buyer.token)).status).toBe(400);
  await checked(rpc('complete_stripe_payment_intent_cancel', {
    payment_intent_id: intent.id, succeeded: true, provider_status: 'canceled',
  }, undefined, true));
  expect((await rpc('update_order_address', { order_id: order.id, address: US_ADDRESS }, buyer.token)).status).toBe(200);
  const next = await fixtureIntent(order, buyer);
  expect(next.id).not.toBe(intent.id);
  expect(next.amount).toBe(10);
});

for (const first of ['intent', 'edit']) {
  test(`受控并发：${first} 先取得订单锁，不会生成旧金额意图与新金额订单`, async () => {
    const order = await fixtureOrder(fixture, buyer, 1, false);
    const key = crypto.randomUUID();
    const claims = JSON.stringify(first === 'intent'
      ? { role: 'service_role' } : { role: 'authenticated', sub: buyer.userId });
    const result = await heldTransactionRace(database, async transaction => {
      await transaction`select set_config('request.jwt.claims', ${claims}, true)`;
      if (first === 'intent') {
        await transaction`select public.create_payment_intent_for_customer(
          order_id => ${order.id}::uuid, customer_id => ${buyer.userId}::uuid,
          provider => 'stripe', idempotency_key => ${key})`;
      } else {
        await transaction`select public.update_order_address(
          order_id => ${order.id}::uuid, address => ${JSON.stringify(US_ADDRESS)}::text::jsonb)`;
      }
    }, () => first === 'intent'
      ? rpc('update_order_address', { order_id: order.id, address: US_ADDRESS }, buyer.token)
      : rpc('create_payment_intent_for_customer', {
          order_id: order.id, customer_id: buyer.userId, provider: 'stripe', idempotency_key: key,
        }, undefined, true));
    expect(result.status).toBe(first === 'intent' ? 400 : 200);
    const [row] = await database`
      select o.total, i.amount from public.orders o join commerce.payment_intents i on i.order_id = o.id
      where o.id = ${order.id}::uuid
    `;
    expect(String(row.total)).toBe(String(row.amount));
  });
}

test('直接商品行写入在订单锁竞争时快速失败，不引入 order/item 锁反转', async () => {
  const order = await fixtureOrder(fixture, buyer, 1, false);
  await database.begin(async transaction => {
    await transaction`select 1 from public.orders where id = ${order.id}::uuid for update`;
    const result = await api(`/rest/v1/order_items?id=eq.${order.itemId}`, {
      service: true, method: 'PATCH', body: { name: 'concurrent direct write' },
    });
    expect(result.status).toBe(409);
    expect(result.data).toMatchObject({ message: expect.stringContaining('order is busy') });
    // The failed writer must have released its item lock, so the command can proceed.
    await transaction`update public.order_items set name = 'serialized command' where id = ${order.itemId}::uuid`;
  });
});
