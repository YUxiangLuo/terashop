import { api, rpc, command, checked, TEST_ADDRESS, type TestUser } from './helpers';
import { stockedProduct } from './support/catalog';
export { checked } from './support/http';
import { sha256Hex } from '../supabase/functions/_shared/provider-events.ts';
import type { SQL } from 'bun';
import { withRollback } from '../scripts/lib/transactions';

// Exercise the real SKIP LOCKED poller without consuming another suite's queue
// or assuming our request is in its first page. Locks, not row edits or mocks.
// Only these isolating locks roll back; owned HTTP/RPC effects stay committed.
export function withRefundPolling<T>(database: SQL, ids: string[], run: () => Promise<T>): Promise<T> {
  if (!ids.length) throw new Error('Refund polling requires owned fixture IDs');
  return withRollback(database, async tx => {
    await tx`set local statement_timeout='10s'`;
    await tx`select id from commerce.refund_requests
      where provider='paypal' and id not in (
        select jsonb_array_elements_text(${JSON.stringify(ids)}::text::jsonb)::uuid
      ) order by id for update`;
    return run();
  });
}

export interface PaymentFixture {
  productId: string;
  variantId: string;
  sku: string;
}

export interface FixtureOrder {
  id: string;
  itemId: string;
  quoteId: string | null;
  total: number;
  currency: string;
}

export interface FixtureIntent {
  id: string;
  order_id: string;
  provider: string;
  status: string;
  amount: number;
  currency: string;
  provider_reference: string;
}

export const paymentFixture = (admin: TestUser): Promise<PaymentFixture> => stockedProduct(admin);

export async function fixtureOrder(
  fixture: PaymentFixture,
  buyer: TestUser,
  quantity = 1,
  quoted = true,
  options: { shipping_method_id?: string; address?: typeof TEST_ADDRESS } = {},
): Promise<FixtureOrder> {
  const input = { items: [{ variant_id: fixture.variantId, quantity }], address: TEST_ADDRESS, ...options };
  let quoteId: string | null = null;
  if (quoted) {
    const quote = await checked<{ id: string }>(command('create_checkout_quote', {
      ...input, idempotency_key: crypto.randomUUID(),
    }, buyer.token));
    quoteId = quote.id;
  }
  const order = await checked<{ id: string; total: number; currency: string }>(quoted
    ? command('create_order_from_quote', { quote_id: quoteId! }, buyer.token)
    : command('create_order', input, buyer.token));
  const [line] = await checked<Array<{ id: string }>>(api(
    `/rest/v1/order_items?order_id=eq.${order.id}&select=id`, { token: buyer.token },
  ));
  return { ...order, itemId: line.id, quoteId };
}

export async function fixtureIntent(
  order: FixtureOrder, buyer: TestUser, provider: 'paypal' = 'paypal',
): Promise<FixtureIntent> {
  const intent = await checked<FixtureIntent>(command('create_payment_intent_for_customer', {
    order_id: order.id, actor_id: buyer.userId, provider, idempotency_key: crypto.randomUUID(),
  }, undefined, true));
  const reference = `ORDER${crypto.randomUUID().replaceAll('-', '')}`;
  return checked<FixtureIntent>(command('bind_payment_intent_provider', {
    payment_intent_id: intent.id, provider_reference: reference,
    provider_status: 'requires_action', amount: intent.amount, currency: intent.currency,
  }, undefined, true));
}

export async function paymentEvent(
  provider: 'paypal', eventType: string,
  reference: string, data: Record<string, unknown>,
): Promise<{ status: string; outcome: string }> {
  return checked(rpc('ingest_payment_provider_event', {
    provider, provider_event_id: `evt_${crypto.randomUUID()}`, source: 'webhook',
    event_type: eventType, object_reference: reference, livemode: false,
    occurred_at: new Date().toISOString(), payload_hash: await sha256Hex(JSON.stringify(data)), data,
  }, undefined, true));
}

export async function settleIntent(intent: FixtureIntent): Promise<void> {
  const result = await paymentEvent('paypal', 'PAYMENT.CAPTURE.COMPLETED', `CAPTURE${intent.id.replaceAll('-', '')}`, {
        object_type: 'capture', status: 'completed', amount: intent.amount.toFixed(2),
        currency: intent.currency, order_reference: intent.provider_reference,
        metadata: { tera_payment_intent_id: intent.id },
      });
  if (result.outcome !== 'captured') throw new Error(JSON.stringify(result));
}
