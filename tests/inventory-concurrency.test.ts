import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { api, rpc, signup, makeAdmin, stockOf, TEST_ADDRESS, type TestUser } from './helpers';
import { checked, fixtureIntent, paymentFixture, settleIntent } from './payment-fixtures';
import { heldTransactionRace, testDatabase, waitForBlockedCommand } from './database-concurrency';

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

  for (const mode of ['manual', 'paypal'] as const)
  test(`${mode}: 逆序商品行回库与 Quote 受控交错均提交，不产生死锁或人工对账`, async () => {
    const variants = [await fixture(), await fixture()].sort((a, b) => a.variantId.localeCompare(b.variantId));
    const [a, b] = variants;
    // Assign adversarial IDs at INSERT, not by rewriting immutable order snapshots.
    // Refunds sort item IDs, quotes sort variant IDs. Only our two variants are affected.
    const low = `00000000-0000-4000-8000-${crypto.randomUUID().slice(-12)}`;
    const high = `ffffffff-ffff-4fff-bfff-${crypto.randomUUID().slice(-12)}`;
    let order: { id: string };
    await database.unsafe(`create function private.review_quote_line_ids() returns trigger language plpgsql as $$
      begin
        if new.variant_id='${a.variantId}'::uuid then new.id:='${high}'::uuid;
        elsif new.variant_id='${b.variantId}'::uuid then new.id:='${low}'::uuid; end if;
        return new;
      end $$`);
    try {
      await database.unsafe('create trigger review_quote_line_ids before insert on commerce.checkout_quote_lines for each row execute function private.review_quote_line_ids()');
      order = await checked<{ id: string }>(rpc('create_order', { idempotency_key: crypto.randomUUID(),
        items: variants.map(v => ({ variant_id: v.variantId, quantity: 1 })), address: TEST_ADDRESS,
      }, buyer.token));
    } finally {
      await database.unsafe('drop trigger if exists review_quote_line_ids on commerce.checkout_quote_lines');
      await database.unsafe('drop function private.review_quote_line_ids()');
    }
    const refundItems = [{ order_item_id: low, quantity: 1 }, { order_item_id: high, quantity: 1 }];
    let refundEvent: { id: string; reference: string; hash: string; data: Record<string, unknown> } | null = null;
    if (mode === 'manual') {
      await checked(rpc('mark_order_paid', { idempotency_key: crypto.randomUUID(), order_id: order.id }, admin.token));
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
    const waitBlockedBy = (pid: number) => waitForBlockedCommand(database, pid, 5000);
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
        await tx`select public.refund_order(order_id=>${order.id}::uuid,idempotency_key=>${crypto.randomUUID()},
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
      expect(row.financial_status).toBe('refunded');
      expect(Number(row.refunded)).toBe(20);
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

for (const mode of ['cancel', 'expiry'] as const) {
  test(`${mode}: 释放预占等待订单锁时，新 Quote 仍可预占剩余库存且无回库流水`, async () => {
    const f = await fixture();
    const order = await checked<{ id: string }>(rpc('create_order', { idempotency_key: crypto.randomUUID(),
      items: [{ variant_id: f.variantId, quantity: 3 }], address: TEST_ADDRESS,
    }, buyer.token));
    const result = await heldTransactionRace(database, async tx => {
      // Isolate the real SKIP LOCKED worker without expiring other test fixtures.
      if (mode === 'expiry') await tx`select 1 from commerce.checkout_quotes
        where order_id is distinct from ${order.id}::uuid order by id for update`;
      await tx`select 1 from public.orders where id=${order.id}::uuid for update`;
    }, () => mode === 'cancel'
      ? rpc('cancel_order', { order_id: order.id }, buyer.token)
      : rpc('expire_checkout_quotes', { as_of: '2100-01-01', max_quotes: 500 }, undefined, true),
    async () => {
      const quote = await checked<{ id: string }>(rpc('create_checkout_quote', {
        items: [{ variant_id: f.variantId, quantity: 2 }], address: TEST_ADDRESS,
        idempotency_key: crypto.randomUUID(),
      }, buyer.token));
      expect(quote.id).toBeString();
    });
    expect(result.status).toBe(200);
    const [row] = await database`select o.status,
      (select count(*)::int from public.inventory_movements where order_id=o.id) movements
      from public.orders o where id=${order.id}::uuid`;
    expect(row).toEqual({ status: 'cancelled', movements: 0 });
    expect(await stockOf(f.sku)).toBe(100);
  });
}
