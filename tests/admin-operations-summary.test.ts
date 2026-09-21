import { afterAll, beforeAll, expect, test } from 'bun:test';
import { AdminBackend } from '../mcp/src/backend';
import { API, ANON_KEY, checked, rpc, signup, makeAdmin, type TestUser } from './helpers';
import { mcpSession, toolData } from './support/mcp';
import { testDatabase } from './database-concurrency';
import { withRollback } from '../scripts/lib/transactions';

const db = testDatabase();
let admin: TestUser, buyer: TestUser, session: Awaited<ReturnType<typeof mcpSession>>;
const range = { start_at: '1906-01-01T00:00:00Z', end_at: '1906-02-01T00:00:00Z' };
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

test('队列诊断遵守重投预算与租约，三个组件隔离，不将终态/区间外事件当积压', async () => {
  await withRollback(db, async (tx) => {
    await tx`select set_config('request.jwt.claims','{"role":"service_role"}',true)`;
    for (const [status, attempts, retry, due] of [
      ['pending', 0, 0, true],
      ['pending', 0, 0, false],
      ['failed', 25, 25, true],
      ['failed', 25, 0, true],
      ['processing', 24, 0, true],
      ['processing', 25, 0, true],
      ['processing', 25, 0, false],
      ['exhausted', 25, 0, true],
      ['published', 25, 0, true],
    ] as const) {
      const id = crypto.randomUUID();
      await tx`insert into commerce.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,status,attempts,retry_start,
        available_at,locked_at,locked_by,lease_token,lease_expires_at,created_at)
        values('test',${id}::uuid,'test',${id},${status},${attempts},${retry},${due ? '1900-01-01' : '9999-01-01'}::timestamptz,
        ${status === 'processing' ? '1899-01-01' : null}::timestamptz,${status === 'processing' ? 'private-worker' : null},
        ${status === 'processing' ? id : null}::uuid,${status === 'processing' ? (due ? '1900-01-01' : '9999-01-01') : null}::timestamptz,'1906-01-01')`;
    }
    const [outbox] =
      await tx`select public.get_admin_operations_summary('outbox',${range.start_at}::timestamptz,${range.end_at}::timestamptz) as data`;
    expect(outbox.data).toMatchObject({
      unresolved_count: '8',
      status_counts: { pending: '2', failed: '2', processing: '3', exhausted: '1' },
      ready_count: '3',
      expired_lease_count: '2',
      retry_exhausted_count: '3',
      oldest_created_at: '1906-01-01T00:00:00+00:00',
    });
    expect(Object.keys(outbox.data).sort()).toEqual(
      [
        'component',
        'start_at',
        'end_at',
        'observed_at',
        'unresolved_count',
        'status_counts',
        'oldest_created_at',
        'ready_count',
        'expired_lease_count',
        'retry_exhausted_count',
      ].sort(),
    );
    for (const [status, attempts, due, created] of [
      ['received', 24, true, '1906-01-01'],
      ['failed', 24, false, '1906-01-01'],
      ['failed', 25, true, '1906-01-01'],
      ['processed', 25, true, '1906-01-01'],
      ['ignored', 25, true, '1906-01-01'],
      ['received', 0, true, '1906-02-01'],
    ] as const) {
      const id = crypto.randomUUID();
      await tx`insert into commerce.payment_provider_events(id,provider,provider_event_id,source,event_type,livemode,occurred_at,payload_hash,
        status,attempts,next_attempt_at,processed_at,created_at) values(${id}::uuid,'paypal',${id},'webhook','test',false,now(),${'a'.repeat(64)},
        ${status},${attempts},${due ? '1900-01-01' : '9999-01-01'}::timestamptz,${status === 'processed' || status === 'ignored' ? '1906-01-02' : null}::timestamptz,${created}::timestamptz)`;
      if (status === 'processed' || status === 'ignored') {
        await tx`insert into commerce.provider_money_movements(provider_event_id,provider,kind,provider_reference,amount,currency,reconciliation_status,created_at)
            values(${id}::uuid,'paypal','capture',${crypto.randomUUID()},1,'EUR',${status === 'processed' ? 'unmatched' : 'action_required'},'1906-01-01')`;
      }
    }
    const [inbox] =
      await tx`select public.get_admin_operations_summary('inbox',${range.start_at}::timestamptz,${range.end_at}::timestamptz) as data`;
    expect(inbox.data).toMatchObject({
      unresolved_count: '3',
      status_counts: { received: '1', failed: '2' },
      ready_count: '1',
      retry_exhausted_count: '1',
      expired_lease_count: null,
    });
    const [money] =
      await tx`select public.get_admin_operations_summary('reconciliation',${range.start_at}::timestamptz,${range.end_at}::timestamptz) as data`;
    expect(money.data).toMatchObject({
      unresolved_count: '2',
      status_counts: { unmatched: '1', action_required: '1' },
      ready_count: null,
      retry_exhausted_count: null,
      expired_lease_count: null,
    });
  });
});

test('MCP 空概览及 RPC 权限和参数校验，不输出整体健康结论', async () => {
  for (const component of ['outbox', 'inbox', 'reconciliation']) {
    const args = { component, ...range };
    const data = await toolData<Record<string, unknown>>(
      session.client,
      'get_admin_operations_summary',
      args,
    );
    expect(data).toMatchObject({
      component,
      unresolved_count: '0',
      status_counts: {},
      oldest_created_at: null,
    });
    expect(data).not.toHaveProperty('healthy');
    expect(
      await checked<Record<string, unknown>>(rpc('get_admin_operations_summary', args, undefined, true)),
    ).toMatchObject({ component, unresolved_count: '0' });
  }
  for (const token of [undefined, buyer.token])
    expect(
      (await rpc('get_admin_operations_summary', { component: 'outbox', ...range }, token)).data,
    ).toMatchObject({ code: '42501' });
  for (const patch of [
    { component: null },
    { component: 'database' },
    { start_at: null },
    { end_at: 'infinity' },
    { end_at: range.start_at },
    { start_at: range.end_at },
    { end_at: '1906-02-01T00:00:00.000001Z' },
  ])
    expect(
      (await rpc('get_admin_operations_summary', { component: 'outbox', ...range, ...patch }, admin.token))
        .data,
    ).toMatchObject({ code: '22023' });
});

test('10000 条可统计，10001 条拒绝返回截断积压', async () => {
  await withRollback(db, async (tx) => {
    await tx`select set_config('request.jwt.claims','{"role":"service_role"}',true)`;
    await tx`insert into commerce.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,created_at)
      select 'test',gen_random_uuid(),'test',gen_random_uuid()::text,
        '1907-01-01'::timestamptz+case when i=10001 then interval '1 day' else interval '0' end from generate_series(1,10001) i`;
    const [row] =
      await tx`select public.get_admin_operations_summary('outbox','1907-01-01','1907-01-02') as data`;
    expect(row.data.unresolved_count).toBe('10000');
    await expect(
      tx.savepoint(async (sp) => {
        await sp`select public.get_admin_operations_summary('outbox','1907-01-01','1907-01-03')`;
      }),
    ).rejects.toMatchObject({ errno: 'PT422' });
  });
});
