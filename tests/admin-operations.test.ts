import { afterAll, beforeAll, expect, test } from 'bun:test';
import { API, ANON_KEY, checked, makeAdmin, rpc, setRole, signup, type TestUser } from './helpers';
import { AdminBackend } from '../mcp/src/backend';
import { mcpSession, toolData } from './support/mcp';
import type { Database } from '../types/database';
import { heldTransactionRace, testDatabase } from './database-concurrency';

const database = testDatabase();
let admin: TestUser, other: TestUser, customer: TestUser;
let session: Awaited<ReturnType<typeof mcpSession>>;
beforeAll(async () => {
  admin = await signup(); other = await signup(); customer = await signup();
  await makeAdmin(admin.userId); await makeAdmin(other.userId);
  session = await mcpSession(new AdminBackend({ url: API, anonKey: ANON_KEY, accessToken: admin.token }), true);
});
afterAll(async () => { try { await session?.close(); } finally { await database.close(); } });
type Page = { items: ({ id: string } & Record<string, unknown>)[]; next_after_id?: string | null; next_cursor?: object | null };
const outbox = (args: Database['public']['Functions']['list_admin_outbox_events']['Args']) =>
  toolData<Page>(session.client, 'list_admin_outbox_events', args);
const inbox = (args: Record<string, unknown>) => toolData<Page>(session.client, 'list_admin_payment_provider_events', args);

test('Outbox 按状态和归属分页，不泄露 payload、原始错误、操作键或租约凭据', async () => {
  const aggregate = crypto.randomUUID(), ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const event = crypto.randomUUID(); ids.push(event);
    await database`insert into commerce.outbox_events(event_id,aggregate_type,aggregate_id,event_type,payload,idempotency_key,status,attempts,last_error)
      values (${event}::uuid,'test',${aggregate}::uuid,'test','{"secret":"private-payload"}',${event},'exhausted',25,'private-error')`;
  }
  const args = { aggregate_id: aggregate, status_filter: 'exhausted', page_size: 2 };
  const first = await outbox(args);
  expect(first.items.map(e => e.event_id)).toEqual([ids[2], ids[1]]);
  expect(first.next_after_id).toBe(first.items[1].id);
  const last = await outbox({ ...args, after_id: first.next_after_id! });
  expect(last.items.map(e => e.event_id)).toEqual([ids[0]]);
  expect(last.next_after_id).toBeNull();
  expect((await outbox({ ...args, status_filter: 'published' })).items).toEqual([]);
  expect(first.items[0]).toMatchObject({ has_error: true, attempts: 25, last_redrive: null });
  for (const key of ['payload','last_error','lease_token','idempotency_key','locked_by']) expect(first.items[0]).not.toHaveProperty(key);
  expect(JSON.stringify(first)).not.toContain('private-');
});

test('Outbox 超过 JS 安全整数的游标按字符串通过生成类型往返，不漏相邻记录', async () => {
  const aggregate = crypto.randomUUID();
  const base = 9007199254740992n + BigInt(crypto.getRandomValues(new Uint32Array(1))[0]) * 4n;
  const ids = [base, base + 1n, base + 2n].map(String);
  for (const id of ids) {
    const event = crypto.randomUUID();
    await database`insert into commerce.outbox_events(id,event_id,aggregate_type,aggregate_id,event_type,idempotency_key,status,attempts)
      overriding system value values (${id}::bigint,${event}::uuid,'test',${aggregate}::uuid,'test',${event},'exhausted',25)`;
  }
  const args = { aggregate_id: aggregate, page_size: 2 };
  const first = await outbox(args);
  expect(first.items.map(e => e.id)).toEqual([ids[2], ids[1]]);
  expect(first.next_after_id).toBe(ids[1]);
  const last = await outbox({ ...args, after_id: first.next_after_id! });
  expect(last.items.map(e => e.id)).toEqual([ids[0]]);
  expect(last.next_after_id).toBeNull();
  for (const after_id of ['', '0', '-1', '1.5', 'abc', '9223372036854775808']) {
    expect((await rpc('list_admin_outbox_events', { after_id }, admin.token)).data).toMatchObject({ code: '22023' });
  }
});

test('Inbox 同时间戳游标不漏不重，25 次界限只标记未终结事件，不暴露渠道正文', async () => {
  const resource = crypto.randomUUID(), ids = Array.from({ length: 3 }, () => crypto.randomUUID()).sort();
  for (const [i, id] of ids.entries()) {
    await database`insert into commerce.payment_provider_events(id,provider,provider_event_id,source,event_type,livemode,
      occurred_at,payload_hash,data,status,attempts,resource_type,resource_id,last_error,created_at,processed_at,next_attempt_at)
      values (${id}::uuid,'paypal',${id},'webhook','test',false,now(),${'a'.repeat(64)},'{"secret":"private-data"}',
      ${i===0 ? 'processed' : 'failed'},${i===1 ? 24 : 25},'payment_intent',${resource}::uuid,'private-error',
      '2026-01-01T00:00:00Z',${i===0 ? '2026-01-01T00:00:00Z' : null}::timestamptz,'infinity')`;
  }
  const args = { resource_id: resource, page_size: 2 };
  const first = await inbox(args), last = await inbox({ ...args, after_cursor: first.next_cursor });
  expect(first.items.map(e => e.id)).toEqual([ids[2],ids[1]]);
  expect(last.items.map(e => e.id)).toEqual([ids[0]]);
  expect(last.next_cursor).toBeNull();
  expect(first.items.map(e => e.automatic_retry_exhausted)).toEqual([true,false]);
  expect(last.items[0].automatic_retry_exhausted).toBe(false);
  expect((await inbox({ ...args, status_filter: 'processed' })).items.map(e => e.id)).toEqual([ids[0]]);
  for (const key of ['data','payload_hash','last_error','object_reference']) expect(first.items[0]).not.toHaveProperty(key);
  expect(JSON.stringify(first)).not.toContain('private-');
});

test('管理员重投真实绑定 actor，同键并发一次审计，成功后的重放不重置 Worker 状态', async () => {
  const event = crypto.randomUUID();
  await database`insert into commerce.outbox_events(event_id,aggregate_type,aggregate_id,event_type,idempotency_key,status,attempts)
    values (${event}::uuid,'test',${event}::uuid,'test',${event},'exhausted',25)`;
  const body = { event_id: event, expected_attempt: 25, reason: 'dependency restored' };
  expect((await rpc('redrive_outbox_event', { ...body, worker_id: 'forged' }, admin.token)).data).toMatchObject({ code: '22023' });
  expect(await checked<boolean>(rpc('redrive_outbox_event', { ...body, expected_attempt: 26 }, admin.token))).toBe(false);
  const result = await heldTransactionRace(database, async tx => {
    await tx`select set_config('request.jwt.claims',${JSON.stringify({ role: 'authenticated', sub: admin.userId })},true)`;
    await tx`select public.redrive_outbox_event(${event}::uuid,25,reason=>'dependency restored')`;
  }, () => rpc('redrive_outbox_event', body, admin.token));
  expect(await checked<boolean>(Promise.resolve(result))).toBe(true);
  expect(await database`select event_id from commerce.outbox_redrives where event_id=${event}::uuid`).toHaveLength(1);
  const page = await outbox({ aggregate_id: event });
  expect(page.items[0]).toMatchObject({ status: 'pending', attempts: 25, retry_start: 25,
    last_redrive: { worker_id: `admin:${admin.userId}`, reason: body.reason } });
  expect((await rpc('redrive_outbox_event', body, other.token)).status).toBe(400);
  expect((await rpc('redrive_outbox_event', { ...body, reason: 'different' }, admin.token)).status).toBe(400);
  const token = crypto.randomUUID();
  await database`update commerce.outbox_events set status='processing',attempts=26,locked_at=clock_timestamp(),locked_by='test',
    lease_token=${token}::uuid,lease_expires_at=clock_timestamp()+interval '1 minute' where event_id=${event}::uuid`;
  expect(await checked<boolean>(rpc('redrive_outbox_event', body, admin.token))).toBe(true);
  expect((await outbox({ aggregate_id: event })).items[0]).toMatchObject({ status: 'processing', attempts: 26 });
  expect(await checked<boolean>(rpc('complete_outbox_event', { event_id: event, worker_id: 'test', lease_token: token, succeeded: true }, undefined, true))).toBe(true);
  expect(await checked<boolean>(rpc('redrive_outbox_event', body, admin.token))).toBe(true);
  expect((await outbox({ aggregate_id: event })).items[0]).toMatchObject({ status: 'published', attempts: 26 });
  await setRole(admin.userId, 'customer');
  try {
    expect((await rpc('redrive_outbox_event', body, admin.token)).status).toBe(403);
    expect((await rpc('list_admin_outbox_events', {}, admin.token)).status).toBe(403);
    expect((await rpc('list_admin_payment_provider_events', {}, admin.token)).status).toBe(403);
  } finally { await makeAdmin(admin.userId); }
});

test('权限和输入验证：管理员不能领取、确认或重跑资金 Inbox，客户不能读运维或重投', async () => {
  for (const name of ['list_admin_outbox_events','list_admin_payment_provider_events']) {
    expect((await rpc(name, {}, customer.token)).status).toBe(403);
    expect((await rpc(name, {})).status).toBe(401);
    for (const body of [{ page_size: 0 }, { page_size: 101 }, { page_size: null }, { status_filter: 'unknown' }]) {
      expect((await rpc(name, body, admin.token)).data).toMatchObject({ code: '22023' });
    }
  }
  expect((await rpc('list_admin_payment_provider_events', { after_cursor: { id: crypto.randomUUID() } }, admin.token)).data).toMatchObject({ code: '22023' });
  expect((await rpc('redrive_outbox_event', { event_id: crypto.randomUUID(), expected_attempt: 25, reason: 'test' }, customer.token)).status).toBe(403);
  expect((await rpc('claim_outbox_events', { worker_id: 'admin' }, admin.token)).status).toBe(403);
  expect((await rpc('complete_outbox_event', { event_id: crypto.randomUUID(), worker_id: 'admin', lease_token: crypto.randomUUID(), succeeded: true }, admin.token)).status).toBe(403);
  expect((await rpc('retry_payment_provider_events', {}, admin.token)).status).toBe(403);
});
