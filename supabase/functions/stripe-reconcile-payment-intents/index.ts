/// <reference path="../_shared/deno.d.ts" />
import {
  errorResponse,
  HttpError,
  jsonResponse,
  optionalEnv,
  readJsonBody,
  requireServiceRoleRequest,
  requiredEnv,
  serviceRpc,
} from '../_shared/http.ts';
import {
  assertStripeKeyMode,
  normalizedStripePaymentIntentData,
  parseStripeHttpTimeout,
  parseStripeLivemode,
  sha256Hex,
  stripeApiBase,
  stripeApiVersion,
  StripeIntegrationError,
  stripeRequest,
  type StripePaymentIntentResponse,
} from '../_shared/stripe.ts';

interface CancellationCandidate {
  id: string;
  order_id: string;
  provider_reference: string;
  status: string;
  amount: number | string;
  currency: string;
  expires_at: string | null;
  cancel_attempt: number;
}

interface ProviderEventResult {
  status: string;
  outcome: string | null;
}

const ACTIVE_PROVIDER_STATUSES = new Set([
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
  'requires_capture',
  'processing',
]);

function validateStripeIntent(
  stripe: StripePaymentIntentResponse,
  candidate: CancellationCandidate,
  expectedLivemode: boolean,
): void {
  if (stripe.object !== 'payment_intent'
      || stripe.id !== candidate.provider_reference
      || !/^pi_[A-Za-z0-9_]{3,252}$/.test(stripe.id)
      || !Number.isSafeInteger(stripe.amount) || stripe.amount <= 0
      || !Number.isSafeInteger(stripe.amount_received) || stripe.amount_received < 0
      || typeof stripe.currency !== 'string' || !/^[A-Za-z]{3}$/.test(stripe.currency)
      || typeof stripe.status !== 'string'
      || typeof stripe.livemode !== 'boolean' || stripe.livemode !== expectedLivemode
      || !Number.isSafeInteger(stripe.created)
      || stripe.created < 1_230_768_000 || stripe.created > 253_402_300_799) {
    throw new StripeIntegrationError(
      'Stripe PaymentIntent reconciliation response is invalid',
      502,
      'stripe_bad_response',
    );
  }
  if (stripe.status === 'canceled'
      && (!Number.isSafeInteger(stripe.canceled_at)
          || Number(stripe.canceled_at) < 1_230_768_000
          || Number(stripe.canceled_at) > 253_402_300_799)) {
    throw new StripeIntegrationError(
      'Stripe canceled_at is invalid', 502, 'stripe_bad_response',
    );
  }
}

async function ingestTerminalIntent(
  stripe: StripePaymentIntentResponse,
): Promise<ProviderEventResult> {
  if (stripe.status !== 'succeeded' && stripe.status !== 'canceled') {
    throw new StripeIntegrationError(
      `Stripe PaymentIntent is not terminal (${stripe.status})`,
      409,
      'stripe_intent_not_terminal',
    );
  }
  const eventType = `payment_intent.${stripe.status}`;
  const data = normalizedStripePaymentIntentData(stripe, eventType);
  const occurredAt = new Date(
    (stripe.status === 'canceled' ? Number(stripe.canceled_at) : stripe.created) * 1000,
  ).toISOString();
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

function safeErrorCode(error: unknown): string {
  const code = error instanceof StripeIntegrationError
    ? error.code
    : error instanceof HttpError
      ? error.code
      : 'stripe_cancel_failed';
  const safe = code.toLowerCase().replace(/[^a-z0-9_:-]/g, '_').slice(0, 200);
  return safe || 'stripe_cancel_failed';
}

Deno.serve(async (request) => {
  try {
    if (request.method !== 'POST') throw new HttpError('Method not allowed', 405, 'method_not_allowed');
    requireServiceRoleRequest(request);
    const body = await readJsonBody(request, 1024);
    const maxIntents = body.max_intents === undefined ? 5 : Number(body.max_intents);
    if (!Number.isSafeInteger(maxIntents) || maxIntents < 1 || maxIntents > 20) {
      throw new HttpError('max_intents must be between 1 and 20');
    }

    const livemode = parseStripeLivemode(optionalEnv('STRIPE_LIVEMODE', 'false'));
    const secretKey = requiredEnv('STRIPE_SECRET_KEY');
    assertStripeKeyMode(secretKey, livemode);
    const apiBase = stripeApiBase(livemode, optionalEnv('STRIPE_API_BASE'));
    const apiVersion = stripeApiVersion(
      optionalEnv('STRIPE_API_VERSION', '2026-02-25.clover'),
    );
    const timeoutMs = parseStripeHttpTimeout(
      optionalEnv('STRIPE_HTTP_TIMEOUT_MS', '10000'),
    );
    const candidates = await serviceRpc<CancellationCandidate[]>(
      'claim_expired_stripe_payment_intents',
      { max_intents: maxIntents },
    );
    const results: Array<Record<string, unknown>> = [];

    for (const candidate of candidates) {
      try {
        let stripe = await stripeRequest<StripePaymentIntentResponse>(
          `/v1/payment_intents/${encodeURIComponent(candidate.provider_reference)}`,
          { secretKey, apiBase, apiVersion, method: 'GET', timeoutMs },
        );
        validateStripeIntent(stripe, candidate, livemode);

        if (ACTIVE_PROVIDER_STATUSES.has(stripe.status)) {
          stripe = await stripeRequest<StripePaymentIntentResponse>(
            `/v1/payment_intents/${encodeURIComponent(candidate.provider_reference)}/cancel`,
            {
              secretKey,
              apiBase,
              apiVersion,
              idempotencyKey: `tera-cancel-payment-intent-${candidate.id}`,
              timeoutMs,
              form: { cancellation_reason: 'abandoned' },
            },
          );
          validateStripeIntent(stripe, candidate, livemode);
        }
        if (stripe.status !== 'canceled' && stripe.status !== 'succeeded') {
          throw new StripeIntegrationError(
            `Stripe PaymentIntent cannot be reconciled from ${stripe.status}`,
            409,
            'stripe_intent_not_terminal',
          );
        }

        const event = await ingestTerminalIntent(stripe);
        if (event.status === 'failed') {
          throw new StripeIntegrationError(
            'Local terminal PaymentIntent reconciliation failed',
            502,
            'local_reconciliation_failed',
          );
        }
        await serviceRpc('complete_stripe_payment_intent_cancel', {
          payment_intent_id: candidate.id,
          succeeded: true,
          error_code: null,
          provider_status: stripe.status,
        });
        results.push({
          payment_intent_id: candidate.id,
          provider_reference: candidate.provider_reference,
          provider_status: stripe.status,
          outcome: event.outcome,
          succeeded: true,
        });
      } catch (error) {
        const errorCode = safeErrorCode(error);
        try {
          await serviceRpc('complete_stripe_payment_intent_cancel', {
            payment_intent_id: candidate.id,
            succeeded: false,
            error_code: errorCode,
            provider_status: null,
          });
        } catch {
          // The lease naturally expires; never replace the original safe error.
        }
        console.warn('stripe PaymentIntent cancellation deferred', candidate.id, errorCode);
        results.push({
          payment_intent_id: candidate.id,
          provider_reference: candidate.provider_reference,
          succeeded: false,
          error_code: errorCode,
        });
      }
    }

    return jsonResponse({ claimed: candidates.length, results });
  } catch (error) {
    console.error('stripe-reconcile-payment-intents failed', error instanceof Error ? error.name : 'unknown');
    return errorResponse(error);
  }
});
