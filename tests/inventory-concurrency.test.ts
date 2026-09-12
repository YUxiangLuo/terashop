import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { api, rpc, signup, makeAdmin, stockOf, TEST_ADDRESS, type TestUser } from './helpers';
import { checked, fixtureIntent, paymentFixture, settleIntent } from './payment-fixtures';
import { testDatabase } from './database-concurrency';

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
async function fixture() {
  const f = await paymentFixture(admin); products.push(f.productId); return f;
}

  for (const mode of ['manual', 'paypal', 'cancel', 'expiry'] as const)
  test(`${mode}: 逆序商品行回库与 Quote 受控交错均提交，不产生死锁或人工对账`, async () => {
    const variants = [await fixture(), await fixture()].sort((a, b) => a.variantId.localeCompare(b.variantId));
    const [a, b] = variants;
    // The expiry batch encounters B's older order before A's: per-order locking is not enough.
    const older = mode === 'expiry' ? await checked<{ id: string }>(rpc('create_order', {
      items: [{ variant_id: b.variantId, quantity: 1 }], address: TEST_ADDRESS,
    }, buyer.token)) : null;
    const order = await checked<{ id: string }>(rpc('create_order', {
      items: (older ? [a] : variants).map(v => ({ variant_id: v.variantId, quantity: 1 })), address: TEST_ADDRESS,
    }, buyer.token));
    // Give the B line the lower item UUID: refunds sort item IDs, quotes sort variant IDs.
    const low = `00000000-0000-4000-8000-${crypto.randomUUID().slice(-12)}`;
    const high = `ffffffff-ffff-4fff-bfff-${crypto.randomUUID().slice(-12)}`;
    await database`update public.order_items set id=case when variant_id=${b.variantId}::uuid then ${low}::uuid else ${high}::uuid end where order_id=${order.id}::uuid`;
    const refundItems = [{ order_item_id: low, quantity: 1 }, { order_item_id: high, quantity: 1 }];
    let refundEvent: { id: string; reference: string; hash: string; data: Record<string, unknown> } | null = null;
    if (mode === 'manual') {
      await checked(rpc('mark_order_paid', { order_id: order.id }, admin.token));
    } else if (mode === 'paypal') {
      await settleIntent(await fixtureIntent({ ...order, itemId: low, quoteId: null, total: 20, currency: 'USD' }, buyer));
      const request = await checked<{ id: string; amount: number; currency: string; parent_provider_reference: string }>(rpc('create_refund_request', {
        order_id: order.id, actor_id: admin.userId, provider: 'paypal', idempotency_key: crypto.randomUUID(),
        items: refundItems, restock: true,
      }, undefined, true));
      const reference = `REFUND${request.id}`;
      await checked(rpc('bind_refund_request_provider', {
        refund_request_id: request.id, provider_reference: reference, provider_status: 'pending', amount: request.amount, currency: request.currency,
      }, undefined, true));
      const data = { status: 'completed', amount: request.amount.toFixed(2), currency: request.currency, capture_reference: request.parent_provider_reference };
      const { sha256Hex } = await import('../supabase/functions/_shared/provider-events');
      refundEvent = { id: `review-${crypto.randomUUID()}`, reference, data, hash: await sha256Hex(JSON.stringify(data)) };
    }
    const gate = String(BigInt(`0x${crypto.randomUUID().replaceAll('-', '').slice(0, 14)}`));
    let hookCreated = false;
    let gateTransaction: Promise<unknown> | undefined;
    let refund: Promise<Record<string, unknown>> | undefined;
    let quote: Promise<{ status: number; data: unknown }> | undefined;
    const release = Promise.withResolvers<void>();
    const gateReady = Promise.withResolvers<number>();
    const refundReady = Promise.withResolvers<number>();
    const waitBlockedBy = async (pid: number) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const [row] = await database`select exists(select 1 from pg_stat_activity where ${pid}::int=any(pg_blocking_pids(pid))) as blocked`;
        if (row.blocked) return;
        await Bun.sleep(5);
      }
      throw new Error('did not observe expected database lock barrier');
    };
    try {
      // Test-only AFTER hook pauses the REAL refund after its first stock update.
      // No business function is replaced and no trigger/invariant is disabled.
      await database.unsafe(`create function private.review_pause_inventory() returns trigger language plpgsql set search_path='' as $$
        begin
          if current_setting('review.pause_variant',true)=new.variant_id::text then
            perform pg_catalog.pg_advisory_xact_lock(current_setting('review.gate')::bigint);
          end if;
          return new;
        end $$`);
      hookCreated = true;
      await database.unsafe(`create trigger inventory_levels_review_pause after update on public.inventory_levels for each row execute function private.review_pause_inventory()`);
      gateTransaction = database.begin(async tx => {
        // Isolate the future-time worker from other test files. Its real SKIP LOCKED
        // selection can only claim our two orders; no production filter is mocked.
        if (older) await tx`select 1 from public.orders where status='open' and financial_status='pending'
          and id<>${order.id}::uuid and id<>${older.id}::uuid order by id for update`;
        await tx`select pg_advisory_xact_lock(${gate}::bigint)`;
        const [row] = await tx`select pg_backend_pid() as pid`; gateReady.resolve(row.pid);
        await release.promise;
      });
      gateTransaction.catch(gateReady.reject);
      const gatePid = await gateReady.promise;
      refund = database.begin(async tx => {
        await tx`set local statement_timeout='10s'`;
        await tx`set local deadlock_timeout='200ms'`;
        await tx`select set_config('request.jwt.claims',${claims(admin.userId)},true),
          set_config('review.pause_variant',${b.variantId},true),set_config('review.gate',${gate},true)`;
        const [row] = await tx`select pg_backend_pid() as pid`; refundReady.resolve(row.pid);
        if (refundEvent) {
          await tx`select set_config('request.jwt.claims','{"role":"service_role"}',true)`;
          const [event] = await tx`select public.ingest_payment_provider_event('paypal',${refundEvent.id},'api_response',
            'paypal.refund.api_result',${refundEvent.reference},false,clock_timestamp(),${refundEvent.hash},
            ${JSON.stringify(refundEvent.data)}::text::jsonb) as result`;
          return { completed: true, event: event.result };
        }
        if (mode === 'expiry') {
          await tx`select set_config('request.jwt.claims','{"role":"service_role"}',true)`;
          const [row] = await tx`select public.expire_unpaid_orders(500,'2100-01-01'::timestamptz) as result`;
          return { completed: true, expiry: row.result };
        }
        if (mode === 'cancel') {
          await tx`select public.cancel_order(${order.id}::uuid)`;
          return { completed: true };
        }
        await tx`select public.refund_order(order_id=>${order.id}::uuid,
          items=>${JSON.stringify(refundItems)}::text::jsonb,restock=>true)`;
        return { completed: true };
      }).catch(error => {
        refundReady.reject(error);
        return { completed: false, code: error.code, errno: error.errno, message: error.message };
      });
      const refundPid = await refundReady.promise;
      await waitBlockedBy(gatePid);
      quote = rpc('create_checkout_quote', {
        items: variants.flatMap(v => ['Alice', 'Bob'].map(engraving => ({
          variant_id: v.variantId, quantity: 1, attributes: { engraving },
        }))), address: TEST_ADDRESS,
        idempotency_key: crypto.randomUUID(),
      }, buyer.token);
      await waitBlockedBy(refundPid);
      release.resolve(); await gateTransaction;
      const [refundResult, quoteResult] = await Promise.all([refund, quote]);
      const [row] = await database`select o.status, o.financial_status,
        (select coalesce(sum(t.amount),0) from commerce.payment_transactions t where t.order_id=o.id and t.kind='refund' and t.status='succeeded')::text as refunded
        from public.orders o where o.id=${order.id}::uuid`;
      expect(refundResult).toMatchObject({ completed: true });
      expect(quoteResult.status).toBe(200);
      expect((quoteResult.data as { lines: unknown[] }).lines).toHaveLength(4);
      const unpaid = mode === 'cancel' || mode === 'expiry';
      expect(row.financial_status).toBe(unpaid ? 'pending' : 'refunded');
      expect(Number(row.refunded)).toBe(unpaid ? 0 : 20);
      if (unpaid) expect(row.status).toBe('cancelled');
      if (mode === 'expiry') expect(refundResult).toMatchObject({ expiry: { expired_count: 2 } });
      expect([await stockOf(a.sku), await stockOf(b.sku)]).toEqual([100,100]);
      if (mode === 'paypal') {
        expect(refundResult).toMatchObject({ event: { status: 'processed', outcome: 'refunded' } });
        const [money] = await database`select reconciliation_status,last_error from commerce.provider_money_movements where order_id=${order.id}::uuid and kind='refund'`;
        expect(money).toMatchObject({ reconciliation_status: 'matched', last_error: null });
      }
    } finally {
      release.resolve();
      await Promise.allSettled([gateTransaction, refund, quote].filter(Boolean));
      if (hookCreated) {
        await database.unsafe('drop trigger if exists inventory_levels_review_pause on public.inventory_levels');
        await database.unsafe('drop function private.review_pause_inventory()');
      }
    }
  });
