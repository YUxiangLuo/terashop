import { afterAll, beforeAll, expect, test } from 'bun:test';
import { handlePayPalCreateOrder } from '../supabase/functions/paypal-create-order/handler';
import { handlePayPalCaptureOrder } from '../supabase/functions/paypal-capture-order/handler';
import { handlePayPalReconcileCaptures } from '../supabase/functions/paypal-reconcile-captures/handler';
import { api, rpc, signup, makeAdmin, stockOf, SERVICE_KEY, type TestUser } from './helpers';
import { checked, fixtureOrder, fixtureIntent, paymentFixture, paymentEvent, type PaymentFixture, type FixtureIntent } from './payment-fixtures';
import { testDatabase } from './database-concurrency';
import { withRollback } from '../scripts/lib/transactions';
import { paymentRequest, withPaymentProviderMock } from './payment-handler-harness';

const database = testDatabase();
let admin: TestUser;
let fixture: PaymentFixture;
beforeAll(async () => { admin = await signup(); await makeAdmin(admin.userId); fixture = await paymentFixture(admin); });
afterAll(async () => {
  try {
    if (fixture) await checked(api(`/rest/v1/products?id=eq.${fixture.productId}`, {
      service: true, method: 'PATCH', body: { status: 'archived' },
    }));
  } finally { await database.close(); }
});

const oauth = (request: Request) => request.url.endsWith('/v1/oauth2/token')
  ? Response.json({ access_token: 'capture-recovery-token', expires_in: 3600 }) : null;

function providerOrder(intent: FixtureIntent, status = 'COMPLETED', amount = '10.00') {
  return {
    id: intent.provider_reference, intent: 'CAPTURE', status,
    purchase_units: [{ reference_id: intent.order_id, custom_id: intent.id,
      amount: { value: amount, currency_code: 'USD' },
      ...(status === 'APPROVED' ? {} : { payments: { captures: [{
        id: `CAPTURE${intent.id}`, status, amount: { value: amount, currency_code: 'USD' },
        create_time: '2026-09-01T00:00:00Z',
      }] } }),
    }],
  };
}

// Isolate the real queue using locks, never mock the candidate RPC or drain
// unrelated fixtures. The production claim must SKIP LOCKED to make progress.
function withPolling<T>(ids: string[], run: () => Promise<T>): Promise<T> {
  return withRollback(database, async tx => {
    await tx`select id from commerce.payment_intents where id not in (
      select jsonb_array_elements_text(${JSON.stringify(ids)}::text::jsonb)::uuid
    ) order by id for update`;
    return run();
  });
}
const poll = async () => {
  const response = await handlePayPalReconcileCaptures(paymentRequest({}, SERVICE_KEY));
  expect(response.status).toBe(200);
  return response.json();
};
const prepare = (intent: FixtureIntent, buyer: TestUser) => checked(rpc('prepare_paypal_capture', {
  payment_intent_id: intent.id, actor_id: buyer.userId,
}, undefined, true));

test('Capture Worker 仅 service 可用；真实领取跳过锁，冷却期两侧正确且不领取未发起意图', async () => {
  const buyer = await signup();
  const a = await fixtureIntent(await fixtureOrder(fixture, buyer), buyer);
  const b = await fixtureIntent(await fixtureOrder(fixture, buyer), buyer);
  const unrequested = await fixtureIntent(await fixtureOrder(fixture, buyer), buyer);
  await prepare(a, buyer); await prepare(b, buyer);
  await withPaymentProviderMock(request => { throw new Error(`unexpected provider HTTP ${request.method}`); }, async () => {
    expect((await handlePayPalReconcileCaptures(paymentRequest({}, buyer.token))).status).toBe(401);
    for (const max_events of [0, 21, 1.5, '2', null]) {
      expect((await handlePayPalReconcileCaptures(paymentRequest({ max_events }, SERVICE_KEY))).status).toBe(400);
    }
  });
  for (const token of [undefined, buyer.token, admin.token]) {
    expect((await rpc('list_pending_paypal_captures', {}, token)).status).toBe(401 + (token ? 2 : 0));
  }
  expect((await rpc('list_pending_paypal_captures', { max_requests: 21 }, undefined, true)).status).toBe(400);
  const claim = () => checked<Array<{ id: string }>>(rpc('list_pending_paypal_captures', { max_requests: 1 }, undefined, true));
  await withPolling([b.id, unrequested.id], async () => {
    expect((await claim()).map(row => row.id)).toEqual([b.id]);
    expect(await claim()).toEqual([]);
    await database`update commerce.payment_intents set last_provider_poll_at=clock_timestamp()-interval '299 seconds' where id=${b.id}::uuid`;
    expect(await claim()).toEqual([]);
    await database`update commerce.payment_intents set last_provider_poll_at=clock_timestamp()-interval '301 seconds' where id=${b.id}::uuid`;
    expect((await claim()).map(row => row.id)).toEqual([b.id]);
  });
  expect((await database`select provider_poll_attempts from commerce.payment_intents where id=${b.id}::uuid`)[0].provider_poll_attempts).toBe(2);
  expect((await database`select provider_poll_attempts from commerce.payment_intents where id=${a.id}::uuid`)[0].provider_poll_attempts).toBe(0);
});

test('Capture 响应丢失且无 Webhook：Worker 只 GET 恢复资金；重复事件只扣一次库存', async () => {
  const buyer = await signup();
  const order = await fixtureOrder(fixture, buyer);
  const intent = await fixtureIntent(order, buyer);
  const before = await stockOf(fixture.sku);
  let captured = false;
  let capturePosts = 0;
  await withPaymentProviderMock(request => {
    const token = oauth(request); if (token) return token;
    if (request.method === 'POST') {
      expect(request.url).toEndWith('/capture');
      expect(request.headers.get('PayPal-Request-Id')).toBe(intent.id);
      capturePosts++; captured = true;
      throw new Error('provider captured, response lost');
    }
    return Response.json(providerOrder(intent, captured ? 'COMPLETED' : 'APPROVED'));
  }, async () => {
    expect((await handlePayPalCaptureOrder(paymentRequest({ payment_intent_id: intent.id }, buyer.token))).status).toBe(502);
    expect((await rpc('cancel_order', { order_id: order.id }, buyer.token)).status).toBe(400);
    await withPolling([intent.id], async () => {
      expect((await poll()).results).toEqual([{ payment_intent_id: intent.id, status: 'processed', outcome: 'captured' }]);
      expect((await poll()).results).toEqual([]);
    });
    await paymentEvent('paypal', 'PAYMENT.CAPTURE.COMPLETED', `CAPTURE${intent.id}`, {
      status: 'completed', amount: '10.00', currency: 'USD', order_reference: intent.provider_reference,
    });
    const response = await handlePayPalCaptureOrder(paymentRequest({ payment_intent_id: intent.id }, buyer.token));
    expect(response.status).toBe(200);
  });
  expect(capturePosts).toBe(1);
  expect(await stockOf(fixture.sku)).toBe(before - 1);
  expect((await database`select count(*)::int n from commerce.payment_transactions where order_id=${order.id}::uuid and kind='capture'`)[0].n).toBe(1);
});

test('Worker 领取后 GET 未返回时另一 Worker 不重领，Webhook 抢先入账后查询结果不重复入账', async () => {
  const buyer = await signup();
  const order = await fixtureOrder(fixture, buyer);
  const intent = await fixtureIntent(order, buyer);
  await prepare(intent, buyer);
  const before = await stockOf(fixture.sku);
  let gets = 0;
  await withPaymentProviderMock(async request => {
    const token = oauth(request); if (token) return token;
    expect(request.method).toBe('GET'); gets++;
    // Deterministic interleaving: claim committed, but the provider response is
    // held until another claim and an independently delivered event complete.
    expect(await checked<Array<{ id: string }>>(rpc('list_pending_paypal_captures', {}, undefined, true))).toEqual([]);
    expect(await paymentEvent('paypal', 'PAYMENT.CAPTURE.COMPLETED', `CAPTURE${intent.id}`, {
      status: 'completed', amount: '10.00', currency: 'USD', order_reference: intent.provider_reference,
    })).toMatchObject({ outcome: 'captured' });
    return Response.json(providerOrder(intent));
  }, () => withPolling([intent.id], async () => {
    expect((await poll()).results).toEqual([{ payment_intent_id: intent.id, status: 'processed', outcome: 'captured' }]);
  }));
  expect(gets).toBe(1);
  expect(await stockOf(fixture.sku)).toBe(before - 1);
  expect((await database`select count(*)::int n from commerce.payment_transactions where order_id=${order.id}::uuid and kind='capture'`)[0].n).toBe(1);
});

test('Worker 逐项隔离错误对象；APPROVED 不扣款、PENDING 不扣库存、金额冲突先记资金', async () => {
  const buyer = await signup();
  const intents: FixtureIntent[] = [];
  for (let i = 0; i < 4; i++) {
    const intent = await fixtureIntent(await fixtureOrder(fixture, buyer), buyer);
    await prepare(intent, buyer); intents.push(intent);
  }
  const before = await stockOf(fixture.sku);
  await withPaymentProviderMock(request => {
    const token = oauth(request); if (token) return token;
    expect(request.method).toBe('GET');
    const index = intents.findIndex(i => request.url.endsWith(i.provider_reference));
    expect(index).toBeGreaterThanOrEqual(0);
    const result = providerOrder(intents[index], index === 1 ? 'APPROVED' : index === 2 ? 'PENDING' : 'COMPLETED', index === 3 ? '9.00' : '10.00');
    if (index === 0) result.id = 'WRONGORDER';
    return Response.json(result);
  }, () => withPolling(intents.map(i => i.id), async () => {
    const { results } = await poll();
    expect(results).toHaveLength(4);
    expect(results).toEqual(expect.arrayContaining([
      { payment_intent_id: intents[0].id, status: 'retry_required' },
      { payment_intent_id: intents[1].id, status: 'awaiting_capture', provider_status: 'APPROVED' },
      { payment_intent_id: intents[2].id, status: 'processed', outcome: 'processing' },
      { payment_intent_id: intents[3].id, status: 'processed', outcome: 'action_required' },
    ]));
    expect((await poll()).results).toEqual([]);
  }));
  expect(await stockOf(fixture.sku)).toBe(before);
  for (let i = 0; i < 4; i++) {
    const rows = await database`select amount::text,reconciliation_status from commerce.provider_money_movements where payment_intent_id=${intents[i].id}::uuid`;
    expect(rows).toEqual(i === 3 ? [{ amount: '9.00000000', reconciliation_status: 'action_required' }] : []);
  }
});

test('已过期且意图取消仍查询迟到 Capture：保留资金，不复活订单或扣库存', async () => {
  const buyer = await signup();
  const order = await fixtureOrder(fixture, buyer);
  const intent = await fixtureIntent(order, buyer);
  await prepare(intent, buyer);
  // Only this fixture is expired; no global future-as_of worker drains other tests.
  await database.begin(async tx => {
    await tx`update commerce.checkout_quotes set status='expired' where id=${order.quoteId}::uuid`;
    await tx`update public.orders set status='cancelled',cancelled_at=now() where id=${order.id}::uuid`;
    await tx`update commerce.payment_intents set status='cancelled' where id=${intent.id}::uuid`;
  });
  const before = await stockOf(fixture.sku);
  await withPaymentProviderMock(request => {
    const token = oauth(request); if (token) return token;
    expect(request.method).toBe('GET');
    return Response.json(providerOrder(intent));
  }, () => withPolling([intent.id], async () => {
    expect((await poll()).results).toEqual([{ payment_intent_id: intent.id, status: 'processed', outcome: 'action_required' }]);
    // Even after cooldown the durable money fact excludes further provider polls.
    await database`update commerce.payment_intents set last_provider_poll_at=clock_timestamp()-interval '6 minutes' where id=${intent.id}::uuid`;
    expect((await poll()).results).toEqual([]);
  }));
  expect(await stockOf(fixture.sku)).toBe(before);
  expect((await database`select status,financial_status from public.orders where id=${order.id}::uuid`)[0]).toEqual({ status: 'cancelled', financial_status: 'pending' });
});

test('创建接口发现 Capture 但数据库暂时失败：明确待对账，Inbox 原样重试后只入账一次', async () => {
  const buyer = await signup();
  const order = await fixtureOrder(fixture, buyer);
  const key = crypto.randomUUID();
  let intent: FixtureIntent;
  let completed = false;
  const before = await stockOf(fixture.sku);
  await withPaymentProviderMock(async request => {
    const token = oauth(request); if (token) return token;
    if (request.method === 'POST') {
      const body = await request.json();
      intent = { id: body.purchase_units[0].custom_id, order_id: order.id, provider: 'paypal', status: 'requires_action', amount: 10, currency: 'USD', provider_reference: `ORDER${crypto.randomUUID()}` };
    }
    return Response.json(providerOrder(intent!, completed ? 'COMPLETED' : 'APPROVED'));
  }, async () => {
    const request = () => paymentRequest({ order_id: order.id, idempotency_key: key }, buyer.token);
    expect((await handlePayPalCreateOrder(request())).status).toBe(200);
    await prepare(intent!, buyer);
    completed = true;
    // A fixture-scoped real settlement failure is visible to HTTP transactions.
    // Never disable existing triggers; remove the injection even on assertion failure.
    await database.unsafe(`create function private.test_capture_recovery_fault() returns trigger language plpgsql set search_path='' as $$
      begin if new.order_id='${order.id}'::uuid then raise exception 'test capture recovery' using errcode='55P03'; end if; return new; end $$`);
    try {
      await database.unsafe('create trigger test_capture_recovery_fault before insert on commerce.payment_transactions for each row execute function private.test_capture_recovery_fault()');
      const response = await handlePayPalCreateOrder(request());
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: 'transient_database_error', pending_reconciliation: true });
      expect(await stockOf(fixture.sku)).toBe(before);
      expect((await database`select count(*)::int n from commerce.provider_money_movements where payment_intent_id=${intent!.id}::uuid`)[0].n).toBe(1);
      // The money fact hands recovery to Inbox, not repeated provider polling.
      await withPolling([intent!.id], async () => { expect((await poll()).results).toEqual([]); });
    } finally {
      await database.unsafe('drop trigger if exists test_capture_recovery_fault on commerce.payment_transactions');
      await database.unsafe('drop function private.test_capture_recovery_fault()');
    }
    // Retry the persisted envelope directly, without another provider request.
    const events = await database`select id from commerce.payment_provider_events where object_reference=${`CAPTURE${intent!.id}`}`;
    expect(events).toHaveLength(1);
    await database.begin(async tx => {
      await tx`select set_config('request.jwt.claims','{"role":"service_role"}',true)`;
      await tx`update commerce.payment_provider_events set next_attempt_at=clock_timestamp()-interval '1 second' where id=${events[0].id}::uuid`;
      for (let i = 0; i < 2; i++) await tx`select private.process_payment_provider_event(${events[0].id}::uuid)`;
    });
    expect((await database`select status,outcome from commerce.payment_provider_events where id=${events[0].id}::uuid`)[0]).toEqual({ status: 'processed', outcome: 'captured' });
  });
  expect(await stockOf(fixture.sku)).toBe(before - 1);
});

for (const failure of ['declined', 'timeout'] as const) test(`Capture ${failure} 保留发送标记和原意图，不伪造终态或新扣款`, async () => {
  const buyer = await signup();
  const order = await fixtureOrder(fixture, buyer);
  const intent = await fixtureIntent(order, buyer);
  await withPaymentProviderMock(request => {
    const token = oauth(request); if (token) return token;
    if (request.method === 'GET') return Response.json(providerOrder(intent, 'APPROVED'));
    if (failure === 'timeout') throw new Error('network timeout');
    return Response.json({ details: [{ issue: 'INSTRUMENT_DECLINED' }] }, { status: 422 });
  }, async () => {
    const response = await handlePayPalCaptureOrder(paymentRequest({ payment_intent_id: intent.id }, buyer.token));
    expect(response.status).toBe(failure === 'declined' ? 422 : 502);
    expect(await response.json()).toMatchObject({ error: { code: failure === 'declined' ? 'instrument_declined' : 'paypal_unavailable' } });
  });
  expect((await database`select status,provider_capture_requested_at is not null as dispatched from commerce.payment_intents where id=${intent.id}::uuid`)[0]).toEqual({ status: 'processing', dispatched: true });
  expect((await database`select count(*)::int n from commerce.payment_transactions where order_id=${order.id}::uuid`)[0].n).toBe(0);
});
