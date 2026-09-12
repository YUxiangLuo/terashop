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
  parseStripeLivemode,
  parseStripeWebhookSecrets,
  verifyStripeSignature,
} from '../_shared/stripe.ts';
import { sha256Hex } from '../_shared/provider-events.ts';

interface ProviderEventResult {
  event_id: string;
  status: string;
  outcome: string | null;
}

function signatureToleranceSeconds(): number {
  const value = Number(optionalEnv('STRIPE_WEBHOOK_TOLERANCE_SECONDS', '300'));
  if (!Number.isSafeInteger(value) || value < 30 || value > 900) {
    throw new HttpError(
      'STRIPE_WEBHOOK_TOLERANCE_SECONDS must be between 30 and 900',
      500,
      'server_misconfigured',
    );
  }
  return value;
}

Deno.serve(async (request) => {
  try {
    if (request.method !== 'POST') throw new HttpError('Method not allowed', 405, 'method_not_allowed');
    const contentType = request.headers.get('Content-Type')?.toLowerCase() ?? '';
    if (!contentType.startsWith('application/json')) {
      throw new HttpError('Stripe webhook must be JSON', 415, 'unsupported_media_type');
    }
    const declaredLength = Number(request.headers.get('Content-Length') ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > 262144) {
      throw new HttpError('Webhook body is too large', 413, 'payload_too_large');
    }
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > 262144) {
      throw new HttpError('Webhook body is too large', 413, 'payload_too_large');
    }
    const secrets = parseStripeWebhookSecrets(
      requiredEnv('STRIPE_WEBHOOK_SECRET'),
      optionalEnv('STRIPE_WEBHOOK_SECRETS'),
    );
    await verifyStripeSignature(rawBody, request.headers.get('Stripe-Signature'), secrets, {
      toleranceSeconds: signatureToleranceSeconds(),
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new HttpError('Invalid JSON body', 400, 'invalid_json');
    }
    const event = normalizeStripeEvent(parsed);
    const expectedLivemode = parseStripeLivemode(optionalEnv('STRIPE_LIVEMODE', 'false'));
    if (event.livemode !== expectedLivemode) {
      throw new HttpError('Stripe event livemode mismatch', 400, 'livemode_mismatch');
    }
    const result = await serviceRpc<ProviderEventResult>('ingest_payment_provider_event', {
      provider: 'stripe',
      provider_event_id: event.providerEventId,
      source: 'webhook',
      event_type: event.eventType,
      object_reference: event.objectReference,
      livemode: event.livemode,
      occurred_at: event.occurredAt,
      payload_hash: await sha256Hex(rawBody),
      data: event.data,
    });

    if (result.status === 'failed') {
      // The inbox row is durable. A trusted retry worker owns business-state recovery;
      // acknowledging here avoids Stripe retry storms during lock or dependency incidents.
      console.warn('stripe-webhook queued for retry', event.providerEventId);
      return jsonResponse({
        received: true,
        processed: false,
        retry_scheduled: true,
      });
    }
    return jsonResponse({ received: true, processed: result.status === 'processed' });
  } catch (error) {
    console.error('stripe-webhook failed', error instanceof Error ? error.name : 'unknown');
    return errorResponse(error);
  }
});
