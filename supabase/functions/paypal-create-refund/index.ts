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
  normalizeCnyAmount,
  normalizedPayPalRefundData,
  payPalApiBase,
  parsePayPalLivemode,
  type PayPalRefund,
  payPalRequest,
  payPalSha256Hex,
  paypalOccurredAt,
  requirePayPalId,
  validatePayPalRefund,
} from '../_shared/paypal.ts';

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

function localRefundStatus(status: string): string {
  switch (status.toUpperCase()) {
    case 'COMPLETED': return 'succeeded';
    case 'PENDING': return 'pending';
    case 'FAILED': return 'failed';
    case 'CANCELLED': return 'cancelled';
    default: throw new HttpError(`Unsupported PayPal refund status ${status}`, 502, 'paypal_bad_response');
  }
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

async function ingestRefund(
  refund: PayPalRefund,
  local: RefundRequestDto,
  livemode: boolean,
): Promise<ProviderEventResult> {
  const data = normalizedPayPalRefundData(refund, local);
  const occurredAt = paypalOccurredAt(refund.update_time ?? refund.create_time);
  const payloadHash = await payPalSha256Hex(JSON.stringify({ occurred_at: occurredAt, data }));
  return serviceRpc<ProviderEventResult>('ingest_payment_provider_event', {
    provider: 'paypal',
    provider_event_id: `api:refund:${refund.id}:${refund.status}:${payloadHash.slice(0, 16)}`,
    source: 'api_response',
    event_type: 'paypal.refund.api_result',
    object_reference: refund.id,
    livemode,
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
    const body = await readJsonBody(request, 65536);
    const orderId = requireUuid(body.order_id, 'order_id');
    const idempotencyKey = requireIdempotencyKey(body.idempotency_key);
    const items = normalizeItems(body.items);
    const amount = body.amount === undefined || body.amount === null ? null : body.amount;
    if (items && amount !== null) throw new HttpError('Pass either items or amount, not both');
    if (amount !== null && typeof amount !== 'string' && typeof amount !== 'number') {
      throw new HttpError('amount must be a decimal');
    }
    if (amount !== null) normalizeCnyAmount(amount, 'CNY');
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
      provider: 'paypal',
      idempotency_key: idempotencyKey,
      items,
      amount,
      reason,
      restock,
      metadata: { edge_function: 'paypal-create-refund' },
    });
    requirePayPalId(local.parent_provider_reference, 'capture id');

    const livemode = parsePayPalLivemode(optionalEnv('PAYPAL_LIVEMODE', 'false'));
    const config = {
      livemode,
      clientId: requiredEnv('PAYPAL_CLIENT_ID'),
      clientSecret: requiredEnv('PAYPAL_CLIENT_SECRET'),
      apiBase: payPalApiBase(livemode, optionalEnv('PAYPAL_API_BASE')),
    };
    const refund = local.provider_reference
      ? await payPalRequest<PayPalRefund>(
          `/v2/payments/refunds/${encodeURIComponent(local.provider_reference)}`,
          { ...config, method: 'GET' },
        )
      : await payPalRequest<PayPalRefund>(
          `/v2/payments/captures/${encodeURIComponent(local.parent_provider_reference)}/refund`,
          {
            ...config,
            idempotencyKey: local.id,
            preferRepresentation: true,
            body: {
              amount: {
                value: normalizeCnyAmount(local.amount, local.currency),
                currency_code: local.currency,
              },
              custom_id: local.id,
              invoice_id: `TERA-REFUND-${local.id}`,
            },
          },
        );
    validatePayPalRefund(refund, local, false);
    await serviceRpc<RefundRequestDto>('bind_refund_request_provider', {
      refund_request_id: local.id,
      provider_reference: refund.id,
      provider_status: localRefundStatus(refund.status),
      amount: normalizeCnyAmount(local.amount, local.currency),
      currency: local.currency,
    });
    const event = await ingestRefund(refund, local, livemode);
    if (event.status === 'failed') {
      throw new HttpError(
        'Refund was accepted by PayPal but local reconciliation is pending',
        502,
        'refund_reconciliation_pending',
      );
    }
    return jsonResponse({
      refund_request_id: local.id,
      order_id: local.order_id,
      provider: 'paypal',
      provider_reference: refund.id,
      provider_status: refund.status,
      amount: local.amount,
      currency: local.currency,
      processing_status: event.outcome,
      pending_reconciliation: event.outcome === 'action_required',
    }, 200, cors);
  } catch (error) {
    console.error('paypal-create-refund failed', error instanceof Error ? error.name : 'unknown');
    return errorResponse(error, cors);
  }
});
