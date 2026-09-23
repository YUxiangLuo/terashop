import { afterAll, expect, test } from 'bun:test';
import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import { API, ANON_KEY, api, checked, makeAdmin, signup } from './helpers';
import { testDatabase } from './database-concurrency';

const db = testDatabase();
const clients: SupabaseClient[] = [];
const users: string[] = [];
const grants: string[] = [];

afterAll(async () => {
  for (const client of clients) await client.removeAllChannels();
  for (const id of grants) await db`delete from private.mcp_grants where id=${id}::uuid`;
  for (const id of users)
    await checked(api(`/auth/v1/admin/users/${id}`, { service: true, method: 'DELETE' }));
  await db.close();
});

async function account() {
  const user = await signup();
  users.push(user.userId);
  await makeAdmin(user.userId);
  return user;
}

async function join(topic: string, token?: string) {
  const client = createClient(API, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  clients.push(client);
  await client.realtime.setAuth(token ?? ANON_KEY);
  const messages: Record<string, unknown>[] = [];
  const channel: RealtimeChannel = client.channel(topic, {
    config: { private: true, broadcast: { ack: true } },
  });
  channel.on('broadcast', { event: 'invalidate' }, ({ payload }) => messages.push(payload));
  const state = await new Promise<string>((resolve) => {
    const timer = setTimeout(() => resolve('NO_RESPONSE'), 8000);
    channel.subscribe((value) => {
      if (['SUBSCRIBED', 'CHANNEL_ERROR', 'TIMED_OUT'].includes(value)) {
        clearTimeout(timer);
        resolve(value);
      }
    });
  });
  return { channel, state, messages };
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= deadline) throw Error('Realtime connection notification not received');
    await Bun.sleep(20);
  }
}

test('personal connection changes are isolated, payload-free, and available after demotion', async () => {
  const owner = await account();
  const other = await account();
  const own = await join(`admin:connections:${owner.userId}`, owner.token);
  const theirs = await join(`admin:connections:${other.userId}`, other.token);
  expect(own.state).toBe('SUBSCRIBED');
  expect(theirs.state).toBe('SUBSCRIBED');
  expect((await join(`admin:connections:${owner.userId}`, other.token)).state).toBe('CHANNEL_ERROR');
  expect((await join(`admin:connections:${owner.userId}`)).state).toBe('CHANNEL_ERROR');

  const grant = crypto.randomUUID();
  grants.push(grant);
  await db`insert into private.mcp_grants(id,binding,user_id,scopes)
    values(${grant}::uuid,${JSON.stringify({ project: grant, client_id: 'private client' })}::text::jsonb,${owner.userId}::uuid,array['store:read'])`;
  await until(() => own.messages.length >= 1);
  let before = own.messages.length;
  await db`update private.mcp_grants set downstream_session_id=${crypto.randomUUID()}::uuid where id=${grant}::uuid`;
  await until(() => own.messages.length > before);

  // Credential envelope churn is intentionally not a connection-list event.
  before = own.messages.length;
  await db`insert into private.mcp_credentials(grant_id,revision,envelope) values(${grant}::uuid,1,'{}'::jsonb)`;
  await db`update private.mcp_credentials set revision=2,envelope='{"changed":true}'::jsonb where grant_id=${grant}::uuid`;
  await Bun.sleep(300);
  expect(own.messages).toHaveLength(before);

  await db`insert into private.mcp_connection_revocations(grant_id) values(${grant}::uuid)`;
  await until(() => own.messages.length > before);
  before = own.messages.length;
  await db`update private.mcp_connection_revocations set completed_at=clock_timestamp() where grant_id=${grant}::uuid`;
  await until(() => own.messages.length > before);
  before = own.messages.length;
  await db`delete from private.mcp_connection_revocations where grant_id=${grant}::uuid`;
  await until(() => own.messages.length > before);

  expect(theirs.messages).toHaveLength(0);
  for (const message of own.messages) expect(Object.keys(message)).toEqual(['id']);
  const sent = await own.channel.send({ type: 'broadcast', event: 'invalidate', payload: { forged: true } });
  expect(sent).not.toBe('ok');

  await db`update public.profiles set role='customer' where id=${owner.userId}::uuid`;
  expect((await join(`admin:connections:${owner.userId}`, owner.token)).state).toBe('SUBSCRIBED');

  // Keep cleanup present so grant deletion cascades it; the grant trigger must
  // still route using OLD.user_id after cleanup can no longer resolve an owner.
  before = own.messages.length;
  await db`insert into private.mcp_connection_revocations(grant_id) values(${grant}::uuid)`;
  await until(() => own.messages.length > before);
  before = own.messages.length;
  await db`delete from private.mcp_grants where id=${grant}::uuid`;
  await until(() => own.messages.length > before);
  grants.splice(grants.indexOf(grant), 1);
  expect(theirs.messages).toHaveLength(0);
}, 30000);
