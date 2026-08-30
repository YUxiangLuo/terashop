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
  normalizePayPalEvent,
  parsePayPalWebhookHeaders,
  payPalApiBase,
  payPalSha256Hex,
  parsePayPalLivemode,
  verifyPayPalWebhook,
} from '../_shared/paypal.ts';

interface ProviderEventResult {
  provider_event_id: string;
  status: 'received' | 'processed' | 'ignored' | 'failed';
  outcome: string | null;
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new HttpError('Webhook payload must be valid JSON', 400, 'invalid_event');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpError('Webhook payload must be an object', 400, 'invalid_event');
    }

    const livemode = parsePayPalLivemode(optionalEnv('PAYPAL_LIVEMODE', 'false'));
    const config = {
      clientId: requiredEnv('PAYPAL_CLIENT_ID'),
      clientSecret: requiredEnv('PAYPAL_CLIENT_SECRET'),
      apiBase: payPalApiBase(livemode, optionalEnv('PAYPAL_API_BASE')),
    };
    const headers = parsePayPalWebhookHeaders(request.headers, livemode);
    await verifyPayPalWebhook(
      parsed as Record<string, unknown>,
      headers,
      requiredEnv('PAYPAL_WEBHOOK_ID'),
      config,
    );
    const event = normalizePayPalEvent(parsed);
    const result = await serviceRpc<ProviderEventResult>('ingest_payment_provider_event', {
      provider: 'paypal',
      provider_event_id: event.providerEventId,
      source: 'webhook',
      event_type: event.eventType,
      object_reference: event.objectReference,
      livemode,
      occurred_at: event.occurredAt,
      payload_hash: await payPalSha256Hex(raw),
      data: event.data,
    });
    if (result.status === 'failed') {
      console.error('paypal webhook database processing failed', result.provider_event_id, result.error);
      return jsonResponse({ received: true, processed: false }, 500);
    }
    return jsonResponse({
      received: true,
      processed: result.status === 'processed' || result.status === 'ignored',
      pending_reconciliation: result.status === 'received' || result.outcome === 'action_required',
    });
  } catch (error) {
    console.error('paypal-webhook rejected request', error instanceof Error ? error.name : 'unknown');
    return errorResponse(error);
  }
});
