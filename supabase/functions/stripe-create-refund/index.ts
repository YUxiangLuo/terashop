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
  minorUnitsToDecimal,
  sha256Hex,
  stripeRequest,
  type StripeRefundResponse,
} from '../_shared/stripe.ts';

interface RefundRequestDto {
  id: string;
  order_id: string;
  provider: string;
  status: string;
  amount: number | string;
  currency: string;
  provider_reference: string | null;
  parent_provider_reference: string;
}

interface ProviderEventResult {
  status: string;
  outcome: string | null;
}

function normalizeItems(value: unknown): Array<{ order_item_id: string; quantity: number }> | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new HttpError('items must be a non-empty array with at most 100 lines');
  }
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new HttpError('Invalid refund item');
    const row = item as Record<string, unknown>;
    const id = requireUuid(row.order_item_id, 'order_item_id');
    if (!Number.isSafeInteger(row.quantity) || Number(row.quantity) <= 0) {
      throw new HttpError('Refund quantity must be a positive integer');
    }
    return { order_item_id: id, quantity: Number(row.quantity) };
  });
}

function normalizedRefundData(refund: StripeRefundResponse, request: RefundRequestDto): Record<string, unknown> {
  return {
    object_type: 'refund',
    status: refund.status,
    amount_minor: String(refund.amount),
    currency: refund.currency.toLowerCase(),
    payment_intent_reference: typeof refund.payment_intent === 'string'
      ? refund.payment_intent
      : request.parent_provider_reference,
    charge_reference: typeof refund.charge === 'string' ? refund.charge : null,
    failure_code: typeof refund.failure_reason === 'string' ? refund.failure_reason : null,
    failure_message: typeof refund.failure_reason === 'string' ? refund.failure_reason : null,
    pending_reason: typeof refund.pending_reason === 'string' ? refund.pending_reason : null,
    metadata: {
      tera_refund_request_id: request.id,
      tera_order_id: request.order_id,
    },
  };
}

Deno.serve(async (request) => {
  let cors: Record<string, string> = {};
  try {
    cors = corsHeaders(request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') throw new HttpError('Method not allowed', 405, 'method_not_allowed');

    const user = await authenticatedUser(request);
    const body = await readJsonBody(request, 65536);
    const orderId = requireUuid(body.order_id, 'order_id');
    const idempotencyKey = requireIdempotencyKey(body.idempotency_key);
    const items = normalizeItems(body.items);
    const amount = body.amount === undefined || body.amount === null ? null : body.amount;
    if (items && amount !== null) throw new HttpError('Pass either items or amount, not both');
    if (amount !== null && typeof amount !== 'string' && typeof amount !== 'number') {
      throw new HttpError('amount must be a decimal');
    }
    if (amount !== null) decimalToMinorUnits(amount, 'CNY');
    if (body.reason !== undefined && body.reason !== null && typeof body.reason !== 'string') {
      throw new HttpError('reason must be text');
    }
    const reason = typeof body.reason === 'string' ? body.reason : null;
    if (reason && reason.length > 1000) throw new HttpError('reason must be at most 1000 characters');
    if (body.restock !== undefined && typeof body.restock !== 'boolean') {
      throw new HttpError('restock must be boolean');
    }
    const restock = body.restock === true;

    const local = await serviceRpc<RefundRequestDto>('create_refund_request', {
      order_id: orderId,
      actor_id: user.id,
      provider: 'stripe',
      idempotency_key: idempotencyKey,
      items,
      amount,
      reason,
      restock,
      metadata: { edge_function: 'stripe-create-refund' },
    });
    if (typeof local.parent_provider_reference !== 'string'
        || !/^(pi|ch)_/.test(local.parent_provider_reference)) {
      throw new HttpError('Captured Stripe payment has no refundable provider reference', 409, 'provider_reference_missing');
    }

    const secretKey = requiredEnv('STRIPE_SECRET_KEY');
    assertStripeKeyMode(secretKey, optionalEnv('STRIPE_LIVEMODE', 'false') === 'true');
    const apiBase = optionalEnv('STRIPE_API_BASE', 'https://api.stripe.com');
    const apiVersion = optionalEnv('STRIPE_API_VERSION', '2026-02-25.clover');
    const amountMinor = decimalToMinorUnits(local.amount, local.currency);
    const stripe = local.provider_reference
      ? await stripeRequest<StripeRefundResponse>(
          `/v1/refunds/${encodeURIComponent(local.provider_reference)}`,
          { secretKey, apiBase, apiVersion, method: 'GET' },
        )
      : await stripeRequest<StripeRefundResponse>('/v1/refunds', {
          secretKey,
          apiBase,
          apiVersion,
          idempotencyKey: `tera-refund-request-${local.id}`,
          form: {
            payment_intent: local.parent_provider_reference,
            amount: amountMinor,
            'metadata[tera_refund_request_id]': local.id,
            'metadata[tera_order_id]': local.order_id,
          },
        });
    if (stripe.object !== 'refund' || typeof stripe.id !== 'string'
        || String(stripe.amount) !== amountMinor
        || stripe.currency?.toUpperCase() !== local.currency
        || stripe.metadata?.tera_refund_request_id !== local.id) {
      throw new HttpError('Stripe Refund does not match the local request', 409, 'provider_mismatch');
    }
    await serviceRpc<RefundRequestDto>('bind_refund_request_provider', {
      refund_request_id: local.id,
      provider_reference: stripe.id,
      provider_status: stripe.status,
      amount: minorUnitsToDecimal(stripe.amount, stripe.currency),
      currency: stripe.currency,
    });

    const normalized = normalizedRefundData(stripe, local);
    const payload = JSON.stringify(normalized);
    const payloadHash = await sha256Hex(payload);
    const providerEventId = `api:refund:${stripe.id}:${stripe.status}:${payloadHash.slice(0, 16)}`;
    const occurredAt = new Date(
      Number.isSafeInteger(stripe.created) ? stripe.created * 1000 : Date.now(),
    ).toISOString();
    const event = await serviceRpc<ProviderEventResult>('ingest_payment_provider_event', {
      provider: 'stripe',
      provider_event_id: providerEventId,
      source: 'api_response',
      event_type: 'refund.api_result',
      object_reference: stripe.id,
      livemode: stripe.livemode ?? (optionalEnv('STRIPE_LIVEMODE', 'false') === 'true'),
      occurred_at: occurredAt,
      payload_hash: payloadHash,
      data: normalized,
    });
    if (event.status === 'failed') {
      throw new HttpError('Refund was accepted by Stripe but local reconciliation is pending', 502, 'refund_reconciliation_pending');
    }
    return jsonResponse({
      refund_request_id: local.id,
      order_id: local.order_id,
      provider: 'stripe',
      provider_reference: stripe.id,
      provider_status: stripe.status,
      amount: local.amount,
      currency: local.currency,
      processing_status: event.outcome,
    }, 200, cors);
  } catch (error) {
    console.error('stripe-create-refund failed', error instanceof Error ? error.name : 'unknown');
    return errorResponse(error, cors);
  }
});
