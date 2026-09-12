/// <reference path="../_shared/deno.d.ts" />
import {
  errorResponse,
  HttpError,
  jsonResponse,
  optionalEnv,
  readJsonBody,
  requiredEnv,
  requireServiceRoleRequest,
  serviceRpc,
} from '../_shared/http.ts';
import {
  normalizedPayPalRefundData,
  payPalApiBase,
  parsePayPalLivemode,
  type PayPalRefund,
  payPalRequest,
  paypalOccurredAt,
  validatePayPalRefund,
} from '../_shared/paypal.ts';
import { ingestApiPaymentEvent } from '../_shared/provider-events.ts';

interface RefundRequestDto {
  id: string;
  order_id: string;
  amount: number | string;
  currency: string;
  provider_reference: string;
  parent_provider_reference: string;
}

Deno.serve(async (request) => {
  try {
    if (request.method !== 'POST') throw new HttpError('Method not allowed', 405, 'method_not_allowed');
    requireServiceRoleRequest(request);
    const body = await readJsonBody(request);
    const maxEvents = body.max_events === undefined ? 20 : Number(body.max_events);
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 20) {
      throw new HttpError('max_events must be between 1 and 20');
    }

    const livemode = parsePayPalLivemode(optionalEnv('PAYPAL_LIVEMODE', 'false'));
    const config = {
      clientId: requiredEnv('PAYPAL_CLIENT_ID'),
      clientSecret: requiredEnv('PAYPAL_CLIENT_SECRET'),
      apiBase: payPalApiBase(livemode, optionalEnv('PAYPAL_API_BASE')),
    };
    const candidates = await serviceRpc<RefundRequestDto[]>('list_pending_provider_refunds', {
      provider: 'paypal',
      max_requests: maxEvents,
    });
    const results: Array<Record<string, unknown>> = [];
    for (const local of candidates) {
      try {
        const refund = await payPalRequest<PayPalRefund>(
          `/v2/payments/refunds/${encodeURIComponent(local.provider_reference)}`,
          { ...config, method: 'GET' },
        );
        validatePayPalRefund(refund, local, false);
        const data = normalizedPayPalRefundData(refund, local);
        const occurredAt = paypalOccurredAt(refund.update_time ?? refund.create_time);
        const event = await ingestApiPaymentEvent({
          provider: 'paypal', resource: 'refund', reference: refund.id, status: refund.status,
          eventType: 'paypal.refund.api_result', livemode, occurredAt, data,
        });
        results.push({ refund_request_id: local.id, status: event.status, outcome: event.outcome });
      } catch (error) {
        console.error(
          'paypal refund reconciliation failed',
          local.id,
          error instanceof Error ? error.name : 'unknown',
        );
        results.push({ refund_request_id: local.id, status: 'retry_required' });
      }
    }
    return jsonResponse({ processed: results.length, results });
  } catch (error) {
    console.error('paypal-reconcile-refunds rejected request', error instanceof Error ? error.name : 'unknown');
    return errorResponse(error);
  }
});
