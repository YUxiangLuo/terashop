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
  extractPayPalCapture,
  ingestPayPalCapture,
  type LocalPayPalIntent,
  type PayPalOrder,
  payPalClientConfig,
  payPalRequest,
} from '../_shared/paypal.ts';

export async function handlePayPalReconcileCaptures(request: Request): Promise<Response> {
  try {
    if (request.method !== 'POST') throw new HttpError('Method not allowed', 405, 'method_not_allowed');
    requireServiceRoleRequest(request);
    const body = await readJsonBody(request);
    const maxEvents = body.max_events === undefined ? 20 : body.max_events;
    if (typeof maxEvents !== 'number' || !Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 20) {
      throw new HttpError('max_events must be an integer between 1 and 20');
    }

    const config = payPalClientConfig();
    const candidates = await serviceRpc<LocalPayPalIntent[]>('list_pending_paypal_captures', {
      max_requests: maxEvents,
    });
    const results: Array<Record<string, unknown>> = [];
    for (const local of candidates) {
      try {
        if (!local.provider_reference) throw new HttpError('PayPal Order is not bound', 409, 'provider_reference_missing');
        // Never POST capture here, even when APPROVED or the local order expired.
        const order = await payPalRequest<PayPalOrder>(
          `/v2/checkout/orders/${encodeURIComponent(local.provider_reference)}`,
          { ...config, method: 'GET' },
        );
        // Validate identity, but let Inbox retain mismatched successful money.
        const capture = extractPayPalCapture(order, local, false);
        if (!capture) {
          results.push({ payment_intent_id: local.id, status: 'awaiting_capture', provider_status: order.status });
          continue;
        }
        const event = await ingestPayPalCapture(capture, local, local.provider_reference, config.livemode);
        results.push({ payment_intent_id: local.id, status: event.status, outcome: event.outcome });
      } catch (error) {
        console.error('paypal capture reconciliation failed', local.id, error instanceof Error ? error.name : 'unknown');
        results.push({ payment_intent_id: local.id, status: 'retry_required' });
      }
    }
    return jsonResponse({ processed: results.length, results });
  } catch (error) {
    console.error('paypal-reconcile-captures rejected request', error instanceof Error ? error.name : 'unknown');
    return errorResponse(error);
  }
}
