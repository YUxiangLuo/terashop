import { optionalEnv, requiredEnv } from './http.ts';
import { ingestApiPaymentEvent, type ProviderEventResult } from './provider-events.ts';

export function payPalClientConfig() {
  const livemode = parsePayPalLivemode(optionalEnv('PAYPAL_LIVEMODE', 'false'));
  return {
    livemode,
    clientId: requiredEnv('PAYPAL_CLIENT_ID'),
    clientSecret: requiredEnv('PAYPAL_CLIENT_SECRET'),
    apiBase: payPalApiBase(livemode, optionalEnv('PAYPAL_API_BASE')),
  };
}

export class PayPalIntegrationError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = 'paypal_integration_error',
  ) {
    super(message);
    this.name = 'PayPalIntegrationError';
  }
}

export type PayPalFetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface PayPalClientConfig {
  clientId: string;
  clientSecret: string;
  apiBase: string;
  fetcher?: PayPalFetcher;
  timeoutMs?: number;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();
const encoder = new TextEncoder();

export function resetPayPalTokenCacheForTest(): void {
  tokenCache.clear();
}

export function requirePayPalCardsEnabled(): void {
  const enabled = optionalEnv('PAYPAL_CARDS_ENABLED', 'false');
  if (enabled !== 'true' && enabled !== 'false') {
    throw new PayPalIntegrationError('Invalid card configuration', 500, 'paypal_config_invalid');
  }
  if (enabled !== 'true') {
    throw new PayPalIntegrationError('Card payments are not enabled', 409, 'paypal_cards_disabled');
  }
}

// SDK v6 tokens are deliberately separate from the server OAuth token cache.
// The domain comes from deployment configuration, never from request input.
export async function payPalBrowserToken(config: PayPalClientConfig) {
  const domain = requiredEnv('PAYPAL_STOREFRONT_DOMAIN');
  if (!/^(?=.{1,253}$)[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(domain)) {
    throw new PayPalIntegrationError('Invalid storefront domain', 500, 'paypal_config_invalid');
  }
  const response = await fetchPayPal(`${normalizedApiBase(config.apiBase)}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${base64Utf8(`${config.clientId}:${config.clientSecret}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials', response_type: 'client_token',
      intent: 'sdk_init', 'domains[]': domain,
    }),
  }, config);
  const parsed = await responseJson(response);
  if (!response.ok || typeof parsed.access_token !== 'string'
      || !/^\S{1,8192}$/.test(parsed.access_token)
      || typeof parsed.expires_in !== 'number'
      || !Number.isFinite(parsed.expires_in) || parsed.expires_in <= 0) {
    throw new PayPalIntegrationError('SDK token request failed', 502, 'paypal_auth_failed');
  }
  return { client_token: parsed.access_token, expires_in: parsed.expires_in };
}

function base64Utf8(value: string): string {
  const bytes = encoder.encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function normalizedApiBase(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PayPalIntegrationError('PayPal API base URL is invalid', 500, 'paypal_config_invalid');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
    || url.hostname === 'host.docker.internal';
  const official = new Set([
    'api.paypal.com', 'api-m.paypal.com',
    'api.sandbox.paypal.com', 'api-m.sandbox.paypal.com',
  ]).has(url.hostname);
  if ((!official && !local)
      || (official && (url.protocol !== 'https:' || (url.port && url.port !== '443')))
      || (local && !['http:', 'https:'].includes(url.protocol))
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new PayPalIntegrationError('PayPal API base URL is untrusted', 500, 'paypal_config_invalid');
  }
  return url.origin;
}

export function parsePayPalLivemode(value: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new PayPalIntegrationError(
    'PAYPAL_LIVEMODE must be true or false', 500, 'paypal_config_invalid',
  );
}

export function payPalApiBase(livemode: boolean, override = ''): string {
  const base = normalizedApiBase(
    override || (livemode ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com'),
  );
  const host = new URL(base).hostname;
  const expected = livemode
    ? new Set(['api.paypal.com', 'api-m.paypal.com'])
    : new Set(['api.sandbox.paypal.com', 'api-m.sandbox.paypal.com']);
  const local = host === 'localhost' || host === '127.0.0.1' || host === 'host.docker.internal';
  if (!expected.has(host) && !(local && !livemode)) {
    throw new PayPalIntegrationError(
      'PayPal API base does not match PAYPAL_LIVEMODE', 500, 'paypal_config_invalid',
    );
  }
  return base;
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const declared = Number(response.headers.get('Content-Length') ?? 0);
  if (Number.isFinite(declared) && declared > 1_048_576) {
    throw new PayPalIntegrationError('PayPal response is too large', 502, 'paypal_bad_response');
  }
  let text = '';
  const reader = response.body?.getReader();
  if (reader) {
    const decoder = new TextDecoder();
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1_048_576) {
          throw new PayPalIntegrationError('PayPal response is too large', 502, 'paypal_bad_response');
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } catch (error) {
      await reader.cancel().catch(() => {});
      if (error instanceof PayPalIntegrationError) throw error;
      throw new PayPalIntegrationError('PayPal response interrupted', 502, 'paypal_unavailable');
    } finally {
      reader.releaseLock();
    }
  }
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new PayPalIntegrationError('PayPal returned a non-JSON response', 502, 'paypal_bad_response');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PayPalIntegrationError('PayPal response object is invalid', 502, 'paypal_bad_response');
  }
  return parsed as Record<string, unknown>;
}

function safeProviderCode(value: unknown): string {
  const text = typeof value === 'string' ? value : '';
  return /^[A-Z0-9_]{1,100}$/.test(text) ? text.toLowerCase() : 'paypal_request_failed';
}

async function fetchPayPal(
  url: string,
  init: RequestInit,
  config: PayPalClientConfig,
): Promise<Response> {
  try {
    return await (config.fetcher ?? fetch)(url, {
      ...init,
      redirect: 'error',
      signal: init.signal ?? AbortSignal.timeout(config.timeoutMs ?? 10_000),
    });
  } catch (error) {
    if (error instanceof PayPalIntegrationError) throw error;
    throw new PayPalIntegrationError('PayPal request failed', 502, 'paypal_unavailable');
  }
}

async function accessToken(config: PayPalClientConfig, forceRefresh = false): Promise<string> {
  if (!config.clientId || !config.clientSecret) {
    throw new PayPalIntegrationError('PayPal credentials are not configured', 500, 'paypal_config_invalid');
  }
  const apiBase = normalizedApiBase(config.apiBase);
  const cacheKey = `${apiBase}\u0000${config.clientId}\u0000${config.clientSecret}`;
  const cached = tokenCache.get(cacheKey);
  if (!forceRefresh && cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const response = await fetchPayPal(`${apiBase}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${base64Utf8(`${config.clientId}:${config.clientSecret}`)}`,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  }, config);
  const parsed = await responseJson(response);
  if (!response.ok || typeof parsed.access_token !== 'string'
      || !/^\S{1,8192}$/.test(parsed.access_token)
      || typeof parsed.expires_in !== 'number'
      || !Number.isFinite(parsed.expires_in) || parsed.expires_in <= 0) {
    throw new PayPalIntegrationError('PayPal authentication failed', 502, 'paypal_auth_failed');
  }
  const expiresIn = Math.min(parsed.expires_in, 43_200);
  tokenCache.set(cacheKey, {
    token: parsed.access_token,
    expiresAt: Date.now() + expiresIn * 1000,
  });
  return parsed.access_token;
}

interface PayPalRequestOptions extends PayPalClientConfig {
  method?: 'GET' | 'POST';
  body?: Record<string, unknown> | string;
  idempotencyKey?: string;
  preferRepresentation?: boolean;
}

export async function payPalRequest<T extends Record<string, unknown>>(
  path: string,
  options: PayPalRequestOptions,
): Promise<T> {
  if (!/^\/[A-Za-z0-9_./?=&%-]+$/.test(path) || path.includes('..')) {
    throw new PayPalIntegrationError('PayPal API path is invalid', 500, 'paypal_config_invalid');
  }
  if (options.idempotencyKey
      && (options.idempotencyKey.length > 38 || !/^[A-Za-z0-9_-]+$/.test(options.idempotencyKey))) {
    throw new PayPalIntegrationError('PayPal-Request-Id must be at most 38 safe characters', 500, 'paypal_config_invalid');
  }
  const apiBase = normalizedApiBase(options.apiBase);
  const method = options.method ?? 'POST';
  let forceRefresh = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = await accessToken(options, forceRefresh);
    const headers = new Headers({
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    });
    if (options.idempotencyKey) headers.set('PayPal-Request-Id', options.idempotencyKey);
    if (options.preferRepresentation) headers.set('Prefer', 'return=representation');
    const response = await fetchPayPal(`${apiBase}${path}`, {
      method,
      headers,
      body: method === 'POST'
        ? typeof options.body === 'string' ? options.body : JSON.stringify(options.body ?? {})
        : undefined,
    }, options);
    const parsed = await responseJson(response);
    if (response.status === 401 && attempt === 0) {
      forceRefresh = true;
      continue;
    }
    if (!response.ok) {
      const details = Array.isArray(parsed.details) ? parsed.details[0] : null;
      const issue = details && typeof details === 'object' && !Array.isArray(details)
        ? (details as Record<string, unknown>).issue
        : null;
      throw new PayPalIntegrationError(
        'PayPal rejected the request',
        response.status >= 500 || response.status === 401 ? 502 : response.status,
        safeProviderCode(issue ?? parsed.name),
      );
    }
    return parsed as T;
  }
  throw new PayPalIntegrationError('PayPal authentication failed', 502, 'paypal_auth_failed');
}

function boundedHeader(headers: Headers, name: string, maxLength: number): string {
  const value = headers.get(name)?.trim() ?? '';
  if (!value || value.length > maxLength || /[\r\n]/.test(value)) {
    throw new PayPalIntegrationError(`Missing or invalid ${name} header`, 400, 'invalid_signature_headers');
  }
  return value;
}

function assertPayPalCertUrl(value: string, livemode: boolean): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PayPalIntegrationError('Invalid PayPal certificate URL', 400, 'invalid_signature_headers');
  }
  const hosts = livemode
    ? new Set(['api.paypal.com', 'api-m.paypal.com'])
    : new Set(['api.sandbox.paypal.com', 'api-m.sandbox.paypal.com']);
  if (url.protocol !== 'https:' || !hosts.has(url.hostname)
      || (url.port && url.port !== '443') || url.username || url.password
      || url.search || url.hash
      || !url.pathname.startsWith('/v1/notifications/certs/')) {
    throw new PayPalIntegrationError('Untrusted PayPal certificate URL', 400, 'invalid_signature_headers');
  }
}

export interface PayPalWebhookHeaders {
  authAlgo: string;
  certUrl: string;
  transmissionId: string;
  transmissionSig: string;
  transmissionTime: string;
}

export function parsePayPalWebhookHeaders(
  headers: Headers,
  livemode: boolean,
): PayPalWebhookHeaders {
  const authAlgo = boundedHeader(headers, 'PayPal-Auth-Algo', 100);
  const certUrl = boundedHeader(headers, 'PayPal-Cert-Url', 2048);
  const transmissionId = boundedHeader(headers, 'PayPal-Transmission-Id', 255);
  const transmissionSig = boundedHeader(headers, 'PayPal-Transmission-Sig', 4096);
  const transmissionTime = boundedHeader(headers, 'PayPal-Transmission-Time', 100);
  if (authAlgo !== 'SHA256withRSA' || !Number.isFinite(Date.parse(transmissionTime))) {
    throw new PayPalIntegrationError('Invalid PayPal signature headers', 400, 'invalid_signature_headers');
  }
  assertPayPalCertUrl(certUrl, livemode);
  return { authAlgo, certUrl, transmissionId, transmissionSig, transmissionTime };
}

export async function verifyPayPalWebhook(
  rawEvent: string,
  headers: PayPalWebhookHeaders,
  webhookId: string,
  config: PayPalClientConfig,
): Promise<void> {
  if (!/^[A-Za-z0-9_-]{1,255}$/.test(webhookId)) {
    throw new PayPalIntegrationError('PayPal webhook ID is invalid', 500, 'paypal_config_invalid');
  }
  const result = await payPalRequest<Record<string, unknown>>(
    '/v1/notifications/verify-webhook-signature',
    {
      ...config,
      // The handler validates the JSON object, but verification must preserve
      // its original representation, including whitespace and numeric lexemes.
      body: JSON.stringify({
        auth_algo: headers.authAlgo,
        cert_url: headers.certUrl,
        transmission_id: headers.transmissionId,
        transmission_sig: headers.transmissionSig,
        transmission_time: headers.transmissionTime,
        webhook_id: webhookId,
      }).slice(0, -1) + ',"webhook_event":' + rawEvent + '}',
    },
  );
  if (result.verification_status !== 'SUCCESS') {
    throw new PayPalIntegrationError('Invalid PayPal webhook signature', 400, 'invalid_signature');
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredText(value: unknown, field: string, maxLength = 255): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new PayPalIntegrationError(`PayPal ${field} is invalid`, 400, 'invalid_provider_payload');
  }
  return value.trim();
}

export function normalizeProviderAmount(value: unknown, currency: unknown): string {
  const code = requiredText(currency, 'currency', 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new PayPalIntegrationError('Provider currency code is invalid');
  }
  const text = typeof value === 'number' ? value.toString() : String(value ?? '').trim();
  const match = /^(0|[1-9]\d{0,9})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) {
    throw new PayPalIntegrationError('Amount must be a positive decimal with at most two places');
  }
  const normalized = `${match[1]}.${(match[2] ?? '').padEnd(2, '0')}`;
  if (normalized === '0.00') throw new PayPalIntegrationError('Amount must be positive');
  return normalized;
}

export function normalizeCheckoutAmount(value: unknown, currency: unknown): string {
  const code = requiredText(currency, 'currency', 3).toUpperCase();
  if (code !== 'USD') {
    throw new PayPalIntegrationError(`Currency ${code} is outside the current USD capability`);
  }
  return normalizeProviderAmount(value, code);
}

export function requirePayPalId(value: unknown, field: string): string {
  const id = requiredText(value, field, 127);
  if (!/^[A-Za-z0-9_-]{5,127}$/.test(id)) {
    throw new PayPalIntegrationError(`PayPal ${field} is invalid`, 400, 'invalid_provider_payload');
  }
  return id;
}

function relatedOrderId(resource: Record<string, unknown>): string | null {
  const supplementary = record(resource.supplementary_data);
  const related = record(supplementary?.related_ids);
  return typeof related?.order_id === 'string' ? related.order_id : null;
}

function upReference(links: unknown, resourceName: 'captures' | 'refunds'): string | null {
  if (!Array.isArray(links)) return null;
  for (const link of links) {
    const row = record(link);
    if (row?.rel !== 'up' || typeof row.href !== 'string') continue;
    try {
      const url = new URL(row.href);
      const match = new RegExp(`/v2/payments/${resourceName}/([A-Za-z0-9_-]+)$`).exec(url.pathname);
      if (match) return match[1];
    } catch {
      // Ignore malformed provider links; the reference remains unavailable.
    }
  }
  return null;
}

function localUuid(value: unknown): string | null {
  return typeof value === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

function eventStatus(eventType: string, resource: Record<string, unknown>): string {
  if (typeof resource.status === 'string' && resource.status) return resource.status.toLowerCase();
  const suffix = eventType.split('.').at(-1)?.toLowerCase();
  return suffix ?? 'unknown';
}

export interface NormalizedPayPalEvent {
  providerEventId: string;
  eventType: string;
  objectReference: string | null;
  occurredAt: string;
  data: Record<string, unknown>;
}

export function normalizePayPalEvent(input: unknown): NormalizedPayPalEvent {
  const event = record(input);
  if (!event) throw new PayPalIntegrationError('PayPal event must be an object', 400, 'invalid_event');
  const providerEventId = requiredText(event.id, 'event id');
  const eventType = requiredText(event.event_type, 'event type', 200);
  const timestamp = Date.parse(requiredText(event.create_time, 'event create_time', 100));
  if (!Number.isFinite(timestamp)) {
    throw new PayPalIntegrationError('PayPal event timestamp is invalid', 400, 'invalid_event');
  }
  const resource = record(event.resource);
  if (!resource) throw new PayPalIntegrationError('PayPal event resource is invalid', 400, 'invalid_event');
  const reference = typeof resource.id === 'string' ? resource.id : null;

  if (eventType.startsWith('PAYMENT.CAPTURE.') && eventType !== 'PAYMENT.CAPTURE.REFUNDED') {
    const amount = record(resource.amount);
    if (!reference || !amount) {
      throw new PayPalIntegrationError('PayPal capture event is invalid', 400, 'invalid_event');
    }
    return {
      providerEventId,
      eventType,
      objectReference: requirePayPalId(reference, 'capture id'),
      occurredAt: new Date(timestamp).toISOString(),
      data: {
        object_type: 'capture',
        status: eventStatus(eventType, resource),
        amount: normalizeProviderAmount(amount.value, amount.currency_code),
        currency: requiredText(amount.currency_code, 'currency', 3).toUpperCase(),
        order_reference: relatedOrderId(resource),
        failure_code: typeof record(resource.status_details)?.reason === 'string'
          ? record(resource.status_details)?.reason
          : null,
        failure_message: null,
        metadata: {
          tera_payment_intent_id: localUuid(resource.custom_id),
        },
      },
    };
  }

  if (eventType === 'PAYMENT.CAPTURE.REFUNDED' || eventType.startsWith('PAYMENT.REFUND.')) {
    const amount = record(resource.amount);
    if (!reference || !amount) {
      throw new PayPalIntegrationError('PayPal refund event is invalid', 400, 'invalid_event');
    }
    return {
      providerEventId,
      eventType,
      objectReference: requirePayPalId(reference, 'refund id'),
      occurredAt: new Date(timestamp).toISOString(),
      data: {
        object_type: 'refund',
        status: eventStatus(eventType, resource),
        amount: normalizeProviderAmount(amount.value, amount.currency_code),
        currency: requiredText(amount.currency_code, 'currency', 3).toUpperCase(),
        capture_reference: upReference(resource.links, 'captures'),
        failure_code: typeof record(resource.status_details)?.reason === 'string'
          ? record(resource.status_details)?.reason
          : null,
        failure_message: null,
        metadata: {
          tera_refund_request_id: localUuid(resource.custom_id),
        },
      },
    };
  }

  return {
    providerEventId,
    eventType,
    objectReference: reference,
    occurredAt: new Date(timestamp).toISOString(),
    data: {
      object_type: typeof event.resource_type === 'string' ? event.resource_type : null,
      status: typeof resource.status === 'string' ? resource.status.toLowerCase() : null,
    },
  };
}

export interface LocalPayPalIntent {
  id: string;
  order_id: string;
  order_number: number | string;
  provider: string;
  payment_method?: 'paypal' | 'card';
  status: string;
  amount: number | string;
  currency: string;
  provider_reference: string | null;
  expires_at: string | null;
  shipping_address: Record<string, unknown>;
}

export interface PayPalCapture extends Record<string, unknown> {
  id: string;
  status: string;
  amount: { value: string; currency_code: string };
  custom_id?: string;
  create_time?: string;
  update_time?: string;
  final_capture?: boolean;
}

export interface PayPalOrder extends Record<string, unknown> {
  id: string;
  intent: string;
  status: string;
  purchase_units: Array<Record<string, unknown>>;
  links?: Array<Record<string, unknown>>;
}

export function validatePayPalOrder(
  order: PayPalOrder,
  local: LocalPayPalIntent,
  enforceExpectedMoney = true,
): Record<string, unknown> {
  const id = requirePayPalId(order.id, 'order id');
  if (order.intent !== 'CAPTURE' || typeof order.status !== 'string'
      || !Array.isArray(order.purchase_units) || order.purchase_units.length !== 1) {
    throw new PayPalIntegrationError('PayPal Order shape is invalid', 502, 'paypal_bad_response');
  }
  const unit = record(order.purchase_units[0]);
  const amount = record(unit?.amount);
  if (!unit || !amount
      || unit.reference_id !== local.order_id
      || unit.custom_id !== local.id
      || (enforceExpectedMoney
          && normalizeCheckoutAmount(amount.value, amount.currency_code)
             !== normalizeCheckoutAmount(local.amount, local.currency))) {
    throw new PayPalIntegrationError('PayPal Order does not match local payment intent', 409, 'provider_mismatch');
  }
  if (local.provider_reference && local.provider_reference !== id) {
    throw new PayPalIntegrationError('PayPal Order reference changed', 409, 'provider_mismatch');
  }
  return unit;
}

// Only call before a new capture command. Existing money facts must always be
// ingested, even if the source or authentication would now fail this policy.
export function validatePayPalCardForCapture(order: PayPalOrder): void {
  const source = record(order.payment_source);
  const card = record(source?.card);
  if (!card || Object.keys(source!).some(key => key !== 'card')) {
    throw new PayPalIntegrationError('Expected a card payment source', 409, 'provider_mismatch');
  }
  if (order.status !== 'APPROVED') {
    throw new PayPalIntegrationError('Card order is not approved', 409, 'paypal_order_not_approved');
  }
  // Under SCA_WHEN_REQUIRED an approved order can legitimately have no 3DS
  // result. If PayPal supplies one, never discard an explicit failure/unknown.
  if (card.authentication_result === undefined) return;
  const authentication = record(card.authentication_result);
  const threeDS = record(authentication?.three_d_secure);
  if (!authentication || !['YES', 'POSSIBLE'].includes(String(authentication.liability_shift))
      || (authentication.three_d_secure !== undefined && !threeDS)
      || (threeDS?.authentication_status !== undefined
          && !['Y', 'A'].includes(String(threeDS.authentication_status)))) {
    throw new PayPalIntegrationError('Card authentication was not accepted', 409, 'paypal_card_authentication_required');
  }
}

export function extractPayPalCapture(
  order: PayPalOrder,
  local: LocalPayPalIntent,
  enforceExpectedMoney = true,
): PayPalCapture | null {
  const unit = validatePayPalOrder(order, local, enforceExpectedMoney);
  const payments = record(unit.payments);
  const captures = payments?.captures;
  if (captures === undefined) return null;
  if (!Array.isArray(captures) || captures.length === 0) return null;
  if (captures.length !== 1) {
    throw new PayPalIntegrationError('PayPal returned multiple captures', 409, 'provider_mismatch');
  }
  const capture = record(captures[0]) as PayPalCapture | null;
  if (!capture || typeof capture.status !== 'string' || !record(capture.amount)
      || typeof capture.create_time !== 'string'
      || !Number.isFinite(Date.parse(capture.create_time))
      || (capture.update_time !== undefined
          && (typeof capture.update_time !== 'string'
              || !Number.isFinite(Date.parse(capture.update_time))))) {
    throw new PayPalIntegrationError('PayPal Capture is invalid', 502, 'paypal_bad_response');
  }
  requirePayPalId(capture.id, 'capture id');
  if (capture.final_capture === false
      || (capture.custom_id !== undefined && capture.custom_id !== local.id)
      || (enforceExpectedMoney
          && normalizeCheckoutAmount(capture.amount.value, capture.amount.currency_code)
             !== normalizeCheckoutAmount(local.amount, local.currency))) {
    throw new PayPalIntegrationError('PayPal Capture does not match local payment intent', 409, 'provider_mismatch');
  }
  return capture;
}

export function normalizedPayPalCaptureData(
  capture: PayPalCapture,
  local: LocalPayPalIntent,
  orderReference: string,
): Record<string, unknown> {
  return {
    object_type: 'capture',
    status: capture.status.toLowerCase(),
    amount: normalizeProviderAmount(capture.amount.value, capture.amount.currency_code),
    currency: capture.amount.currency_code.toUpperCase(),
    order_reference: orderReference,
    failure_code: typeof record(capture.status_details)?.reason === 'string'
      ? record(capture.status_details)?.reason
      : null,
    failure_message: null,
    metadata: { tera_payment_intent_id: local.id, tera_order_id: local.order_id },
  };
}

export interface PayPalRefund extends Record<string, unknown> {
  id: string;
  status: string;
  amount: { value: string; currency_code: string };
  custom_id?: string;
  create_time?: string;
  update_time?: string;
  links?: Array<Record<string, unknown>>;
}

// Payments v2 custom_id is optional. POST provenance is the capture endpoint +
// durable PayPal-Request-Id; subsequent GETs must match the already bound Refund ID.
export function validatePayPalRefund(
  refund: PayPalRefund,
  local: {
    id: string; amount: number | string; currency: string;
    provider_reference: string | null; parent_provider_reference: string;
  },
  enforceExpectedMoney = true,
): void {
  requirePayPalId(refund.id, 'refund id');
  if (typeof refund.status !== 'string' || !record(refund.amount)
      || typeof refund.create_time !== 'string'
      || !Number.isFinite(Date.parse(refund.create_time))
      || (refund.update_time !== undefined
          && (typeof refund.update_time !== 'string'
              || !Number.isFinite(Date.parse(refund.update_time))))
      || (local.provider_reference !== null && refund.id !== local.provider_reference)
      || (refund.custom_id !== undefined && refund.custom_id !== local.id)
      || (enforceExpectedMoney
          && normalizeCheckoutAmount(refund.amount.value, refund.amount.currency_code)
             !== normalizeCheckoutAmount(local.amount, local.currency))) {
    throw new PayPalIntegrationError('PayPal Refund does not match local request', 409, 'provider_mismatch');
  }
  const captureReference = upReference(refund.links, 'captures');
  if (captureReference && captureReference !== local.parent_provider_reference) {
    throw new PayPalIntegrationError('PayPal Refund capture reference changed', 409, 'provider_mismatch');
  }
}

export function normalizedPayPalRefundData(
  refund: PayPalRefund,
  local: { id: string; order_id: string; parent_provider_reference: string },
): Record<string, unknown> {
  return {
    object_type: 'refund',
    status: refund.status.toLowerCase(),
    amount: normalizeProviderAmount(refund.amount.value, refund.amount.currency_code),
    currency: refund.amount.currency_code.toUpperCase(),
    capture_reference: local.parent_provider_reference,
    failure_code: typeof record(refund.status_details)?.reason === 'string'
      ? record(refund.status_details)?.reason
      : null,
    failure_message: null,
    metadata: { tera_refund_request_id: local.id, tera_order_id: local.order_id },
  };
}

function addressText(
  address: Record<string, unknown>,
  key: string,
  maxLength: number,
  required: boolean,
): string | undefined {
  const value = address[key];
  if (value === undefined || value === null || value === '') {
    if (required) throw new PayPalIntegrationError(`Shipping address ${key} is required`);
    return undefined;
  }
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    throw new PayPalIntegrationError(`Shipping address ${key} is invalid`);
  }
  return value.trim();
}

export function payPalShippingUnit(address: Record<string, unknown>): Record<string, unknown> {
  const country = addressText(address, 'country', 2, true)!.toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) throw new PayPalIntegrationError('Shipping country is invalid');
  const mapped: Record<string, unknown> = {
    name: { full_name: addressText(address, 'recipient_name', 300, true) },
    address: {
      address_line_1: addressText(address, 'line1', 300, true),
      address_line_2: addressText(address, 'line2', 300, false),
      admin_area_2: addressText(address, 'city', 120, false),
      admin_area_1: addressText(address, 'region', 300, false),
      postal_code: addressText(address, 'postal_code', 60, false),
      country_code: country,
    },
  };
  mapped.address = Object.fromEntries(
    Object.entries(mapped.address as Record<string, unknown>)
      .filter(([, value]) => value !== undefined),
  );
  return mapped;
}

export function configuredRedirectUrl(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PayPalIntegrationError(`${name} is invalid`, 500, 'paypal_config_invalid');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new PayPalIntegrationError(`${name} must use HTTPS`, 500, 'paypal_config_invalid');
  }
  if (url.username || url.password || url.hash || value.length > 2048) {
    throw new PayPalIntegrationError(`${name} is invalid`, 500, 'paypal_config_invalid');
  }
  return url.toString();
}

export function payPalApprovalUrl(order: PayPalOrder, livemode: boolean): string | null {
  if (!Array.isArray(order.links)) return null;
  const link = order.links.find((row) => row.rel === 'payer-action' || row.rel === 'approve');
  if (!link || typeof link.href !== 'string') return null;
  let url: URL;
  try {
    url = new URL(link.href);
  } catch {
    throw new PayPalIntegrationError('PayPal approval URL is invalid', 502, 'paypal_bad_response');
  }
  const hosts = livemode
    ? new Set(['paypal.com', 'www.paypal.com'])
    : new Set(['sandbox.paypal.com', 'www.sandbox.paypal.com']);
  if (url.protocol !== 'https:' || !hosts.has(url.hostname)
      || url.username || url.password || (url.port && url.port !== '443')) {
    throw new PayPalIntegrationError('PayPal approval URL is untrusted', 502, 'paypal_bad_response');
  }
  return url.toString();
}

export function ingestPayPalCapture(
  capture: PayPalCapture, local: LocalPayPalIntent, orderReference: string, livemode: boolean,
): Promise<ProviderEventResult> {
  return ingestApiPaymentEvent({
    provider: 'paypal', resource: 'capture', reference: capture.id, status: capture.status,
    eventType: 'paypal.capture.api_result', livemode,
    occurredAt: paypalOccurredAt(capture.update_time ?? capture.create_time),
    data: normalizedPayPalCaptureData(capture, local, orderReference),
  });
}

export function ingestPayPalRefund(
  refund: PayPalRefund,
  local: { id: string; order_id: string; parent_provider_reference: string },
  livemode: boolean,
): Promise<ProviderEventResult> {
  return ingestApiPaymentEvent({
    provider: 'paypal', resource: 'refund', reference: refund.id, status: refund.status,
    eventType: 'paypal.refund.api_result', livemode,
    occurredAt: paypalOccurredAt(refund.update_time ?? refund.create_time),
    data: normalizedPayPalRefundData(refund, local),
  });
}

export function paypalOccurredAt(value: unknown): string {
  const timestamp = typeof value === 'string' ? Date.parse(value) : NaN;
  return new Date(Number.isFinite(timestamp) ? timestamp : Date.now()).toISOString();
}
