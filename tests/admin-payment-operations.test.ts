import { afterAll, beforeAll, expect, test } from 'bun:test';
import { AdminBackend } from '../mcp/src/backend';
import { API, ANON_KEY, checked, rpc, signup, makeAdmin, type TestUser } from './helpers';
import { mcpSession, toolData } from './support/mcp';
import { stockedProduct, archiveProduct } from './support/catalog';
import { fixtureOrder, fixtureIntent, settleIntent } from './payment-fixtures';
import { testDatabase } from './database-concurrency';

const db = testDatabase();
let admin: TestUser, buyer: TestUser, product: Awaited<ReturnType<typeof stockedProduct>>;
let session: Awaited<ReturnType<typeof mcpSession>>;
interface Page {
  items: Array<Record<string, unknown> & { id: string }>;
  next_cursor: string | null;
  order_id: string;
  kind: string;
}
const list = (order_id: string, kind: string, args: Record<string, unknown> = {}) =>
  toolData<Page>(session.client, 'list_admin_payment_operations', { order_id, kind, ...args });
beforeAll(async () => {
  admin = await signup();
  buyer = await signup();
  await makeAdmin(admin.userId);
  product = await stockedProduct(admin, { trackInventory: false });
  session = await mcpSession(new AdminBackend({ url: API, anonKey: ANON_KEY, accessToken: admin.token }));
});
afterAll(async () => {
  try {
    if (product) await archiveProduct(product.productId);
  } finally {
    await session?.close();
    await db.close();
  }
});

test('真实收款与退款请求按订单隔离；白名单 DTO 隐去渠道引用/metadata/错误，金额为字符串', async () => {
  const order = await fixtureOrder(product, buyer),
    other = await fixtureOrder(product, buyer);
  const intent = await fixtureIntent(order, buyer);
  await fixtureIntent(other, buyer);
  await settleIntent(intent);
  await db`update commerce.payment_intents set metadata='{"secret":"DO-NOT-EXPOSE"}' where id=${intent.id}::uuid`;
  const intents = await list(order.id, 'payment_intent');
  expect(intents.items).toHaveLength(1);
  expect(intents.items[0]).toMatchObject({
    id: intent.id,
    status: 'succeeded',
    amount: '10.00',
    currency: 'USD',
    provider_poll_attempts: 0,
  });
  expect(Object.keys(intents.items[0]).sort()).toEqual(
    [
      'id',
      'order_id',
      'provider',
      'status',
      'amount',
      'currency',
      'expires_at',
      'provider_capture_requested_at',
      'last_provider_poll_at',
      'provider_poll_attempts',
      'created_at',
      'updated_at',
    ].sort(),
  );
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const refund = await checked<{ id: string }>(
      rpc(
        'create_refund_request',
        {
          order_id: order.id,
          actor_id: admin.userId,
          provider: 'paypal',
          idempotency_key: crypto.randomUUID(),
          amount: '1.00',
          reason: 'DO-NOT-EXPOSE',
        },
        undefined,
        true,
      ),
    );
    ids.push(refund.id);
  }
  await db`update commerce.refund_requests set failure_code='DO-NOT-EXPOSE',failure_message='DO-NOT-EXPOSE' where id=${ids[0]}::uuid`;
  const first = await list(order.id, 'refund_request', { page_size: 2 });
  const last = await list(order.id, 'refund_request', { page_size: 2, after_id: first.next_cursor });
  expect([...first.items, ...last.items].map((x) => x.id)).toEqual(ids.sort());
  expect(last.next_cursor).toBeNull();
  const refunds = [...first.items, ...last.items];
  expect(refunds.filter((x) => x.has_error === true)).toHaveLength(1);
  expect(refunds.every((x) => x.amount === '1.00' && x.status === 'requested')).toBe(true);
  expect(Object.keys(refunds[0]).sort()).toEqual(
    [
      'id',
      'order_id',
      'parent_transaction_id',
      'provider',
      'status',
      'source',
      'amount',
      'currency',
      'restock_requested',
      'result_refund_id',
      'has_error',
      'submitted_at',
      'processed_at',
      'provider_refund_requested_at',
      'last_provider_poll_at',
      'provider_poll_attempts',
      'created_at',
      'updated_at',
    ].sort(),
  );
  const movements = await list(order.id, 'money_movement');
  expect(movements.items).toHaveLength(1);
  expect(movements.items[0]).toMatchObject({
    kind: 'capture',
    reconciliation_status: 'matched',
    amount: '10.00000000',
    has_error: false,
  });
  expect(Object.keys(movements.items[0]).sort()).toEqual(
    [
      'id',
      'order_id',
      'provider_event_id',
      'provider',
      'kind',
      'amount',
      'currency',
      'payment_intent_id',
      'refund_request_id',
      'payment_transaction_id',
      'reconciliation_status',
      'has_error',
      'matched_at',
      'created_at',
    ].sort(),
  );
  const json = JSON.stringify([intents, first, last, movements]);
  expect(json).not.toContain('DO-NOT-EXPOSE');
  expect(json).not.toContain(intent.provider_reference);
  for (const key of [
    'provider_reference',
    'metadata',
    'idempotency_key',
    'request_hash',
    'failure_message',
    'failure_code',
    'last_error',
    'reason',
  ])
    expect(json).not.toContain(`"${key}"`);
  expect((await list(other.id, 'refund_request')).items).toEqual([]);
});

test('未对账的高精度渠道金额不舍入；任意错误仅返回 has_error，旧接口不变', async () => {
  const order = await fixtureOrder(product, buyer),
    event = crypto.randomUUID(),
    movement = crypto.randomUUID();
  await db`insert into commerce.payment_provider_events(id,provider,provider_event_id,source,event_type,livemode,occurred_at,payload_hash) values(${event}::uuid,'paypal',${event},'webhook','TEST',false,now(),${'a'.repeat(64)})`;
  await db`insert into commerce.provider_money_movements(id,provider_event_id,provider,kind,provider_reference,amount,currency,order_id,last_error,reconciliation_status) values(${movement}::uuid,${event}::uuid,'paypal','capture',${movement},'999999999999.12345678','EUR',${order.id}::uuid,'secret-provider-diagnostic','action_required')`;
  const page = await list(order.id, 'money_movement');
  expect(page.items).toHaveLength(1);
  expect(page.items[0]).toMatchObject({
    id: movement,
    amount: '999999999999.12345678',
    currency: 'EUR',
    reconciliation_status: 'action_required',
    has_error: true,
    payment_transaction_id: null,
  });
  expect(JSON.stringify(page)).not.toContain('secret-provider-diagnostic');
  const legacy = await checked<{ provider_money_movements: Array<{ error: string }> }>(
    rpc('get_payment_operations', { order_id: order.id }, admin.token),
  );
  expect(legacy.provider_money_movements[0].error).toBe('secret-provider-diagnostic');
});

test('RPC 独立鉴权与参数校验，空页不证明订单存在；service 只读兼容', async () => {
  const id = crypto.randomUUID(),
    args = { order_id: id, kind: 'payment_intent' };
  for (const token of [undefined, buyer.token])
    expect((await rpc('list_admin_payment_operations', args, token)).data).toMatchObject({ code: '42501' });
  for (const invalid of [
    { kind: null },
    { kind: 'events' },
    { order_id: null },
    { page_size: 0 },
    { page_size: 101 },
    { page_size: null },
  ])
    expect(
      (await rpc('list_admin_payment_operations', { ...args, ...invalid }, admin.token)).data,
    ).toMatchObject({ code: '22023' });
  const expected = { ...args, items: [], next_cursor: null };
  expect(await list(id, 'payment_intent')).toEqual(expected);
  expect(await checked<Page>(rpc('list_admin_payment_operations', args, undefined, true))).toEqual(expected);
});
