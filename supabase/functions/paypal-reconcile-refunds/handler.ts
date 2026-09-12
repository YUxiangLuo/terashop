/// <reference path="../_shared/deno.d.ts" />
import {
  errorResponse,
  HttpError,
  jsonResponse,
  readJsonBody,
  requireServiceRoleRequest,
  serviceRpc,
} from '../_shared/http.ts';
import {
  type PayPalRefund,
  payPalRequest,
  validatePayPalRefund,
  ingestPayPalRefund,
  payPalClientConfig,
} from '../_shared/paypal.ts';

interface RefundRequestDto {
  id: string;
  order_id: string;
  amount: number | string;
  currency: string;
  provider_reference: string;
  parent_provider_reference: string;
}

export async function handlePayPalReconcileRefunds(request: Request): Promise<Response> {
  try {
    if (request.method !== 'POST') throw new HttpError('Method not allowed', 405, 'method_not_allowed');
    requireServiceRoleRequest(request);
    const body = await readJsonBody(request);
    const maxEvents = body.max_events === undefined ? 20 : Number(body.max_events);
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 20) {
      throw new HttpError('max_events must be between 1 and 20');
    }

    const config = payPalClientConfig();
    const { livemode } = config;
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
        const event = await ingestPayPalRefund(refund, local, livemode);
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
}
