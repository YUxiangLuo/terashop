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
  configuredRedirectUrl,
  extractPayPalCapture,
  type LocalPayPalIntent,
  normalizeCheckoutAmount,
  payPalApprovalUrl,
  type PayPalOrder,
  payPalRequest,
  payPalShippingUnit,
  validatePayPalOrder,
  ingestPayPalCapture,
  payPalClientConfig,
} from '../_shared/paypal.ts';

function bindStatus(status: string): 'requires_action' | 'processing' {
  if (status === 'CREATED' || status === 'PAYER_ACTION_REQUIRED' || status === 'SAVED') {
    return 'requires_action';
  }
  if (status === 'APPROVED' || status === 'COMPLETED') return 'processing';
  throw new HttpError(`PayPal Order is not payable (${status})`, 409, 'payment_intent_terminal');
}

export async function handlePayPalCreateOrder(request: Request): Promise<Response> {
  let cors: Record<string, string> = {};
  try {
    cors = corsHeaders(request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') throw new HttpError('Method not allowed', 405, 'method_not_allowed');

    const user = await authenticatedUser(request);
    const body = await readJsonBody(request);
    const orderId = requireUuid(body.order_id, 'order_id');
    const idempotencyKey = requireIdempotencyKey(body.idempotency_key);
    const local = await serviceRpc<LocalPayPalIntent>('create_payment_intent_for_customer', {
      order_id: orderId,
      actor_id: user.id,
      provider: 'paypal',
      idempotency_key: idempotencyKey,
      metadata: { edge_function: 'paypal-create-order' },
    });
    if (local.provider !== 'paypal') throw new HttpError('Unexpected payment provider', 500, 'provider_mismatch');
    if (['succeeded', 'failed', 'cancelled'].includes(local.status)) {
      throw new HttpError(`Payment intent is terminal (${local.status})`, 409, 'payment_intent_terminal');
    }
    if (local.expires_at && Date.parse(local.expires_at) <= Date.now()) {
      throw new HttpError('Payment intent has expired', 409, 'payment_intent_expired');
    }

    const config = payPalClientConfig();
    const amount = normalizeCheckoutAmount(local.amount, local.currency);
    const brandName = optionalEnv('PAYPAL_BRAND_NAME', 'Tera Store');
    if (brandName.length > 127) throw new HttpError('PAYPAL_BRAND_NAME is too long', 500, 'server_misconfigured');
    const order = local.provider_reference
      ? await payPalRequest<PayPalOrder>(
          `/v2/checkout/orders/${encodeURIComponent(local.provider_reference)}`,
          { ...config, method: 'GET' },
        )
      : await payPalRequest<PayPalOrder>('/v2/checkout/orders', {
          ...config,
          idempotencyKey: local.id,
          preferRepresentation: true,
          body: {
            intent: 'CAPTURE',
            purchase_units: [{
              reference_id: local.order_id,
              custom_id: local.id,
              invoice_id: `TERA-${local.order_number}-${local.id.slice(0, 8)}`,
              amount: { currency_code: local.currency, value: amount },
              shipping: payPalShippingUnit(local.shipping_address),
            }],
            payment_source: {
              paypal: {
                experience_context: {
                  payment_method_preference: 'IMMEDIATE_PAYMENT_REQUIRED',
                  user_action: 'PAY_NOW',
                  shipping_preference: 'SET_PROVIDED_ADDRESS',
                  brand_name: brandName,
                  return_url: configuredRedirectUrl(
                    requiredEnv('PAYPAL_RETURN_URL'), 'PAYPAL_RETURN_URL',
                  ),
                  cancel_url: configuredRedirectUrl(
                    requiredEnv('PAYPAL_CANCEL_URL'), 'PAYPAL_CANCEL_URL',
                  ),
                },
              },
            },
          },
        });
    validatePayPalOrder(order, local, false);
    const capture = extractPayPalCapture(
      order, { ...local, provider_reference: order.id }, false,
    );
    if (!capture) validatePayPalOrder(order, local);
    const providerStatus = capture ? 'processing' : bindStatus(order.status);
    const bound = await serviceRpc<LocalPayPalIntent>('bind_payment_intent_provider', {
      payment_intent_id: local.id,
      provider_reference: order.id,
      provider_status: providerStatus,
      amount: local.amount,
      currency: local.currency,
    });

    const processing = capture
      ? await ingestPayPalCapture(capture, local, order.id, config.livemode)
      : null;
    if (processing?.status === 'failed') {
      throw new HttpError(
        'PayPal captured the order but local reconciliation is pending',
        502,
        'capture_reconciliation_pending',
      );
    }
    const approvalUrl = payPalApprovalUrl(order, config.livemode);
    if (providerStatus === 'requires_action' && !approvalUrl) {
      throw new HttpError('PayPal did not return an approval URL', 502, 'paypal_bad_response');
    }
    return jsonResponse({
      payment_intent_id: bound.id,
      order_id: bound.order_id,
      provider: 'paypal',
      provider_reference: order.id,
      provider_status: order.status,
      status: processing?.outcome ?? bound.status,
      amount: bound.amount,
      currency: bound.currency,
      approve_url: approvalUrl,
      expires_at: bound.expires_at,
      pending_reconciliation: processing?.outcome === 'action_required',
    }, 200, cors);
  } catch (error) {
    console.error('paypal-create-order failed', error instanceof Error ? error.name : 'unknown');
    return errorResponse(error, cors);
  }
}
