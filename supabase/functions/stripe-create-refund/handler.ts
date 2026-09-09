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
  normalizedStripeRefundData,
  parseStripeHttpTimeout,
  parseStripeLivemode,
  sha256Hex,
  stripeApiBase,
  stripeApiVersion,
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

function stripeTimeoutMs(): number {
  return parseStripeHttpTimeout(optionalEnv('STRIPE_HTTP_TIMEOUT_MS', '10000'));
}

function normalizeItems(value: unknown): Array<{ order_item_id: string; quantity: number }> | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new HttpError('items must be a non-empty array with at most 100 lines');
  }
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new HttpError('Invalid refund item');
    }
    const row = item as Record<string, unknown>;
    const id = requireUuid(row.order_item_id, 'order_item_id');
    if (!Number.isSafeInteger(row.quantity) || Number(row.quantity) <= 0) {
      throw new HttpError('Refund quantity must be a positive integer');
    }
    return { order_item_id: id, quantity: Number(row.quantity) };
  });
}

function validateStripeRefund(
  stripe: StripeRefundResponse,
  local: RefundRequestDto,
  enforceCorrelation: boolean,
): void {
  const statuses = new Set(['pending', 'requires_action', 'succeeded', 'failed', 'canceled']);
  const parentMatches = local.parent_provider_reference.startsWith('pi_')
    ? stripe.payment_intent === local.parent_provider_reference
    : local.parent_provider_reference.startsWith('ch_')
      ? stripe.charge === local.parent_provider_reference
      : false;
  if (stripe.object !== 'refund'
      || typeof stripe.id !== 'string' || !/^re_[A-Za-z0-9_]{3,252}$/.test(stripe.id)
      || !Number.isSafeInteger(stripe.amount) || stripe.amount <= 0
      || typeof stripe.currency !== 'string' || !/^[A-Za-z]{3}$/.test(stripe.currency)
      || typeof stripe.status !== 'string' || !statuses.has(stripe.status)
      || !Number.isSafeInteger(stripe.created)
      || stripe.created < 1_230_768_000 || stripe.created > 253_402_300_799
      || (enforceCorrelation && stripe.metadata?.tera_refund_request_id !== local.id)
      || (enforceCorrelation && stripe.metadata?.tera_order_id !== local.order_id)
      || (enforceCorrelation && !parentMatches)
      || (enforceCorrelation && local.provider_reference !== null
          && local.provider_reference !== stripe.id)) {
    throw new HttpError('Stripe Refund does not match the local request', 409, 'provider_mismatch');
  }
}

async function ingestStripeRefund(
  stripe: StripeRefundResponse,
  livemode: boolean,
): Promise<ProviderEventResult> {
  const data = normalizedStripeRefundData(stripe);
  const occurredAt = new Date(stripe.created * 1000).toISOString();
  const payloadHash = await sha256Hex(JSON.stringify({ occurred_at: occurredAt, data }));
  return serviceRpc<ProviderEventResult>('ingest_payment_provider_event', {
    provider: 'stripe',
    provider_event_id: `api:refund:${stripe.id}:${stripe.status}:${payloadHash.slice(0, 16)}`,
    source: 'api_response',
    event_type: 'refund.api_result',
    object_reference: stripe.id,
    // Refund objects have no livemode; the authenticated API key determines it.
    livemode,
    occurred_at: occurredAt,
    payload_hash: payloadHash,
    data,
  });
}

export async function handleStripeCreateRefund(request: Request): Promise<Response> {
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
    if (reason && reason.length > 1000) {
      throw new HttpError('reason must be at most 1000 characters');
    }
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
        || !/^(pi|ch)_[A-Za-z0-9_]{3,252}$/.test(local.parent_provider_reference)) {
      throw new HttpError(
        'Captured Stripe payment has no refundable provider reference',
        409,
        'provider_reference_missing',
      );
    }

    const livemode = parseStripeLivemode(optionalEnv('STRIPE_LIVEMODE', 'false'));
    const secretKey = requiredEnv('STRIPE_SECRET_KEY');
    assertStripeKeyMode(secretKey, livemode);
    const apiBase = stripeApiBase(livemode, optionalEnv('STRIPE_API_BASE'));
    const apiVersion = stripeApiVersion(
      optionalEnv('STRIPE_API_VERSION', '2026-02-25.clover'),
    );
    const amountMinor = decimalToMinorUnits(local.amount, local.currency);
    const stripe = local.provider_reference
      ? await stripeRequest<StripeRefundResponse>(
          `/v1/refunds/${encodeURIComponent(local.provider_reference)}`,
          {
            secretKey,
            apiBase,
            apiVersion,
            method: 'GET',
            timeoutMs: stripeTimeoutMs(),
          },
        )
      : await stripeRequest<StripeRefundResponse>('/v1/refunds', {
          secretKey,
          apiBase,
          apiVersion,
          idempotencyKey: `tera-refund-request-${local.id}`,
          timeoutMs: stripeTimeoutMs(),
          form: {
            [local.parent_provider_reference.startsWith('pi_') ? 'payment_intent' : 'charge']:
              local.parent_provider_reference,
            amount: amountMinor,
            'metadata[tera_refund_request_id]': local.id,
            'metadata[tera_order_id]': local.order_id,
          },
        });

    const providerSucceeded = stripe.status === 'succeeded';
    validateStripeRefund(stripe, local, !providerSucceeded);
    if (providerSucceeded) {
      const parentMatches = local.parent_provider_reference.startsWith('pi_')
        ? stripe.payment_intent === local.parent_provider_reference
        : stripe.charge === local.parent_provider_reference;
      const correlationMatches = stripe.metadata?.tera_refund_request_id === local.id
        && stripe.metadata?.tera_order_id === local.order_id
        && parentMatches
        && (local.provider_reference === null || local.provider_reference === stripe.id);
      if (correlationMatches) {
        await serviceRpc<RefundRequestDto>('bind_refund_request_provider', {
          refund_request_id: local.id,
          provider_reference: stripe.id,
          provider_status: stripe.status,
          amount: local.amount,
          currency: local.currency,
        });
      }
    } else {
      await serviceRpc<RefundRequestDto>('bind_refund_request_provider', {
        refund_request_id: local.id,
        provider_reference: stripe.id,
        provider_status: stripe.status,
        amount: local.amount,
        currency: local.currency,
      });
    }

    const event = await ingestStripeRefund(stripe, livemode);
    if (event.status === 'failed') {
      throw new HttpError(
        'Refund exists at Stripe but local reconciliation is pending',
        502,
        'refund_reconciliation_pending',
      );
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
      pending_reconciliation: providerSucceeded && event.outcome !== 'refunded',
    }, 200, cors);
  } catch (error) {
    console.error('stripe-create-refund failed', error instanceof Error ? error.name : 'unknown');
    return errorResponse(error, cors);
  }
}
