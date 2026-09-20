import { afterAll, beforeAll, expect, test } from 'bun:test';
import { AdminBackend } from '../mcp/src/backend';
import { API, ANON_KEY, checked, rpc, signup, makeAdmin, type TestUser } from './helpers';
import { mcpSession, toolData } from './support/mcp';
import { testDatabase } from './database-concurrency';

const db = testDatabase();
let admin: TestUser, buyer: TestUser, session: Awaited<ReturnType<typeof mcpSession>>;
interface Cursor {
  created_at: string;
  id: string;
}
interface Page {
  items: Array<Record<string, unknown> & { id: string }>;
  next_cursor: Cursor | null;
}
beforeAll(async () => {
  admin = await signup();
  buyer = await signup();
  await makeAdmin(admin.userId);
  session = await mcpSession(new AdminBackend({ url: API, anonKey: ANON_KEY, accessToken: admin.token }));
});
afterAll(async () => {
  await session?.close();
  await db.close();
});
const list = (args: Record<string, unknown>) =>
  toolData<Page>(session.client, 'list_admin_reconciliation_issues', args);

test('无订单资金可发现；最早优先、相同时间 UUID 排序及微秒游标，状态独立且无原始错误', async () => {
  // Append-only fixtures stay in the disposable DB. Future timestamp isolates
  // each invocation from prior test facts without deleting immutable records.
  const base = new Date(Date.now() + 100 * 366 * 86400000).toISOString();
  const ids = Array.from({ length: 4 }, () => crypto.randomUUID()).sort();
  for (const [i, id] of ids.entries()) {
    const event = crypto.randomUUID();
    await db`insert into commerce.payment_provider_events(id,provider,provider_event_id,source,event_type,livemode,occurred_at,payload_hash)
      values(${event}::uuid,'paypal',${event},'webhook','TEST',false,now(),${'a'.repeat(64)})`;
    await db`insert into commerce.provider_money_movements(id,provider_event_id,provider,kind,provider_reference,amount,currency,
      reconciliation_status,last_error,created_at) values(${id}::uuid,${event}::uuid,'paypal','capture',${'secret-' + id},
      '999999999999.12345678','EUR',${i === 3 ? 'action_required' : 'unmatched'},${i === 3 ? 'private-diagnostic' : null},
      ${base}::timestamptz+case when ${i}=2 then interval '2 microseconds' else interval '1 microsecond' end)`;
  }
  const cursor = { created_at: base, id: '00000000-0000-0000-0000-000000000000' };
  const first = await list({ page_size: 1, after_cursor: cursor });
  const second = await list({ page_size: 1, after_cursor: first.next_cursor });
  const third = await list({ page_size: 1, after_cursor: second.next_cursor });
  expect([first.items[0].id, second.items[0].id, third.items[0].id]).toEqual(ids.slice(0, 3));
  expect(third.next_cursor).toBeNull();
  expect(first.next_cursor?.id).toBe(ids[0]);
  const action = await list({ status_filter: 'action_required', after_cursor: cursor });
  expect(action.items.map((x) => x.id)).toEqual([ids[3]]);
  expect(action.items[0]).toMatchObject({
    order_id: null,
    payment_intent_id: null,
    refund_request_id: null,
    has_error: true,
    amount: '999999999999.12345678',
    currency: 'EUR',
  });
  expect(Object.keys(action.items[0]).sort()).toEqual(
    [
      'id',
      'provider_event_id',
      'provider',
      'kind',
      'amount',
      'currency',
      'order_id',
      'payment_intent_id',
      'refund_request_id',
      'reconciliation_status',
      'has_error',
      'created_at',
    ].sort(),
  );
  expect(JSON.stringify(action)).not.toContain('private-diagnostic');
  expect(JSON.stringify(action)).not.toContain('secret-');
  // A status transition between pages is not hidden behind a cached result.
  await db`update commerce.provider_money_movements set reconciliation_status='action_required' where id=${ids[1]}::uuid`;
  expect((await list({ after_cursor: first.next_cursor })).items.map((x) => x.id)).toEqual([ids[2]]);
  expect(
    await checked<Page>(
      rpc('list_admin_reconciliation_issues', { page_size: 1, after_cursor: cursor }, undefined, true),
    ),
  ).toEqual(first);
});

test('RPC 独立权限、状态/页大小和严格游标校验，不能查询已匹配或任意原始载荷', async () => {
  for (const token of [undefined, buyer.token])
    expect((await rpc('list_admin_reconciliation_issues', {}, token)).data).toMatchObject({ code: '42501' });
  for (const args of [
    { page_size: 0 },
    { page_size: 101 },
    { page_size: null },
    { status_filter: null },
    { status_filter: 'matched' },
    { after_cursor: {} },
    { after_cursor: { created_at: 'infinity', id: crypto.randomUUID() } },
    { after_cursor: { created_at: '2026-01-01T00:00:00Z', id: crypto.randomUUID(), extra: true } },
  ])
    expect((await rpc('list_admin_reconciliation_issues', args, admin.token)).data).toMatchObject({
      code: '22023',
    });
  expect(
    await list({ after_cursor: { created_at: '9999-01-01T00:00:00Z', id: crypto.randomUUID() } }),
  ).toEqual({ items: [], next_cursor: null });
});
