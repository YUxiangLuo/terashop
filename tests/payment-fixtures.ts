import { api, rpc, TEST_ADDRESS, type TestUser } from './helpers';
import { decimalToMinorUnits } from '../supabase/functions/_shared/stripe.ts';
import { sha256Hex } from '../supabase/functions/_shared/provider-events.ts';

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

export async function checked<T>(response: Promise<{ status: number; data: unknown }>): Promise<T> {
  const result = await response;
  if (result.status >= 300) throw new Error(JSON.stringify(result));
  return result.data as T;
}

export async function paymentFixture(admin: TestUser): Promise<PaymentFixture> {
  const suffix = crypto.randomUUID();
  const [product] = await checked<Array<{ id: string }>>(api('/rest/v1/products?select=id', {
    service: true, method: 'POST',
    body: { slug: `workflow-${suffix}`, name: 'Payment workflow fixture', status: 'active' },
  }));
  const sku = `WORKFLOW-${suffix}`;
  const [variant] = await checked<Array<{ id: string }>>(api('/rest/v1/product_variants?select=id', {
    service: true, method: 'POST',
    body: { product_id: product.id, sku, price: 10, track_inventory: true },
  }));
  await checked(rpc('adjust_inventory', {
    variant_id: variant.id, delta: 100, reason: 'restock', note: 'workflow tests',
  }, admin.token));
  return { productId: product.id, variantId: variant.id, sku };
}

export async function fixtureOrder(
  fixture: PaymentFixture,
  buyer: TestUser,
  quantity = 1,
  quoted = true,
): Promise<FixtureOrder> {
  const input = { items: [{ variant_id: fixture.variantId, quantity }], address: TEST_ADDRESS };
  let quoteId: string | null = null;
  if (quoted) {
    const quote = await checked<{ id: string }>(rpc('create_checkout_quote', {
      ...input, idempotency_key: crypto.randomUUID(),
    }, buyer.token));
    quoteId = quote.id;
  }
  const order = await checked<{ id: string; total: number; currency: string }>(quoted
    ? rpc('create_order_from_quote', { quote_id: quoteId }, buyer.token)
    : rpc('create_order', input, buyer.token));
  const [line] = await checked<Array<{ id: string }>>(api(
    `/rest/v1/order_items?order_id=eq.${order.id}&select=id`, { token: buyer.token },
  ));
  return { ...order, itemId: line.id, quoteId };
}

export async function fixtureIntent(
  order: FixtureOrder, buyer: TestUser, provider: 'stripe' | 'paypal' = 'stripe',
): Promise<FixtureIntent> {
  const intent = await checked<FixtureIntent>(rpc('create_payment_intent_for_customer', {
    order_id: order.id, customer_id: buyer.userId, provider, idempotency_key: crypto.randomUUID(),
  }, undefined, true));
  const reference = provider === 'stripe'
    ? `pi_${crypto.randomUUID().replaceAll('-', '')}`
    : `ORDER${crypto.randomUUID().replaceAll('-', '')}`;
  return checked<FixtureIntent>(rpc('bind_payment_intent_provider', {
    payment_intent_id: intent.id, provider_reference: reference,
    provider_status: 'requires_action', amount: intent.amount, currency: intent.currency,
  }, undefined, true));
}

export async function paymentEvent(
  provider: 'stripe' | 'paypal', eventType: string,
  reference: string, data: Record<string, unknown>,
): Promise<{ status: string; outcome: string }> {
  return checked(rpc('ingest_payment_provider_event', {
    provider, provider_event_id: `evt_${crypto.randomUUID()}`, source: 'webhook',
    event_type: eventType, object_reference: reference, livemode: false,
    occurred_at: new Date().toISOString(), payload_hash: await sha256Hex(JSON.stringify(data)), data,
  }, undefined, true));
}

export async function settleIntent(intent: FixtureIntent): Promise<void> {
  const result = intent.provider === 'stripe'
    ? await paymentEvent('stripe', 'payment_intent.succeeded', intent.provider_reference, {
        object_type: 'payment_intent', status: 'succeeded',
        amount_minor: decimalToMinorUnits(intent.amount, intent.currency), currency: intent.currency,
        metadata: { tera_payment_intent_id: intent.id },
      })
    : await paymentEvent('paypal', 'PAYMENT.CAPTURE.COMPLETED', `CAPTURE${intent.id.replaceAll('-', '')}`, {
        object_type: 'capture', status: 'completed', amount: intent.amount.toFixed(2),
        currency: intent.currency, order_reference: intent.provider_reference,
        metadata: { tera_payment_intent_id: intent.id },
      });
  if (result.outcome !== 'captured') throw new Error(JSON.stringify(result));
}
