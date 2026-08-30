/// <reference path="../_shared/deno.d.ts" />
import {
  authenticatedUser,
  corsHeaders,
  errorResponse,
  HttpError,
  jsonResponse,
  optionalEnv,
  readJsonBody,
  requiredEnv,
  requireUuid,
  serviceRpc,
} from '../_shared/http.ts';
import {
  extractPayPalCapture,
  type LocalPayPalIntent,
  normalizedPayPalCaptureData,
  payPalApiBase,
  parsePayPalLivemode,
  type PayPalCapture,
  type PayPalOrder,
  payPalRequest,
  payPalSha256Hex,
  paypalOccurredAt,
  validatePayPalOrder,
} from '../_shared/paypal.ts';

interface ProviderEventResult {
  status: string;
  outcome: string | null;
}

async function ingestCapture(
  capture: PayPalCapture,
  local: LocalPayPalIntent,
  livemode: boolean,
): Promise<ProviderEventResult> {
  const data = normalizedPayPalCaptureData(capture, local, local.provider_reference!);
  const occurredAt = paypalOccurredAt(capture.update_time ?? capture.create_time);
  const payloadHash = await payPalSha256Hex(JSON.stringify({ occurred_at: occurredAt, data }));
  return serviceRpc<ProviderEventResult>('ingest_payment_provider_event', {
    provider: 'paypal',
    provider_event_id: `api:capture:${capture.id}:${capture.status}:${payloadHash.slice(0, 16)}`,
    source: 'api_response',
    event_type: 'paypal.capture.api_result',
    object_reference: capture.id,
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
    const body = await readJsonBody(request);
    const paymentIntentId = requireUuid(body.payment_intent_id, 'payment_intent_id');
    const local = await serviceRpc<LocalPayPalIntent>('get_payment_intent_for_customer', {
      payment_intent_id: paymentIntentId,
      customer_id: user.id,
      provider: 'paypal',
    });
    if (!local.provider_reference) {
      throw new HttpError('PayPal Order has not been created', 409, 'provider_reference_missing');
    }
    const livemode = parsePayPalLivemode(optionalEnv('PAYPAL_LIVEMODE', 'false'));
    const config = {
      livemode,
      clientId: requiredEnv('PAYPAL_CLIENT_ID'),
      clientSecret: requiredEnv('PAYPAL_CLIENT_SECRET'),
      apiBase: payPalApiBase(livemode, optionalEnv('PAYPAL_API_BASE')),
    };
    let order = await payPalRequest<PayPalOrder>(
      `/v2/checkout/orders/${encodeURIComponent(local.provider_reference)}`,
      { ...config, method: 'GET' },
    );
    validatePayPalOrder(order, local, false);
    let capture = extractPayPalCapture(order, local, false);

    if (!capture) {
      validatePayPalOrder(order, local);
      if (['failed', 'cancelled', 'succeeded'].includes(local.status)) {
        throw new HttpError(`Payment intent is terminal (${local.status})`, 409, 'payment_intent_terminal');
      }
      if (local.expires_at && Date.parse(local.expires_at) <= Date.now()) {
        throw new HttpError('Payment intent has expired', 409, 'payment_intent_expired');
      }
      if (order.status !== 'APPROVED') {
        throw new HttpError(
          `PayPal Order cannot be captured (${order.status})`,
          409,
          'paypal_order_not_approved',
        );
      }
      order = await payPalRequest<PayPalOrder>(
        `/v2/checkout/orders/${encodeURIComponent(local.provider_reference)}/capture`,
        {
          ...config,
          idempotencyKey: local.id,
          preferRepresentation: true,
          body: {},
        },
      );
      validatePayPalOrder(order, local, false);
      capture = extractPayPalCapture(order, local, false);
    }
    if (!capture) {
      throw new HttpError('PayPal did not return a Capture', 502, 'paypal_bad_response');
    }
    const result = await ingestCapture(capture, local, livemode);
    if (result.status === 'failed') {
      throw new HttpError(
        'PayPal captured the order but local reconciliation is pending',
        502,
        'capture_reconciliation_pending',
      );
    }
    return jsonResponse({
      payment_intent_id: local.id,
      order_id: local.order_id,
      provider: 'paypal',
      provider_order_id: local.provider_reference,
      capture_id: capture.id,
      provider_status: capture.status,
      amount: local.amount,
      currency: local.currency,
      processing_status: result.outcome,
      pending_reconciliation: result.outcome === 'action_required',
    }, 200, cors);
  } catch (error) {
    console.error('paypal-capture-order failed', error instanceof Error ? error.name : 'unknown');
    return errorResponse(error, cors);
  }
});
