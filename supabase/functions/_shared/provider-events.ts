import { serviceRpc } from './http.ts';

export interface ProviderEventResult {
  status: string;
  outcome: string | null;
}

interface ApiPaymentEvent {
  provider: 'paypal';
  resource: 'capture' | 'refund';
  reference: string;
  status: string;
  eventType: string;
  livemode: boolean;
  occurredAt: string;
  data: Record<string, unknown>;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Only trusted API observations use this envelope. Webhooks hash the unchanged
// raw body and keep their provider event ID. Callers own validation, normalization
// and timestamp policy; changing any of these can break persisted idempotency.
export async function ingestApiPaymentEvent(event: ApiPaymentEvent): Promise<ProviderEventResult> {
  const payloadHash = await sha256Hex(JSON.stringify({
    occurred_at: event.occurredAt, data: event.data,
  }));
  return serviceRpc<ProviderEventResult>('ingest_payment_provider_event', {
    provider: event.provider,
    provider_event_id: `api:${event.resource}:${event.reference}:${event.status}:${payloadHash.slice(0, 16)}`,
    source: 'api_response',
    event_type: event.eventType,
    object_reference: event.reference,
    livemode: event.livemode,
    occurred_at: event.occurredAt,
    payload_hash: payloadHash,
    data: event.data,
  });
}
