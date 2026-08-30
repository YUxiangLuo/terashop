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
  normalizedStripePaymentIntentData,
  parseStripeAllowRedirects,
  parseStripeHttpTimeout,
  parseStripeLivemode,
  sha256Hex,
  stripeApiBase,
  stripeApiVersion,
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

interface ProviderEventResult {
  status: string;
  outcome: string | null;
}

function stripeTimeoutMs(): number {
  return parseStripeHttpTimeout(optionalEnv('STRIPE_HTTP_TIMEOUT_MS', '10000'));
}

function validateStripeIntent(
  stripe: StripePaymentIntentResponse,
  local: LocalPaymentIntent,
  expectedMinor: string,
  expectedLivemode: boolean,
  enforceExpectedMoney: boolean,
  enforceCorrelation: boolean,
): void {
  if (stripe.object !== 'payment_intent'
      || typeof stripe.id !== 'string' || !/^pi_[A-Za-z0-9_]{3,252}$/.test(stripe.id)
      || !Number.isSafeInteger(stripe.amount) || stripe.amount <= 0
      || !Number.isSafeInteger(stripe.amount_received) || stripe.amount_received < 0
      || typeof stripe.currency !== 'string' || !/^[A-Za-z]{3}$/.test(stripe.currency)
      || typeof stripe.livemode !== 'boolean' || stripe.livemode !== expectedLivemode
      || !Number.isSafeInteger(stripe.created)
      || stripe.created < 1_230_768_000 || stripe.created > 253_402_300_799
      || (enforceCorrelation && stripe.capture_method !== 'automatic')
      || (enforceCorrelation && stripe.confirmation_method !== 'automatic')
      || (enforceCorrelation && stripe.automatic_payment_methods?.enabled !== true)
      || (enforceCorrelation && stripe.metadata?.tera_payment_intent_id !== local.id)
      || (enforceCorrelation && stripe.metadata?.tera_order_id !== local.order_id)
      || (enforceCorrelation && local.provider_reference !== null
          && local.provider_reference !== stripe.id)
      || (enforceExpectedMoney && String(stripe.amount) !== expectedMinor)
      || (enforceExpectedMoney && stripe.currency.toUpperCase() !== local.currency)) {
    throw new HttpError(
      'Stripe PaymentIntent does not match the local payment intent', 409, 'provider_mismatch',
    );
  }
}

async function ingestStripeIntent(
  stripe: StripePaymentIntentResponse,
  local: LocalPaymentIntent,
): Promise<ProviderEventResult> {
  const eventType = `payment_intent.${stripe.status}`;
  const data = normalizedStripePaymentIntentData(stripe, eventType);
  // A succeeded API observation must stay idempotent even while its local match
  // awaits reconciliation. Success processing never uses occurred_at for status
  // ordering, so the immutable provider creation time is the safe stable value.
  const occurredAt = stripe.status === 'succeeded'
    ? new Date(stripe.created * 1000).toISOString()
    : new Date().toISOString();
  const payloadHash = await sha256Hex(JSON.stringify({ occurred_at: occurredAt, data }));
  return serviceRpc<ProviderEventResult>('ingest_payment_provider_event', {
    provider: 'stripe',
    provider_event_id: `api:payment_intent:${stripe.id}:${stripe.status}:${payloadHash.slice(0, 16)}`,
    source: 'api_response',
    event_type: eventType,
    object_reference: stripe.id,
    livemode: stripe.livemode,
    occurred_at: occurredAt,
    payload_hash: payloadHash,
    data,
  });
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
    if (local.provider !== 'stripe') {
      throw new HttpError('Unexpected payment provider', 500, 'provider_mismatch');
    }
    if (['succeeded', 'failed', 'cancelled'].includes(local.status)) {
      throw new HttpError(
        `Payment intent is terminal (${local.status})`, 409, 'payment_intent_terminal',
      );
    }
    if (local.expires_at && Date.parse(local.expires_at) <= Date.now()) {
      throw new HttpError('Payment intent has expired', 409, 'payment_intent_expired');
    }

    const livemode = parseStripeLivemode(optionalEnv('STRIPE_LIVEMODE', 'false'));
    const secretKey = requiredEnv('STRIPE_SECRET_KEY');
    assertStripeKeyMode(secretKey, livemode);
    const apiBase = stripeApiBase(livemode, optionalEnv('STRIPE_API_BASE'));
    const apiVersion = stripeApiVersion(
      optionalEnv('STRIPE_API_VERSION', '2026-02-25.clover'),
    );
    const allowRedirects = parseStripeAllowRedirects(
      optionalEnv('STRIPE_ALLOW_REDIRECTS', 'never'),
    );
    const amountMinor = decimalToMinorUnits(local.amount, local.currency);
    const stripe = local.provider_reference
      ? await stripeRequest<StripePaymentIntentResponse>(
          `/v1/payment_intents/${encodeURIComponent(local.provider_reference)}`,
          {
            secretKey,
            apiBase,
            apiVersion,
            method: 'GET',
            timeoutMs: stripeTimeoutMs(),
          },
        )
      : await stripeRequest<StripePaymentIntentResponse>('/v1/payment_intents', {
          secretKey,
          apiBase,
          apiVersion,
          idempotencyKey: `tera-payment-intent-${local.id}`,
          timeoutMs: stripeTimeoutMs(),
          form: {
            amount: amountMinor,
            currency: local.currency.toLowerCase(),
            'automatic_payment_methods[enabled]': 'true',
            'automatic_payment_methods[allow_redirects]': allowRedirects,
            'metadata[tera_payment_intent_id]': local.id,
            'metadata[tera_order_id]': local.order_id,
          },
        });

    const providerSucceeded = stripe.status === 'succeeded';
    validateStripeIntent(
      stripe,
      local,
      amountMinor,
      livemode,
      !providerSucceeded,
      !providerSucceeded,
    );

    if (providerSucceeded) {
      const correlationMatches = stripe.metadata?.tera_payment_intent_id === local.id
        && stripe.metadata?.tera_order_id === local.order_id
        && (local.provider_reference === null || local.provider_reference === stripe.id);
      let correlated = local;
      if (correlationMatches) {
        correlated = await serviceRpc<LocalPaymentIntent>('bind_payment_intent_provider', {
          payment_intent_id: local.id,
          provider_reference: stripe.id,
          provider_status: 'processing',
          amount: local.amount,
          currency: local.currency,
        });
      }
      const event = await ingestStripeIntent(stripe, local);
      if (event.status === 'failed') {
        throw new HttpError(
          'Stripe payment exists but local reconciliation is pending',
          502,
          'payment_reconciliation_pending',
        );
      }
      return jsonResponse({
        payment_intent_id: correlated.id,
        order_id: correlated.order_id,
        provider: 'stripe',
        provider_reference: stripe.id,
        status: event.outcome,
        amount: correlated.amount,
        currency: correlated.currency,
        client_secret: null,
        expires_at: correlated.expires_at,
        pending_reconciliation: event.outcome !== 'captured',
      }, 200, cors);
    }

    const providerStatus = stripe.status === 'canceled'
      ? 'processing'
      : mapStripePaymentIntentStatus(stripe.status);
    const bound = await serviceRpc<LocalPaymentIntent>('bind_payment_intent_provider', {
      payment_intent_id: local.id,
      provider_reference: stripe.id,
      provider_status: providerStatus,
      amount: local.amount,
      currency: local.currency,
    });
    if (stripe.status === 'canceled') {
      const event = await ingestStripeIntent(stripe, local);
      if (event.status === 'failed') {
        throw new HttpError(
          'Stripe cancellation is pending local reconciliation',
          502,
          'payment_reconciliation_pending',
        );
      }
      throw new HttpError('Stripe PaymentIntent is canceled', 409, 'payment_intent_terminal');
    }

    if (typeof stripe.client_secret !== 'string'
        || !stripe.client_secret.startsWith(`${stripe.id}_secret_`)
        || stripe.client_secret.length > 512) {
      throw new HttpError('Stripe did not return a valid client secret', 502, 'stripe_bad_response');
    }
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
      pending_reconciliation: false,
    }, 200, cors);
  } catch (error) {
    console.error('stripe-create-payment-intent failed', error instanceof Error ? error.name : 'unknown');
    return errorResponse(error, cors);
  }
});
