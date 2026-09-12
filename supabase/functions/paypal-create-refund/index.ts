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
  serviceRpc,
} from '../_shared/http.ts';
import {
  normalizeCnyAmount,
  normalizedPayPalRefundData,
  payPalApiBase,
  parsePayPalLivemode,
  type PayPalRefund,
  payPalRequest,
  paypalOccurredAt,
  requirePayPalId,
  validatePayPalRefund,
} from '../_shared/paypal.ts';
import { ingestApiPaymentEvent, type ProviderEventResult } from '../_shared/provider-events.ts';
import { parseRefundRequest, type RefundRequestDto } from '../_shared/refunds.ts';

function localRefundStatus(status: string): string {
  switch (status.toUpperCase()) {
    case 'COMPLETED': return 'succeeded';
    case 'PENDING': return 'pending';
    case 'FAILED': return 'failed';
    case 'CANCELLED': return 'cancelled';
    default: throw new HttpError(`Unsupported PayPal refund status ${status}`, 502, 'paypal_bad_response');
  }
}

async function ingestRefund(
  refund: PayPalRefund,
  local: RefundRequestDto,
  livemode: boolean,
): Promise<ProviderEventResult> {
  const data = normalizedPayPalRefundData(refund, local);
  const occurredAt = paypalOccurredAt(refund.update_time ?? refund.create_time);
  return ingestApiPaymentEvent({
    provider: 'paypal', resource: 'refund', reference: refund.id, status: refund.status,
    eventType: 'paypal.refund.api_result', livemode, occurredAt, data,
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
    const refundRequest = parseRefundRequest(body, normalizeCnyAmount);
    const local = await serviceRpc<RefundRequestDto>('create_refund_request', {
      ...refundRequest,
      actor_id: user.id,
      provider: 'paypal',
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
