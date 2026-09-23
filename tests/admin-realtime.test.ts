import { afterAll, expect, test } from 'bun:test';
import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import { API, ANON_KEY, api, checked, rpc, signup, makeAdmin } from './helpers';
import { testDatabase } from './database-concurrency';

const db = testDatabase();
const clients: SupabaseClient[] = [];
const users: string[] = [],
  categories: string[] = [],
  products: string[] = [];
const project = `realtime-${crypto.randomUUID()}`;
afterAll(async () => {
  for (const client of clients) await client.removeAllChannels();
  for (const id of products) await db`delete from public.products where id=${id}::uuid`;
  for (const id of categories) await db`delete from public.categories where id=${id}::uuid`;
  await db`delete from private.mcp_tool_audit where project=${project}`;
  for (const id of users)
    await checked(api(`/auth/v1/admin/users/${id}`, { service: true, method: 'DELETE' }));
  await db.close();
});
async function account(admin = false) {
  const user = await signup();
  users.push(user.userId);
  if (admin) await makeAdmin(user.userId);
  return user;
}
async function join(topic: string, token?: string, privateChannel = true) {
  const client = createClient(API, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  clients.push(client);
  await client.realtime.setAuth(token ?? ANON_KEY);
  const messages: Record<string, unknown>[] = [];
  const channel: RealtimeChannel = client.channel(topic, {
    config: { private: privateChannel, broadcast: { ack: true } },
  });
  channel.on('broadcast', { event: 'invalidate' }, (message) => messages.push(message.payload));
  const state = await new Promise<string>((resolve) => {
    const timer = setTimeout(() => resolve('NO_RESPONSE'), 8000);
    channel.subscribe((state) => {
      if (['SUBSCRIBED', 'CHANNEL_ERROR', 'TIMED_OUT'].includes(state)) {
        clearTimeout(timer);
        resolve(state);
      }
    });
  });
  return { client, channel, state, messages };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= deadline) throw Error('Realtime notification not received');
    await Bun.sleep(20);
  }
}
test('product invalidation covers list sources without exposing rows or accepting non-admin subscriptions', async () => {
  const admin = await account(true),
    customer = await account();
  const allowed = await join('admin:products', admin.token);
  expect(allowed.state).toBe('SUBSCRIBED');
  expect((await join('admin:products', customer.token)).state).toBe('CHANNEL_ERROR');
  expect((await join('admin:products')).state).toBe('CHANNEL_ERROR');
  const id = crypto.randomUUID(),
    category = crypto.randomUUID();
  products.push(id);
  categories.push(category);
  await db`insert into public.categories(id,name,slug) values(${category}::uuid,'private',${category})`;
  await expect(
    db.begin(async (tx) => {
      await tx`insert into public.products(id,name,slug) values(${id}::uuid,'rolled back',${id})`;
      throw Error('rollback');
    }),
  ).rejects.toThrow('rollback');
  await Bun.sleep(300);
  expect(allowed.messages).toHaveLength(0);
  const operations = [
    () => db`insert into public.products(id,name,slug) values(${id}::uuid,'private',${id})`,
    () => db`insert into public.product_variants(product_id,price) values(${id}::uuid,13.27)`,
    () =>
      db`insert into public.product_images(product_id,url) values(${id}::uuid,'https://example.test/private.png')`,
    () =>
      db`insert into public.product_categories(product_id,category_id) values(${id}::uuid,${category}::uuid)`,
    () => db`update public.products set name='renamed' where id=${id}::uuid`,
    () => db`update public.product_variants set price=29.31 where product_id=${id}::uuid`,
    () => db`update public.product_images set position=3 where product_id=${id}::uuid`,
    () => db`update public.product_categories set category_id=${category}::uuid where product_id=${id}::uuid`,
    () => db`delete from public.product_categories where product_id=${id}::uuid`,
    () => db`delete from public.product_images where product_id=${id}::uuid`,
    () => db`delete from public.product_variants where product_id=${id}::uuid`,
    () => db`delete from public.products where id=${id}::uuid`,
  ];
  for (const change of operations) {
    const before = allowed.messages.length;
    await change();
    await until(() => allowed.messages.length > before);
    await Bun.sleep(100);
  }
  for (const value of allowed.messages) expect(Object.keys(value)).toEqual(['id']);
  await db`update public.profiles set role='customer' where id=${admin.userId}::uuid`;
  expect((await rpc('list_admin_products', {}, admin.token)).status).toBe(403);
  expect((await join('admin:products', admin.token)).state).toBe('CHANNEL_ERROR');
}, 30000);

test('private category broadcast is commit-only and payload-free; customers and demoted joins are denied', async () => {
  const admin = await account(true),
    customer = await account();
  const allowed = await join('admin:categories', admin.token);
  expect(allowed.state).toBe('SUBSCRIBED');
  expect((await join('admin:categories', customer.token)).state).toBe('CHANNEL_ERROR');
  expect((await join('admin:categories')).state).toBe('CHANNEL_ERROR');
  const publicChannel = await join('admin:categories', undefined, false);
  expect(publicChannel.state).toBe('SUBSCRIBED');
  const id = crypto.randomUUID();
  categories.push(id);
  await expect(
    db.begin(async (tx) => {
      await tx`insert into public.categories(id,name,slug) values(${id}::uuid,'Rolled back private name',${id})`;
      throw Error('rollback fixture');
    }),
  ).rejects.toThrow('rollback fixture');
  await checked(
    rpc(
      'create_category',
      { category_id: id, changes: { name: 'Secret admin category', slug: id, is_active: false } },
      admin.token,
    ),
  );
  // create_category commits an INSERT and an UPDATE; the rolled-back INSERT
  // must not add a third notification. Consumers must coalesce this burst.
  await until(() => allowed.messages.length >= 2);
  await Bun.sleep(200);
  expect(allowed.messages).toHaveLength(2);
  expect(Object.keys(allowed.messages[0])).toEqual(['id']);
  expect(JSON.stringify(allowed.messages)).not.toContain('Secret');
  expect(publicChannel.messages).toHaveLength(0);
  const send = await allowed.channel.send({
    type: 'broadcast',
    event: 'invalidate',
    payload: { forged: true },
  });
  expect(send).not.toBe('ok');
  expect(allowed.messages.some((m) => m.forged)).toBe(false);
  await checked(
    api(`/rest/v1/profiles?id=eq.${admin.userId}`, {
      method: 'PATCH',
      service: true,
      body: { role: 'customer' },
    }),
  );
  expect((await rpc('get_admin_category', { category_id: id }, admin.token)).status).toBe(403);
  expect((await join('admin:categories', admin.token)).state).toBe('CHANNEL_ERROR');
  // Existing channel permissions can be cached; never assume instant revocation.
}, 30000);

test('personal call notifications isolate even other admins and remain available after demotion', async () => {
  const owner = await account(true),
    other = await account(true);
  const own = await join(`admin:calls:${owner.userId}`, owner.token);
  const theirs = await join(`admin:calls:${other.userId}`, other.token);
  expect(own.state).toBe('SUBSCRIBED');
  expect(theirs.state).toBe('SUBSCRIBED');
  expect((await join(`admin:calls:${owner.userId}`, other.token)).state).toBe('CHANNEL_ERROR');
  const call = crypto.randomUUID();
  await db`insert into private.mcp_tool_audit(id,user_id,grant_id,client_id,issuer,resource,project,tool_name,mutation)
    values(${call}::uuid,${owner.userId}::uuid,${crypto.randomUUID()}::uuid,'private-client','https://auth.example','https://shop.example/mcp',${project},'create_category',true)`;
  await until(() => own.messages.length === 1);
  await db`update private.mcp_tool_audit set outcome='returned',finished_at=clock_timestamp() where id=${call}::uuid`;
  await until(() => own.messages.length === 2);
  for (const message of own.messages) expect(Object.keys(message)).toEqual(['id']);
  expect(theirs.messages).toHaveLength(0);
  await checked(
    api(`/rest/v1/profiles?id=eq.${owner.userId}`, {
      method: 'PATCH',
      service: true,
      body: { role: 'customer' },
    }),
  );
  expect((await join(`admin:calls:${owner.userId}`, owner.token)).state).toBe('SUBSCRIBED');
  const history = await checked<{ items: { id: string }[] }>(rpc('list_my_mcp_tool_calls', {}, owner.token));
  expect(history.items.map((item) => item.id)).toContain(call);
}, 30000);
