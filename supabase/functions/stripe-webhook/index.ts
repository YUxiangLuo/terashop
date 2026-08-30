/// <reference path="../_shared/deno.d.ts" />
import {
  errorResponse,
  HttpError,
  jsonResponse,
  optionalEnv,
  requiredEnv,
  serviceRpc,
} from '../_shared/http.ts';
import {
  normalizeStripeEvent,
  sha256Hex,
  verifyStripeSignature,
} from '../_shared/stripe.ts';

interface ProviderEventResult {
  event_id: string;
  provider_event_id: string;
  status: 'received' | 'processed' | 'ignored' | 'failed';
  outcome: string | null;
  resource_type: string | null;
  resource_id: string | null;
  error?: string | null;
}

Deno.serve(async (request) => {
  try {
    if (request.method !== 'POST') throw new HttpError('Method not allowed', 405, 'method_not_allowed');
    const length = Number(request.headers.get('Content-Length') ?? 0);
    if (Number.isFinite(length) && length > 262144) {
      throw new HttpError('Webhook payload is too large', 413, 'body_too_large');
    }
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 262144) {
      throw new HttpError('Webhook payload is too large', 413, 'body_too_large');
    }
    const secrets = (optionalEnv('STRIPE_WEBHOOK_SECRETS') || requiredEnv('STRIPE_WEBHOOK_SECRET'))
      .split(',').map((value) => value.trim()).filter(Boolean);
    const tolerance = Number(optionalEnv('STRIPE_WEBHOOK_TOLERANCE_SECONDS', '300'));
    await verifyStripeSignature(raw, request.headers.get('Stripe-Signature'), secrets, {
      toleranceSeconds: Number.isSafeInteger(tolerance) && tolerance >= 30 && tolerance <= 900
        ? tolerance
        : 300,
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new HttpError('Webhook payload must be valid JSON', 400, 'invalid_event');
    }
    const event = normalizeStripeEvent(parsed);
    const expectedLivemode = optionalEnv('STRIPE_LIVEMODE', 'false') === 'true';
    if (event.livemode !== expectedLivemode) {
      throw new HttpError('Stripe livemode does not match this deployment', 400, 'livemode_mismatch');
    }
    const result = await serviceRpc<ProviderEventResult>('ingest_payment_provider_event', {
      provider: 'stripe',
      provider_event_id: event.providerEventId,
      source: 'webhook',
      event_type: event.eventType,
      object_reference: event.objectReference,
      livemode: event.livemode,
      occurred_at: event.occurredAt,
      payload_hash: await sha256Hex(raw),
      data: event.data,
    });
    if (result.status === 'failed') {
      console.error('stripe webhook database processing failed', result.provider_event_id, result.error);
      return jsonResponse({ received: true, processed: false }, 500);
    }
    return jsonResponse({
      received: true,
      processed: result.status === 'processed' || result.status === 'ignored',
      pending_reconciliation: result.status === 'received' || result.outcome === 'action_required',
    });
  } catch (error) {
    console.error('stripe-webhook rejected request', error instanceof Error ? error.name : 'unknown');
    return errorResponse(error);
  }
});
