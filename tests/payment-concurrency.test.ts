import { SQL } from 'bun';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { rpc, api, signup, makeAdmin, type TestUser } from './helpers';
import { checked, paymentFixture, fixtureOrder, fixtureIntent, settleIntent, type PaymentFixture } from './payment-fixtures';

// Unlike Promise.all alone, hold a real transaction open and observe the other
// command blocked on its backend. Exercise both serializations deterministically.
const databaseUrl = process.env.DB_URL;
if (!databaseUrl) throw new Error('DB_URL is required; run with bun run test or bun run test:current');
const database = new SQL(databaseUrl, { max: 3 });
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

async function waitForBlockedCommand(backendPid: number): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const [row] = await database`
      select exists (
        select 1 from pg_stat_activity a
        where ${backendPid}::integer = any(pg_blocking_pids(a.pid))
      ) as blocked
    `;
    if (row.blocked) return;
    await Bun.sleep(5);
  }
  throw new Error('competing command did not block on the held transaction');
}

for (const first of ['capture', 'cancellation']) {
  test(`受控锁交错：${first} 先持锁时，竞争方等待提交后重新检查状态`, async () => {
    const order = await fixtureOrder(fixture, buyer);
    const intent = await fixtureIntent(order, buyer, 'paypal');
    const ready = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    const claims = JSON.stringify(first === 'capture'
      ? { role: 'service_role' } : { role: 'authenticated', sub: buyer.userId });
    const holding = database.begin(async transaction => {
      await transaction`select set_config('request.jwt.claims', ${claims}, true)`;
      if (first === 'capture') {
        await transaction`select public.prepare_paypal_capture(${intent.id}::uuid, ${buyer.userId}::uuid)`;
      } else {
        await transaction`select public.cancel_order(${order.id}::uuid)`;
      }
      const [row] = await transaction`select pg_backend_pid() as pid`;
      ready.resolve(row.pid);
      await release.promise;
    });
    // Propagate setup errors instead of leaving the ready barrier pending.
    holding.catch(ready.reject);
    let competing: ReturnType<typeof rpc> | undefined;
    try {
      const backendPid = await ready.promise;
      competing = first === 'capture'
        ? rpc('cancel_order', { order_id: order.id }, buyer.token)
        : rpc('prepare_paypal_capture', { payment_intent_id: intent.id, actor_id: buyer.userId }, undefined, true);
      await waitForBlockedCommand(backendPid);
    } finally {
      release.resolve();
      await holding;
    }
    const result = await competing!;
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
