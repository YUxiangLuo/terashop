import { testDatabase, heldTransactionRace } from './database-concurrency';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { rpc, api, signup, makeAdmin, type TestUser } from './helpers';
import { checked, paymentFixture, fixtureOrder, fixtureIntent, settleIntent, type PaymentFixture } from './payment-fixtures';

// Unlike Promise.all alone, hold a real transaction open and observe the other
// command blocked on its backend. Exercise both serializations deterministically.
const database = testDatabase();
let admin: TestUser;
let buyer: TestUser;
let fixture: PaymentFixture;
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

for (const first of ['capture', 'cancellation']) {
  test(`受控锁交错：${first} 先持锁时，竞争方等待提交后重新检查状态`, async () => {
    const order = await fixtureOrder(fixture, buyer);
    const intent = await fixtureIntent(order, buyer, 'paypal');
    const claims = JSON.stringify(first === 'capture'
      ? { role: 'service_role' } : { role: 'authenticated', sub: buyer.userId });
    const result = await heldTransactionRace(database, async transaction => {
      await transaction`select set_config('request.jwt.claims', ${claims}, true)`;
      if (first === 'capture') {
        await transaction`select public.prepare_paypal_capture(${intent.id}::uuid, ${buyer.userId}::uuid)`;
      } else {
        await transaction`select public.cancel_order(${order.id}::uuid)`;
      }
    }, () => first === 'capture'
      ? rpc('cancel_order', { order_id: order.id }, buyer.token)
      : rpc('prepare_paypal_capture', { payment_intent_id: intent.id, actor_id: buyer.userId }, undefined, true));
    expect(result.status).toBe(400);
    expect(result.data).toMatchObject({ message: expect.stringContaining(
      first === 'capture' ? 'capture is in progress' : 'order is not payable',
    ) });
    if (first === 'capture') {
      await expect(database`
        update commerce.payment_intents set provider_capture_requested_at = null where id = ${intent.id}::uuid
      `.execute()).rejects.toThrow('provider capture request marker is immutable');
      await settleIntent(intent);
    }
  });
}
