import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { api, rpc, signup, makeAdmin, stockOf, TEST_ADDRESS, type TestUser } from './helpers';
import { checked, fixtureOrder, fixtureIntent, paymentFixture, settleIntent, type PaymentFixture } from './payment-fixtures';
import { testDatabase, heldTransactionRace } from './database-concurrency';
import { withRollback } from '../scripts/lib/transactions';
import { withPaymentProviderMock, paymentRequest } from './payment-handler-harness';
import { handlePayPalCreateRefund } from '../supabase/functions/paypal-create-refund/handler';
import { sha256Hex } from '../supabase/functions/_shared/provider-events';

const database = testDatabase();
let admin: TestUser;
let buyer: TestUser;
const products: string[] = [];
const claims = (userId: string) => JSON.stringify({ role: 'authenticated', sub: userId });
beforeAll(async () => { admin = await signup(); await makeAdmin(admin.userId); });
beforeEach(async () => { buyer = await signup(); });
afterAll(async () => {
  if (products.length) await checked(api(`/rest/v1/products?id=in.(${products.join(',')})`, {
    service: true, method: 'PATCH', body: { status: 'archived' },
  }));
  await database.close();
});
async function fixture(): Promise<PaymentFixture> {
  const f = await paymentFixture(admin); products.push(f.productId); return f;
}
const oauth = (request: Request) => request.url.endsWith('/v1/oauth2/token')
  ? Response.json({ access_token: 'regression-token', expires_in: 3600 }) : null;

for (const ambiguous of [false, true]) test(`退款发出后取消/替代均被拒，${ambiguous ? '网络结果不明也持久化保护并按原键恢复' : '成功响应正常记账'}`, async () => {
  const order = await fixtureOrder(await fixture(), buyer);
  await settleIntent(await fixtureIntent(order, buyer));
  const command = { order_id: order.id, idempotency_key: crypto.randomUUID(), amount: '10.00' };
  let id = ''; let posts = 0;
  await withPaymentProviderMock(async request => {
    const token = oauth(request); if (token) return token;
    expect(request.method).toBe('POST'); posts++;
    const body = await request.json();
    if (id) expect(body.custom_id).toBe(id);
    id = body.custom_id;
    expect(request.headers.get('PayPal-Request-Id')).toBe(`ref_${id.replaceAll('-', '')}`);
    expect((await rpc('cancel_refund_request', {
      refund_request_id: id, actor_id: admin.userId, provider_confirmed: false,
    }, undefined, true)).status).toBe(400);
    expect((await rpc('create_refund_request', {
      order_id: order.id, actor_id: admin.userId, provider: 'paypal',
      idempotency_key: crypto.randomUUID(), amount: '10.00',
    }, undefined, true)).status).toBe(400);
    if (ambiguous && posts === 1) throw new TypeError('simulated connection lost after dispatch');
    return Response.json({ id: `REFUND${id}`, status: 'COMPLETED', amount: body.amount,
      custom_id: id, create_time: new Date().toISOString() });
  }, async () => {
    if (ambiguous) {
      expect((await handlePayPalCreateRefund(paymentRequest(command, admin.token))).status).toBe(502);
      const [row] = await database`select provider_refund_requested_at, provider_reference from commerce.refund_requests where id=${id}::uuid`;
      expect(row.provider_refund_requested_at).not.toBeNull(); expect(row.provider_reference).toBeNull();
      await expect(withRollback(database, tx => tx`update commerce.refund_requests set provider_refund_requested_at=null where id=${id}::uuid`)).rejects.toThrow('marker is immutable');
    }
    const response = await handlePayPalCreateRefund(paymentRequest(command, admin.token));
    expect({ status: response.status, body: await response.json() }).toMatchObject({ status: 200, body: { processing_status: 'refunded' } });
  });
  const [row] = await database`select r.status, m.reconciliation_status from commerce.refund_requests r
    join commerce.provider_money_movements m on m.refund_request_id=r.id where r.id=${id}::uuid`;
  expect(row).toMatchObject({ status: 'succeeded', reconciliation_status: 'matched' });
  expect(posts).toBe(ambiguous ? 2 : 1);
});

test('取消先提交时，原键重试在退款 POST 前拒绝；prepare 仅允许 service/admin actor', async () => {
  const order = await fixtureOrder(await fixture(), buyer);
  await settleIntent(await fixtureIntent(order, buyer));
  const command = { order_id: order.id, idempotency_key: crypto.randomUUID(), amount: '10.00' };
  const local = await checked<{ id: string }>(rpc('create_refund_request', {
    ...command, actor_id: admin.userId, provider: 'paypal', metadata: { edge_function: 'paypal-create-refund' },
  }, undefined, true));
  expect((await rpc('prepare_paypal_refund', { refund_request_id: local.id, actor_id: admin.userId }, admin.token)).status).toBe(403);
  expect((await rpc('prepare_paypal_refund', { refund_request_id: local.id, actor_id: buyer.userId }, undefined, true)).status).toBe(400);
  const result = await heldTransactionRace(database, async tx => {
    await tx`select set_config('request.jwt.claims','{"role":"service_role"}',true)`;
    await tx`select public.cancel_refund_request(${local.id}::uuid, ${admin.userId}::uuid)`;
  }, () => rpc('prepare_paypal_refund', { refund_request_id: local.id, actor_id: admin.userId }, undefined, true));
  expect(result.status).toBe(400);
  let requests = 0;
  await withPaymentProviderMock(async () => { requests++; throw new Error('must not contact provider'); }, async () => {
    const response = await handlePayPalCreateRefund(paymentRequest(command, admin.token));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { message: 'terminal refund request cannot be dispatched' } });
  });
  expect(requests).toBe(0);
});

test('长时间未知的退款不再 POST 或释放预留；可信绑定后仍可 GET 恢复', async () => {
  const order = await fixtureOrder(await fixture(), buyer);
  await settleIntent(await fixtureIntent(order, buyer));
  const command = { order_id: order.id, idempotency_key: crypto.randomUUID(), amount: '10.00' };
  const local = await checked<{ id: string }>(rpc('create_refund_request', { ...command, actor_id: admin.userId, provider: 'paypal', metadata: { edge_function: 'paypal-create-refund' } }, undefined, true));
  // Time fixture: represent an unknown dispatch older than our one-hour retry window.
  await database`update commerce.refund_requests set provider_refund_requested_at=clock_timestamp()-interval '2 hours' where id=${local.id}::uuid`;
  let calls = 0;
  await withPaymentProviderMock(async request => {
    const token = oauth(request); if (token) return token;
    calls++; expect(request.method).toBe('GET');
    return Response.json({ id: `REFUND${local.id}`, status: 'COMPLETED', amount: { value: '10.00', currency_code: 'USD' }, create_time: new Date().toISOString() });
  }, async () => {
    const rejected = await handlePayPalCreateRefund(paymentRequest(command, admin.token));
    expect(rejected.status).toBe(400); expect(await rejected.json()).toMatchObject({ error: { message: expect.stringContaining('retry window') } });
    expect(calls).toBe(0);
    expect((await rpc('cancel_refund_request', { refund_request_id: local.id, actor_id: admin.userId }, undefined, true)).status).toBe(400);
    await checked(rpc('bind_refund_request_provider', {
      refund_request_id: local.id, provider_reference: `REFUND${local.id}`, provider_status: 'pending', amount: '10.00', currency: 'USD',
    }, undefined, true));
    expect((await handlePayPalCreateRefund(paymentRequest(command, admin.token))).status).toBe(200);
  });
  expect(calls).toBe(1);
});

test('报价和便捷下单共享 50 行/100 件限制，同键重放返回原报价', async () => {
  const f = await fixture();
  for (const name of ['create_order', 'create_checkout_quote']) {
    const result = await rpc(name, {
      items: [{ variant_id: f.variantId, quantity: 101 }], address: TEST_ADDRESS,
      idempotency_key: crypto.randomUUID(),
    }, buyer.token);
    expect(result.status).toBe(400); expect(result.data).toMatchObject({ message: expect.stringContaining('100 units') });
    const tooManyLines = await rpc(name, {
      items: Array.from({ length: 51 }, () => ({ variant_id: crypto.randomUUID(), quantity: 1 })), address: TEST_ADDRESS,
      idempotency_key: crypto.randomUUID(),
    }, buyer.token);
    expect(tooManyLines.data).toMatchObject({ message: expect.stringContaining('50 lines') });
  }
  const quoteCommand = { items: [{ variant_id: f.variantId, quantity: 1 }], address: TEST_ADDRESS, idempotency_key: crypto.randomUUID() };
  const quote = await checked<{ id: string }>(rpc('create_checkout_quote', quoteCommand, buyer.token));
  expect(await checked<{ id: string }>(rpc('create_checkout_quote', quoteCommand, buyer.token))).toMatchObject({ id: quote.id });
  expect((await rpc('create_order_from_quote', { quote_id: quote.id }, buyer.token)).status).toBe(200);
});

test('便捷下单及意图沿用报价期限，过期仅释放预占；未知 capture 的迟到成功只对账', async () => {
  const f = await fixture(); const order = await fixtureOrder(f, buyer, 1, false);
  expect((await rpc('expire_checkout_quotes', {}, buyer.token)).status).toBe(403);
  expect((await rpc('expire_checkout_quotes', { max_quotes: null }, undefined, true)).status).toBe(400);
  expect((await rpc('expire_checkout_quotes', { as_of: null }, undefined, true)).status).toBe(400);
  const intent = await fixtureIntent(order, buyer);
  const [before] = await database`select o.payment_expires_at=i.expires_at as same_deadline from public.orders o
    join commerce.payment_intents i on i.order_id=o.id where o.id=${order.id}::uuid`;
  expect(before.same_deadline).toBe(true);
  await expect(withRollback(database, tx => tx`update commerce.payment_intents set expires_at=expires_at+interval '1 day' where id=${intent.id}::uuid`)).rejects.toThrow('immutable');
  expect((await api(`/rest/v1/orders?id=eq.${order.id}`, { service: true, method: 'PATCH', body: { payment_expires_at: '2100-01-01' } })).status).toBe(400);
  await checked(rpc('prepare_paypal_capture', { payment_intent_id: intent.id, actor_id: buyer.userId }, undefined, true));
  await withRollback(database, async tx => {
    await tx`select set_config('request.jwt.claims','{"role":"service_role"}',true)`;
    for (let i = 0; i < 2; i++) await tx`select public.expire_checkout_quotes(500,'2100-01-01'::timestamptz)`;
    const [row] = await tx`select status, (select on_hand from public.inventory_levels where variant_id=${f.variantId}::uuid limit 1) as stock,
      (select count(*)::int from public.inventory_movements where order_id=o.id and reason='cancel') as restocks
      from public.orders o where id=${order.id}::uuid`;
    expect(row).toMatchObject({ status: 'cancelled', stock: 100, restocks: 0 });
    const data = { status: 'completed', amount: '10.00', currency: 'USD', order_reference: intent.provider_reference };
    const [event] = await tx`select public.ingest_payment_provider_event('paypal',${crypto.randomUUID()},'api_response',
      'paypal.capture.api_result',${`CAPTURE${intent.id}`},false,now(),${await sha256Hex(JSON.stringify(data))},${JSON.stringify(data)}::text::jsonb) as result`;
    expect(event.result).toMatchObject({ status: 'processed', outcome: 'action_required' });
    const [money] = await tx`select reconciliation_status from commerce.provider_money_movements where order_id=${order.id}::uuid`;
    expect(money.reconciliation_status).toBe('action_required');
  });
  expect(await stockOf(f.sku)).toBe(100); // The time-travel experiment rolled back; still reserved, never deducted.
});

for (const terminal of ['paid', 'cancelled', 'expired'] as const) {
  test(`便捷下单 ${terminal} 后同键重放保留订单、报价和期限，不重新预占；显式 Quote 同键独立`, async () => {
    const f = await fixture();
    const command = { items: [{ variant_id: f.variantId, quantity: 3 }], address: TEST_ADDRESS, idempotency_key: crypto.randomUUID() };
    const explicit = await checked<{ id: string }>(rpc('create_checkout_quote', {
      ...command, items: [{ variant_id: f.variantId, quantity: 2 }],
    }, buyer.token));
    const order = await checked<{ id: string; payment_expires_at: string }>(rpc('create_order', command, buyer.token));
    const quote = await checked<{ id: string; expires_at: string; lines: Array<{ id: string; quantity: number }> }>(rpc('get_order_checkout_quote', { order_id: order.id }, buyer.token));
    expect(quote.id).not.toBe(explicit.id);
    expect(quote.expires_at).toBe(order.payment_expires_at);
    expect(quote.lines).toHaveLength(1);
    expect(quote.lines[0].quantity).toBe(3);
    expect(await checked(rpc('get_inventory_availability', { variant_id: f.variantId }, admin.token)))
      .toMatchObject({ on_hand: 100, reserved: 5, available: 95 });
    await checked(rpc('cancel_checkout_quote', { quote_id: explicit.id }, buyer.token));
    const verifyReplay = async () => {
      const replay = await checked(rpc('create_order', command, buyer.token));
      expect(replay).toMatchObject({ id: order.id, payment_expires_at: order.payment_expires_at,
        status: terminal === 'paid' ? 'open' : 'cancelled', financial_status: terminal === 'paid' ? 'paid' : 'pending' });
      const [counts] = await database`select count(*)::int quotes,
        count(*) filter (where order_id=${order.id}::uuid)::int linked
        from commerce.checkout_quotes where customer_id=${buyer.customerId}::uuid`;
      expect(counts).toEqual({ quotes: 2, linked: 1 });
    };
    if (terminal === 'expired') {
      // Expire only this owned checkout; the other quotes are protected by SKIP LOCKED.
      await withRollback(database, async tx => {
        await tx`select 1 from commerce.checkout_quotes where id<>${quote.id}::uuid order by id for update`;
        await checked(rpc('expire_checkout_quotes', { as_of: '2100-01-01' }, undefined, true));
        await verifyReplay();
      });
    } else {
      await checked(terminal === 'paid'
        ? rpc('mark_order_paid', { idempotency_key: crypto.randomUUID(), order_id: order.id }, admin.token)
        : rpc('cancel_order', { order_id: order.id }, admin.token));
      await verifyReplay();
    }
    expect(await checked(rpc('get_inventory_availability', { variant_id: f.variantId }, admin.token)))
      .toMatchObject({ on_hand: terminal === 'paid' ? 97 : 100, reserved: 0, available: terminal === 'paid' ? 97 : 100 });
    const movements = await checked(api(`/rest/v1/inventory_movements?order_id=eq.${order.id}&select=delta,reason`, { service: true }));
    expect(movements).toEqual(terminal === 'paid' ? [{ delta: -3, reason: 'order' }] : []);
  });
}

test('便捷转单失败回滚已创建的 Quote、预占和幂等记录；原键可重试', async () => {
  const f = await fixture(), key = crypto.randomUUID();
  await withRollback(database, async tx => {
    await tx`select set_config('request.jwt.claims',${claims(buyer.userId)},true)`;
    // Force failure AFTER the internal Quote exists, at the real order INSERT.
    await tx.unsafe(`alter table public.orders add constraint review_reject_order
      check (customer_id <> '${buyer.customerId}'::uuid) not valid`);
    await tx`savepoint conversion`;
    const create = () => tx`select public.create_order(
      ${JSON.stringify([{ variant_id: f.variantId, quantity: 3 }])}::text::jsonb, ${key},
      ${JSON.stringify(TEST_ADDRESS)}::text::jsonb) as result`;
    await expect(Promise.resolve(create())).rejects.toThrow('review_reject_order');
    await tx`rollback to savepoint conversion`;
    const [counts] = await tx`select
      (select count(*)::int from commerce.checkout_quotes where customer_id=${buyer.customerId}::uuid) quotes,
      (select count(*)::int from commerce.command_idempotency where subject_id=${buyer.customerId}::uuid) commands,
      (select count(*)::int from public.orders where customer_id=${buyer.customerId}::uuid) orders`;
    expect(counts).toEqual({ quotes: 0, commands: 0, orders: 0 });
    await tx`alter table public.orders drop constraint review_reject_order`;
    const [created] = await create();
    const [replayed] = await create();
    expect(replayed.result.id).toBe(created.result.id);
    const [stock] = await tx`select on_hand, private.active_reserved_quantity(variant_id,location_id,null) reserved
      from public.inventory_levels where variant_id=${f.variantId}::uuid`;
    expect(stock).toEqual({ on_hand: 100, reserved: 3 });
    await tx`set constraints all immediate`;
  });
});

test('NaN/Infinity 不能写商品或促销；所有业务 numeric 列均有有限值约束', async () => {
  const f = await fixture();
  for (const value of ['NaN', 'Infinity', '-Infinity']) {
    for (const column of ['price', 'cost', 'compare_at_price']) {
      expect((await api(`/rest/v1/product_variants?id=eq.${f.variantId}&select=id`, {
        token: admin.token, method: 'PATCH', body: { [column]: value },
      })).status).toBe(400);
    }
    expect((await api('/rest/v1/promotions', { token: admin.token, method: 'POST', body: {
      name: 'Non-finite promotion', type: 'order_fixed', params: { amount: value },
    } })).status).toBe(400);
  }
  const missing = await database`select c.relname, a.attname from pg_attribute a
    join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','commerce') and c.relkind='r' and a.atttypid='numeric'::regtype
      and not exists (select 1 from pg_constraint k where k.conrelid=c.oid and a.attnum=any(k.conkey)
                      and k.contype='c' and pg_get_expr(k.conbin,k.conrelid) like '%NaN%')`;
  expect(missing).toEqual([]);
  const order = await fixtureOrder(f, buyer, 1, false);
  expect(order.total).toBe(10);
});

test('便捷下单冻结订单行与头行，即使同一事务完整改价也拒绝；原金额仍可付款', async () => {
  const order = await fixtureOrder(await fixture(), buyer, 1, false);
  expect((await api(`/rest/v1/order_items?id=eq.${order.itemId}`, {
    service: true, method: 'PATCH', body: { quantity: 2 },
  })).status).toBe(400);
  for (const [table, id, body] of [
    ['order_items', order.itemId, { unit_price: 100, total: 100 }],
    ['orders', order.id, { subtotal: 100, total: 100 }],
  ] as const) {
    const result = await api(`/rest/v1/${table}?id=eq.${id}`, { service: true, method: 'PATCH', body });
    expect(result.status).toBe(400); expect(result.data).toMatchObject({ message: expect.stringContaining('immutable') });
  }
  await expect(database.begin(async tx => {
    await tx`select 1 from public.orders where id=${order.id}::uuid for update`;
    await tx`update public.order_items set unit_price=20,total=20 where id=${order.itemId}::uuid`;
    await tx`update public.orders set subtotal=20,total=20 where id=${order.id}::uuid`;
  })).rejects.toThrow('immutable');
  await checked(rpc('mark_order_paid', { idempotency_key: crypto.randomUUID(), order_id: order.id }, admin.token));
  const ledger = await checked<{ balances: { is_balanced: boolean; captured: number } }>(rpc('get_order_ledger', { order_id: order.id }, buyer.token));
  expect(ledger.balances.is_balanced).toBe(true);
  expect(ledger.balances.captured).toBe(10);
});

test('Outbox 重领使用原租约期限；同 worker 的旧 token、错误 owner、过期确认均不能提交', async () => {
  await withRollback(database, async tx => {
    await tx`update commerce.outbox_events set available_at='2100-01-01' where status in ('pending','failed')`;
    const liveToken = crypto.randomUUID(); const oldToken = crypto.randomUUID();
    const [live] = await tx`insert into commerce.outbox_events
      (aggregate_type, aggregate_id, event_type, idempotency_key, status, attempts, locked_by, locked_at, lease_expires_at, lease_token)
      values ('test',gen_random_uuid(),'test.lease',${crypto.randomUUID()},'processing',1,'worker',now()-interval '31 seconds',now()+interval '3569 seconds',${liveToken}::uuid) returning event_id`;
    const [expired] = await tx`insert into commerce.outbox_events
      (aggregate_type, aggregate_id, event_type, idempotency_key, status, attempts, locked_by, locked_at, lease_expires_at, lease_token)
      values ('test',gen_random_uuid(),'test.lease',${crypto.randomUUID()},'processing',1,'worker',now()-interval '31 seconds',now()-interval '1 second',${oldToken}::uuid) returning event_id`;
    const [late] = await tx`select public.complete_outbox_event(${expired.event_id}::uuid,'worker',${oldToken}::uuid,true) as ok`;
    expect(late.ok).toBe(false);
    const [claimed] = await tx`select public.claim_outbox_events('worker',100,30) as result`;
    expect(claimed.result.some((e: { event_id: string }) => e.event_id === live.event_id)).toBe(false);
    const event = claimed.result.find((e: { event_id: string }) => e.event_id === expired.event_id);
    expect(event.attempt).toBe(2); expect(event.lease_token).not.toBe(oldToken);
    for (const [owner, token] of [['worker', oldToken], ['wrong-worker', event.lease_token]]) {
      const [row] = await tx`select public.complete_outbox_event(${expired.event_id}::uuid,${owner},${token}::uuid,true) as ok`;
      expect(row.ok).toBe(false);
    }
    const [done] = await tx`select public.complete_outbox_event(${expired.event_id}::uuid,'worker',${event.lease_token}::uuid,true) as ok`;
    const [replay] = await tx`select public.complete_outbox_event(${expired.event_id}::uuid,'worker',${event.lease_token}::uuid,true) as ok`;
    expect(done.ok).toBe(true); expect(replay.ok).toBe(false);
  });
});

test('API 角色无 TRUNCATE/TRIGGER/REFERENCES/MAINTAIN 或序列能力，真实 SQL 角色执行也被拒', async () => {
  const grants = await database`select n.nspname,c.relname,r.role,p.priv from pg_class c
    join pg_namespace n on n.oid=c.relnamespace
    cross join (values ('anon'),('authenticated')) r(role)
    cross join (values ('TRUNCATE'),('TRIGGER'),('REFERENCES'),('MAINTAIN')) p(priv)
    where n.nspname in ('public','commerce') and c.relkind='r' and has_table_privilege(r.role,c.oid,p.priv)`;
  expect(grants).toEqual([]);
  for (const role of ['anon', 'authenticated']) {
    await expect(withRollback(database, async tx => {
      await tx.unsafe(`set local role ${role}`); await tx`truncate public.addresses`;
    })).rejects.toThrow('permission denied');
    await expect(withRollback(database, async tx => {
      await tx.unsafe(`set local role ${role}`); await tx`select setval('public.orders_order_number_seq',1)`;
    })).rejects.toThrow('permission denied');
  }
});

test('支付意图幂等键按订单隔离，不同客户/同客户的不同订单可并发复用，同订单仍返回同一意图', async () => {
  const f = await fixture(); const other = await signup();
  const owners = [buyer, other, buyer];
  const orders = await Promise.all(owners.map(owner => fixtureOrder(f, owner, 1, false)));
  const key = crypto.randomUUID();
  const commands = orders.map((order, i) => ({ order_id: order.id, actor_id: owners[i].userId, provider: 'paypal', idempotency_key: key }));
  const intents = await Promise.all(commands.map(command => checked<{ id: string; order_id: string }>(rpc('create_payment_intent_for_customer', command, undefined, true))));
  expect(new Set(intents.map(i => i.id)).size).toBe(3);
  for (let i = 0; i < commands.length; i++) {
    const replay = await checked<{ id: string }>(rpc('create_payment_intent_for_customer', commands[i], undefined, true));
    expect(replay.id).toBe(intents[i].id); expect(intents[i].order_id).toBe(orders[i].id);
  }
});
