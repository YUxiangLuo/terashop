import { afterAll, expect, test } from 'bun:test';
import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import { API, ANON_KEY, api, checked, rpc, signup, makeAdmin, TEST_ADDRESS } from './helpers';
import { testDatabase } from './database-concurrency';
import { stockedProduct } from './support/catalog';
import { Cleanup } from './support/cleanup';

const db = testDatabase();
const clients: SupabaseClient[] = [];
const users: string[] = [];

afterAll(async () => {
  for (const client of clients) await client.removeAllChannels();
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

async function join(topic: string, token?: string) {
  const client = createClient(API, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
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
    if (Date.now() >= deadline) throw Error('Realtime notification not received');
    await Bun.sleep(20);
  }
}

test('migration declares every authoritative source as a fixed statement trigger', async () => {
  const sql = await Bun.file('supabase/migrations/20260923000008_admin_domain_realtime.sql').text();
  const coverage: Record<string, string[]> = {
    'admin:orders': [
      'public.orders',
      'public.order_items',
      'public.order_events',
      'public.order_promotions',
      'commerce.order_adjustments',
      'commerce.order_shipping_lines',
      'commerce.order_tax_lines',
      'commerce.order_discount_allocations',
      'public.fulfillments',
      'commerce.fulfillment_lines',
      'commerce.refunds',
      'commerce.refund_lines',
      'commerce.refund_components',
      'commerce.returns',
      'commerce.return_lines',
      'commerce.return_receipts',
      'commerce.return_receipt_lines',
      'commerce.return_dispositions',
      'commerce.payment_intents',
      'commerce.payment_transactions',
      'commerce.refund_requests',
      'commerce.refund_request_lines',
      'commerce.refund_request_components',
    ],
    'admin:quotes': ['commerce.checkout_quotes', 'commerce.checkout_quote_lines'],
    'admin:customers': ['public.customers', 'public.profiles', 'public.addresses'],
    'admin:configuration': [
      'public.locations',
      'public.shipping_methods',
      'public.tax_rates',
      'public.promotions',
      'public.promotion_targets',
      'private.shop_settings',
    ],
    'admin:operations': [
      'commerce.payment_provider_events',
      'commerce.payment_intents',
      'commerce.payment_transactions',
      'commerce.provider_money_movements',
      'commerce.refund_requests',
      'commerce.outbox_events',
      'commerce.refund_request_lines',
      'commerce.refund_request_components',
      'commerce.outbox_redrives',
    ],
  };
  for (const [topic, tables] of Object.entries(coverage))
    for (const table of tables)
      expect(sql).toMatch(
        new RegExp(
          `after insert or update or delete on ${table.replace('.', '\\.')}` +
            ` for each statement execute function private\\.notify_admin_domain\\('${topic}'\\)`,
        ),
      );
  for (const table of [
    'public.product_options',
    'public.product_option_values',
    'public.variant_option_values',
  ])
    expect(sql).toMatch(
      new RegExp(
        `on ${table.replace('.', '\\.')} for each statement execute function private\\.notify_admin_products\\(\\)`,
      ),
    );
  expect(sql).toContain("realtime.send('{}'::jsonb, 'invalidate', tg_argv[0], true)");
  expect(sql).toContain("security definer set search_path = ''");
  expect(sql).toContain('revoke all on function private.notify_admin_domain()');
  const extra = await db<
    { tgname: string; definition: string }[]
  >`select tgname,pg_get_triggerdef(oid) as definition from pg_trigger
    where tgname in ('admin_configuration_redemptions','admin_orders_provider_movements')`;
  expect(extra).toHaveLength(2);
  expect(extra.find((row) => row.tgname === 'admin_configuration_redemptions')?.definition).toContain(
    "notify_admin_domain('admin:configuration')",
  );
  expect(extra.find((row) => row.tgname === 'admin_orders_provider_movements')?.definition).toContain(
    "notify_admin_domain('admin:orders')",
  );
});

test('domain channels are admin-only, commit-only and payload-free for representative mutations', async () => {
  const cleanup = new Cleanup();
  const admin = await account(true),
    buyer = await account();
  const topics = [
    'admin:orders',
    'admin:quotes',
    'admin:customers',
    'admin:configuration',
    'admin:operations',
  ];
  try {
    const allowed = Object.fromEntries(
      await Promise.all(topics.map(async (topic) => [topic, await join(topic, admin.token)])),
    );
    await Promise.all(
      topics.map(async (topic) => {
        expect(allowed[topic].state).toBe('SUBSCRIBED');
        expect((await join(topic, buyer.token)).state).toBe('CHANNEL_ERROR');
        expect((await join(topic)).state).toBe('CHANNEL_ERROR');
      }),
    );
    await expect(
      db.begin(async (tx) => {
        await tx`update private.shop_settings set name=name where singleton`;
        throw Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    await Bun.sleep(300);
    expect(allowed['admin:configuration'].messages).toHaveLength(0);

    await db`update private.shop_settings set updated_at=clock_timestamp() where singleton`;
    await until(() => allowed['admin:configuration'].messages.length > 0);
    await db`update public.profiles set updated_at=clock_timestamp() where id=${buyer.userId}::uuid`;
    await until(() => allowed['admin:customers'].messages.length > 0);

    const product = await stockedProduct(admin, { trackInventory: false, cleanup, label: 'domain-realtime' });
    const quote = await checked<{ id: string }>(
      rpc(
        'create_checkout_quote',
        {
          items: [{ variant_id: product.variantId, quantity: 1 }],
          address: TEST_ADDRESS,
          idempotency_key: crypto.randomUUID(),
        },
        buyer.token,
      ),
    );
    await until(() => allowed['admin:quotes'].messages.length > 0);
    await checked(rpc('create_order_from_quote', { quote_id: quote.id }, buyer.token));
    await until(() => allowed['admin:orders'].messages.length > 0);
    await until(() => allowed['admin:operations'].messages.length > 0);

    for (const topic of topics)
      for (const payload of allowed[topic].messages) expect(Object.keys(payload)).toEqual(['id']);
  } finally {
    await cleanup.run();
  }
}, 60000);
