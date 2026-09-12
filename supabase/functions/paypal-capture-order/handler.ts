/// <reference path="../_shared/deno.d.ts" />
import {
  authenticatedUser,
  corsHeaders,
  errorResponse,
  HttpError,
  jsonResponse,
  readJsonBody,
  requireUuid,
  serviceRpc,
} from '../_shared/http.ts';
import {
  extractPayPalCapture,
  type LocalPayPalIntent,
  type PayPalOrder,
  payPalRequest,
  validatePayPalOrder,
  ingestPayPalCapture,
  payPalClientConfig,
} from '../_shared/paypal.ts';

export async function handlePayPalCaptureOrder(request: Request): Promise<Response> {
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
      actor_id: user.id,
      provider: 'paypal',
    });
    if (!local.provider_reference) {
      throw new HttpError('PayPal Order has not been created', 409, 'provider_reference_missing');
    }
    const config = payPalClientConfig();
    const { livemode } = config;
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
      // Recheck after the provider GET and durably reserve the capture command.
      // Cancellation must observe this marker; ambiguous network failures retain it
      // and retries use the same provider idempotency key instead of guessing failure.
      await serviceRpc('prepare_paypal_capture', {
        payment_intent_id: local.id,
        actor_id: user.id,
      });
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
    const result = await ingestPayPalCapture(capture, local, local.provider_reference, livemode);
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
      pending_reconciliation: result.status === 'received' || result.outcome === 'action_required',
    }, 200, cors);
  } catch (error) {
    console.error('paypal-capture-order failed', error instanceof Error ? error.name : 'unknown');
    return errorResponse(error, cors);
  }
}
