/// <reference path="../_shared/deno.d.ts" />
import {
  authenticatedUser, corsHeaders, errorResponse, HttpError, jsonResponse,
} from '../_shared/http.ts';
import {
  payPalBrowserToken, payPalClientConfig, requirePayPalCardsEnabled,
} from '../_shared/paypal.ts';

export async function handlePayPalClientToken(request: Request): Promise<Response> {
  let cors: Record<string, string> = {};
  try {
    cors = corsHeaders(request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') throw new HttpError('Method not allowed', 405, 'method_not_allowed');
    await authenticatedUser(request);
    requirePayPalCardsEnabled();
    return jsonResponse(await payPalBrowserToken(payPalClientConfig()), 200, cors);
  } catch (error) {
    console.error('paypal-client-token failed', error instanceof Error ? error.name : 'unknown');
    return errorResponse(error, cors);
  }
}
