import { afterAll, beforeAll, expect, test } from 'bun:test';
import { api, rpc, signup, makeAdmin, stockOf, type TestUser } from './helpers';
import { checked, fixtureOrder, fixtureIntent, paymentFixture, settleIntent } from './payment-fixtures';
import { testDatabase } from './database-concurrency';
import { withRollback } from '../scripts/db-lint';
import { sha256Hex } from '../supabase/functions/_shared/provider-events';

const database = testDatabase();
let admin: TestUser;
const products: string[] = [];
beforeAll(async () => { admin = await signup(); await makeAdmin(admin.userId); });
afterAll(async () => {
  if (products.length) await checked(api(`/rest/v1/products?id=in.(${products.join(',')})`, {
    service: true, method: 'PATCH', body: { status: 'archived' },
  }));
  await database.close();
});

for (const mode of ['capture', 'refund'] as const)
for (const sqlstate of ['40P01', '40001', '55P03']) test(`${mode} 遇到 ${sqlstate}：资金事实保留、退避后 Inbox 恢复，原事件重放不重复改库存`, async () => {
  const buyer = await signup(); const f = await paymentFixture(admin); products.push(f.productId);
  const order = await fixtureOrder(f, buyer);
  const intent = await fixtureIntent(order, buyer);
  if (mode === 'refund') await settleIntent(intent);
  const request = mode === 'refund' ? await checked<{ id: string; parent_provider_reference: string }>(rpc('create_refund_request', {
    order_id: order.id, actor_id: admin.userId, provider: 'paypal', idempotency_key: crypto.randomUUID(),
    items: [{ order_item_id: order.itemId, quantity: 1 }], restock: true,
  }, undefined, true)) : null;
  const reference = request ? `REFUND${request.id}` : `CAPTURE${intent.id}`;
  if (request) await checked(rpc('bind_refund_request_provider', {
    refund_request_id: request.id, provider_reference: reference, provider_status: 'pending', amount: '10.00', currency: 'USD',
  }, undefined, true));
  const eventId = crypto.randomUUID();
  const data = { status: 'completed', amount: '10.00', currency: 'USD',
    ...(request ? { capture_reference: request.parent_provider_reference } : { order_reference: intent.provider_reference }) };
  await withRollback(database, async tx => {
    // Inject a real PostgreSQL exception inside local settlement, after recording
    // the external fact. No production trigger or integrity check is disabled.
    await tx.unsafe(`create function private.test_transient_refund() returns trigger language plpgsql set search_path='' as $$
      begin
        if new.order_id='${order.id}'::uuid and coalesce(current_setting('test.refund_sqlstate',true),'') <> '' then
          raise exception 'injected transient refund fault' using errcode=current_setting('test.refund_sqlstate');
        end if;
        return new;
      end $$`);
    await tx.unsafe(`create trigger settlement_test_transient before insert on commerce.${request ? 'refunds' : 'payment_transactions'} for each row execute function private.test_transient_refund()`);
    await tx`select set_config('request.jwt.claims','{"role":"service_role"}',true), set_config('test.refund_sqlstate',${sqlstate},true)`;
    const [received] = await tx`select public.ingest_payment_provider_event('paypal',${eventId},'api_response',${`paypal.${mode}.api_result`},
      ${reference},false,now(),${await sha256Hex(JSON.stringify(data))},${JSON.stringify(data)}::text::jsonb) as result`;
    expect(received.result).toMatchObject({ status: 'received', outcome: 'transient_database_error' });
    const [before] = await tx`select reconciliation_status,last_error from commerce.provider_money_movements where provider_reference=${reference}`;
    expect(before.reconciliation_status).not.toBe('action_required');
    expect(before.last_error).toBe('injected transient refund fault');
    const [unsettled] = await tx`select count(*)::int as n from commerce.payment_transactions where order_id=${order.id}::uuid and kind=${mode}`;
    expect(unsettled.n).toBe(0);
    await tx`select public.retry_payment_provider_events(200)`;
    const [waiting] = await tx`select attempts,next_attempt_at>clock_timestamp() as backed_off from commerce.payment_provider_events where provider_event_id=${eventId}`;
    expect(waiting).toMatchObject({ attempts: 1, backed_off: true });
    await tx`select set_config('test.refund_sqlstate','',true)`;
    await tx`update commerce.payment_provider_events set next_attempt_at=clock_timestamp()-interval '1 second' where provider_event_id=${eventId}`;
    await tx`select public.retry_payment_provider_events(200)`;
    const [done] = await tx`select status,outcome,attempts from commerce.payment_provider_events where provider_event_id=${eventId}`;
    expect(done).toMatchObject({ status: 'processed', outcome: request ? 'refunded' : 'captured', attempts: 2 });
    const [money] = await tx`select reconciliation_status,last_error from commerce.provider_money_movements where provider_reference=${reference}`;
    expect(money).toMatchObject({ reconciliation_status: 'matched', last_error: null });
    await tx`select private.process_payment_provider_event(id) from commerce.payment_provider_events where provider_event_id=${eventId}`;
    await tx`select public.retry_payment_provider_events(200)`;
    const [final] = await tx`select (select count(*)::int from commerce.payment_transactions where order_id=${order.id}::uuid and kind=${mode}) as transactions,
      (select count(*)::int from public.inventory_movements where order_id=${order.id}::uuid and reason=${request ? 'return' : 'order'}) as movements,
      (select on_hand from public.inventory_levels where variant_id=${f.variantId}::uuid limit 1) as stock`;
    expect(final).toEqual({ transactions: 1, movements: 1, stock: request ? 100 : 99 });
  });
  expect(await stockOf(f.sku)).toBe(request ? 99 : 100);
});
