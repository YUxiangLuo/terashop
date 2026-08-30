/// <reference path="../_shared/deno.d.ts" />
import {
  authenticatedUser,
  corsHeaders,
  errorResponse,
  HttpError,
  jsonResponse,
  optionalEnv,
  readJsonBody,
  requireIdempotencyKey,
  requiredEnv,
  requireUuid,
  serviceRpc,
} from '../_shared/http.ts';
import {
  assertStripeKeyMode,
  decimalToMinorUnits,
  mapStripePaymentIntentStatus,
  stripeRequest,
  type StripePaymentIntentResponse,
} from '../_shared/stripe.ts';

interface LocalPaymentIntent {
  id: string;
  order_id: string;
  provider: string;
  status: string;
  amount: number | string;
  currency: string;
  provider_reference: string | null;
  expires_at: string | null;
}

function validateStripeIntent(
  stripe: StripePaymentIntentResponse,
  local: LocalPaymentIntent,
  expectedMinor: string,
): void {
  if (stripe.object !== 'payment_intent' || typeof stripe.id !== 'string'
      || String(stripe.amount) !== expectedMinor
      || stripe.currency?.toUpperCase() !== local.currency
      || stripe.metadata?.tera_payment_intent_id !== local.id
      || stripe.metadata?.tera_order_id !== local.order_id) {
    throw new HttpError('Stripe PaymentIntent does not match the local payment intent', 409, 'provider_mismatch');
  }
}

Deno.serve(async (request) => {
  let cors: Record<string, string> = {};
  try {
    cors = corsHeaders(request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') throw new HttpError('Method not allowed', 405, 'method_not_allowed');

    const user = await authenticatedUser(request);
    const body = await readJsonBody(request);
    const orderId = requireUuid(body.order_id, 'order_id');
    const idempotencyKey = requireIdempotencyKey(body.idempotency_key);
    const local = await serviceRpc<LocalPaymentIntent>('create_payment_intent_for_customer', {
      order_id: orderId,
      customer_id: user.id,
      provider: 'stripe',
      idempotency_key: idempotencyKey,
      metadata: { edge_function: 'stripe-create-payment-intent' },
    });
    if (local.provider !== 'stripe') throw new HttpError('Unexpected payment provider', 500, 'provider_mismatch');
    if (['succeeded', 'failed', 'cancelled'].includes(local.status)) {
      throw new HttpError(`Payment intent is terminal (${local.status})`, 409, 'payment_intent_terminal');
    }
    if (local.expires_at && Date.parse(local.expires_at) <= Date.now()) {
      throw new HttpError('Payment intent has expired', 409, 'payment_intent_expired');
    }

    const secretKey = requiredEnv('STRIPE_SECRET_KEY');
    assertStripeKeyMode(secretKey, optionalEnv('STRIPE_LIVEMODE', 'false') === 'true');
    const apiBase = optionalEnv('STRIPE_API_BASE', 'https://api.stripe.com');
    const apiVersion = optionalEnv('STRIPE_API_VERSION', '2026-02-25.clover');
    const amountMinor = decimalToMinorUnits(local.amount, local.currency);
    const stripe = local.provider_reference
      ? await stripeRequest<StripePaymentIntentResponse>(
          `/v1/payment_intents/${encodeURIComponent(local.provider_reference)}`,
          { secretKey, apiBase, apiVersion, method: 'GET' },
        )
      : await stripeRequest<StripePaymentIntentResponse>('/v1/payment_intents', {
          secretKey,
          apiBase,
          apiVersion,
          idempotencyKey: `tera-payment-intent-${local.id}`,
          form: {
            amount: amountMinor,
            currency: local.currency.toLowerCase(),
            'automatic_payment_methods[enabled]': 'true',
            'metadata[tera_payment_intent_id]': local.id,
            'metadata[tera_order_id]': local.order_id,
          },
        });
    validateStripeIntent(stripe, local, amountMinor);
    if (typeof stripe.client_secret !== 'string' || stripe.client_secret.length < 10) {
      throw new HttpError('Stripe did not return a client secret', 502, 'stripe_bad_response');
    }
    const providerStatus = mapStripePaymentIntentStatus(stripe.status);
    const bound = await serviceRpc<LocalPaymentIntent>('bind_payment_intent_provider', {
      payment_intent_id: local.id,
      provider_reference: stripe.id,
      provider_status: providerStatus,
      amount: local.amount,
      currency: local.currency,
    });
    return jsonResponse({
      payment_intent_id: bound.id,
      order_id: bound.order_id,
      provider: 'stripe',
      provider_reference: stripe.id,
      status: bound.status,
      amount: bound.amount,
      currency: bound.currency,
      client_secret: stripe.client_secret,
      expires_at: bound.expires_at,
    }, 200, cors);
  } catch (error) {
    console.error('stripe-create-payment-intent failed', error instanceof Error ? error.name : 'unknown');
    return errorResponse(error, cors);
  }
});
