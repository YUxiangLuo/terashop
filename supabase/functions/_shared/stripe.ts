export const DEFAULT_STRIPE_API_VERSION = '2026-02-25.clover';

export class StripeIntegrationError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = 'stripe_integration_error',
  ) {
    super(message);
    this.name = 'StripeIntegrationError';
  }
}

const encoder = new TextEncoder();
const MAX_PROVIDER_BODY_BYTES = 1_048_576;
const STRIPE_ID = /^[A-Za-z0-9_]{3,255}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function hex(bytes: ArrayBuffer | Uint8Array): string {
  const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function decodeHex(value: string): Uint8Array | null {
  if (!/^[0-9a-f]+$/i.test(value) || value.length !== 64) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

export async function sha256Hex(value: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

export async function stripeSignatureForTest(
  payload: string,
  secret: string,
  timestamp: number,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${payload}`)));
}

function normalizedWebhookSecrets(secrets: readonly string[]): string[] {
  const values = [...new Set(secrets.map((secret) => secret.trim()).filter(Boolean))];
  if (values.length === 0) {
    throw new StripeIntegrationError(
      'Stripe webhook secret is not configured', 500, 'missing_webhook_secret',
    );
  }
  if (values.length > 4 || values.some(
    (secret) => secret.length > 255 || !/^whsec_[A-Za-z0-9_-]+$/.test(secret),
  )) {
    throw new StripeIntegrationError(
      'Stripe webhook secret configuration is invalid', 500, 'webhook_secret_invalid',
    );
  }
  return values;
}

export function parseStripeWebhookSecrets(primary: string, rotating = ''): string[] {
  return normalizedWebhookSecrets([primary, ...rotating.split(',')]);
}

export async function verifyStripeSignature(
  payload: string,
  signatureHeader: string | null,
  secrets: readonly string[],
  options: { nowSeconds?: number; toleranceSeconds?: number } = {},
): Promise<{ timestamp: number }> {
  if (!signatureHeader) {
    throw new StripeIntegrationError('Missing Stripe-Signature header', 400, 'missing_signature');
  }
  if (signatureHeader.length > 8192) {
    throw new StripeIntegrationError('Malformed Stripe-Signature header', 400, 'malformed_signature');
  }
  const timestampValues: string[] = [];
  const signatures: string[] = [];
  const parts = signatureHeader.split(',');
  if (parts.length > 32) {
    throw new StripeIntegrationError('Malformed Stripe-Signature header', 400, 'malformed_signature');
  }
  for (const part of parts) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === 't') timestampValues.push(value);
    if (key === 'v1') signatures.push(value);
  }
  if (timestampValues.length !== 1 || signatures.length === 0 || signatures.length > 8
      || !/^\d{1,12}$/.test(timestampValues[0])) {
    throw new StripeIntegrationError('Malformed Stripe-Signature header', 400, 'malformed_signature');
  }
  const timestamp = Number(timestampValues[0]);
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = options.toleranceSeconds ?? 300;
  if (!Number.isSafeInteger(tolerance) || tolerance < 1 || tolerance > 900) {
    throw new StripeIntegrationError('Stripe signature tolerance is invalid', 500, 'stripe_config_invalid');
  }
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > tolerance) {
    throw new StripeIntegrationError(
      'Stripe signature timestamp is outside tolerance', 400, 'stale_signature',
    );
  }
  const configuredSecrets = normalizedWebhookSecrets(secrets);
  const supplied = signatures.map(decodeHex).filter((value): value is Uint8Array => value !== null);
  if (supplied.length === 0) {
    throw new StripeIntegrationError('Malformed Stripe-Signature header', 400, 'malformed_signature');
  }
  for (const secret of configuredSecrets) {
    const expected = decodeHex(await stripeSignatureForTest(payload, secret, timestamp));
    if (expected && supplied.some((candidate) => constantTimeEqual(expected, candidate))) {
      return { timestamp };
    }
  }
  throw new StripeIntegrationError('Invalid Stripe webhook signature', 400, 'invalid_signature');
}

function decimalParts(value: string | number): { whole: string; fraction: string } {
  const text = typeof value === 'number' ? value.toString() : value.trim();
  const match = /^(0|[1-9]\d{0,9})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) {
    throw new StripeIntegrationError('Amount must be a positive CNY decimal with at most two places');
  }
  return { whole: match[1], fraction: match[2] ?? '' };
}

export function decimalToMinorUnits(value: string | number, currency: string): string {
  if (currency.toUpperCase() !== 'CNY') {
    throw new StripeIntegrationError(`Currency ${currency} is outside the current CNY capability`);
  }
  const { whole, fraction } = decimalParts(value);
  const minor = `${whole}${fraction.padEnd(2, '0')}`.replace(/^0+(?=\d)/, '');
  if (minor === '0') throw new StripeIntegrationError('Amount must be positive');
  return minor;
}

export function minorUnitsToDecimal(value: string | number, currency: string): string {
  if (currency.toUpperCase() !== 'CNY') {
    throw new StripeIntegrationError(`Currency ${currency} is outside the current CNY capability`);
  }
  const text = String(value);
  if (!/^[1-9]\d{0,11}$/.test(text)) {
    throw new StripeIntegrationError('Stripe amount must be a positive integer');
  }
  const padded = text.padStart(3, '0');
  return `${padded.slice(0, -2)}.${padded.slice(-2)}`;
}

function localUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value) ? value : null;
}

function safeMetadata(input: unknown, keys: readonly string[]): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const source = input as Record<string, unknown>;
  return Object.fromEntries(keys.flatMap((key) => {
    const value = localUuid(source[key]);
    return value ? [[key, value]] : [];
  }));
}

function safeProviderCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9_]{1,100}$/.test(normalized) ? normalized : null;
}

function integerString(value: unknown, field: string): string {
  if ((typeof value !== 'number' && typeof value !== 'string')
      || !/^[1-9]\d{0,11}$/.test(String(value))) {
    throw new StripeIntegrationError(`Stripe ${field} must be a positive integer`, 400, 'invalid_event');
  }
  return String(value);
}

function requiredStripeId(value: unknown, prefix: 'evt_' | 'pi_' | 're_', field: string): string {
  if (typeof value !== 'string' || !value.startsWith(prefix)
      || value.length < prefix.length + 3 || !STRIPE_ID.test(value)) {
    throw new StripeIntegrationError(`Stripe ${field} is invalid`, 400, 'invalid_event');
  }
  return value;
}

function optionalStripeId(value: unknown, prefix: string): string | null {
  return typeof value === 'string' && value.startsWith(prefix)
      && value.length >= prefix.length + 3 && STRIPE_ID.test(value)
    ? value
    : null;
}

interface StripeObject {
  id?: unknown;
  object?: unknown;
  status?: unknown;
  amount?: unknown;
  amount_received?: unknown;
  currency?: unknown;
  livemode?: unknown;
  metadata?: unknown;
  last_payment_error?: unknown;
  failure_reason?: unknown;
  pending_reason?: unknown;
  payment_intent?: unknown;
  charge?: unknown;
  latest_charge?: unknown;
}

function normalizedCurrency(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z]{3}$/.test(value)) {
    throw new StripeIntegrationError('Stripe currency is invalid', 400, 'invalid_event');
  }
  return value.toLowerCase();
}

export function normalizedStripePaymentIntentData(
  object: StripeObject,
  eventType = `payment_intent.${String(object.status ?? 'unknown')}`,
): Record<string, unknown> {
  const status = typeof object.status === 'string' && object.status.length <= 64
    ? object.status
    : null;
  const error = object.last_payment_error && typeof object.last_payment_error === 'object'
      && !Array.isArray(object.last_payment_error)
    ? object.last_payment_error as Record<string, unknown>
    : {};
  const amount = eventType === 'payment_intent.succeeded'
      && /^\d+$/.test(String(object.amount_received ?? ''))
      && BigInt(String(object.amount_received)) > 0n
    ? object.amount_received
    : object.amount;
  return {
    object_type: 'payment_intent',
    status,
    amount_minor: integerString(amount, 'PaymentIntent amount'),
    currency: normalizedCurrency(object.currency),
    latest_charge: optionalStripeId(object.latest_charge, 'ch_'),
    failure_code: safeProviderCode(error.code),
    failure_message: null,
    metadata: safeMetadata(object.metadata, ['tera_payment_intent_id', 'tera_order_id']),
  };
}

export function normalizedStripeRefundData(object: StripeObject): Record<string, unknown> {
  const status = typeof object.status === 'string' ? object.status.toLowerCase() : '';
  if (!['pending', 'requires_action', 'succeeded', 'failed', 'canceled'].includes(status)) {
    throw new StripeIntegrationError('Stripe Refund status is invalid', 400, 'invalid_event');
  }
  return {
    object_type: 'refund',
    status,
    amount_minor: integerString(object.amount, 'Refund amount'),
    currency: normalizedCurrency(object.currency),
    payment_intent_reference: optionalStripeId(object.payment_intent, 'pi_'),
    charge_reference: optionalStripeId(object.charge, 'ch_'),
    failure_code: safeProviderCode(object.failure_reason),
    failure_message: null,
    pending_reason: safeProviderCode(object.pending_reason),
    metadata: safeMetadata(object.metadata, ['tera_refund_request_id', 'tera_order_id']),
  };
}

export interface NormalizedProviderEvent {
  providerEventId: string;
  eventType: string;
  objectReference: string | null;
  livemode: boolean;
  occurredAt: string;
  data: Record<string, unknown>;
}

const PAYMENT_INTENT_EVENTS = new Set([
  'payment_intent.processing',
  'payment_intent.requires_action',
  'payment_intent.payment_failed',
  'payment_intent.succeeded',
  'payment_intent.canceled',
]);
const REFUND_EVENTS = new Set(['refund.created', 'refund.updated', 'refund.failed']);

export function normalizeStripeEvent(input: unknown): NormalizedProviderEvent {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new StripeIntegrationError('Stripe event must be an object', 400, 'invalid_event');
  }
  const event = input as Record<string, unknown>;
  const providerEventId = requiredStripeId(event.id, 'evt_', 'event id');
  if (event.object !== 'event'
      || typeof event.type !== 'string' || !/^[a-z0-9_.]{1,200}$/.test(event.type)
      || typeof event.created !== 'number' || !Number.isSafeInteger(event.created)
      || event.created < 1_230_768_000 || event.created > 253_402_300_799
      || typeof event.livemode !== 'boolean') {
    throw new StripeIntegrationError('Stripe event envelope is invalid', 400, 'invalid_event');
  }
  if (event.account !== undefined && event.account !== null) {
    throw new StripeIntegrationError(
      'Stripe Connect events are outside this deployment model', 400, 'stripe_connect_unsupported',
    );
  }
  if (event.context !== undefined && event.context !== null) {
    throw new StripeIntegrationError(
      'Stripe organization-context events are unsupported', 400, 'stripe_context_unsupported',
    );
  }
  if (event.api_version !== undefined && event.api_version !== null
      && (typeof event.api_version !== 'string' || event.api_version.length > 64
          || !/^\d{4}-\d{2}-\d{2}(?:\.[a-z][a-z0-9_-]{0,31})?$/.test(event.api_version))) {
    throw new StripeIntegrationError('Stripe event API version is invalid', 400, 'invalid_event');
  }
  const dataContainer = event.data;
  if (!dataContainer || typeof dataContainer !== 'object' || Array.isArray(dataContainer)) {
    throw new StripeIntegrationError('Stripe event data is invalid', 400, 'invalid_event');
  }
  const object = (dataContainer as { object?: unknown }).object as StripeObject | undefined;
  if (!object || typeof object !== 'object' || Array.isArray(object)) {
    throw new StripeIntegrationError('Stripe event object is invalid', 400, 'invalid_event');
  }
  const occurredAt = new Date(event.created * 1000).toISOString();

  if (PAYMENT_INTENT_EVENTS.has(event.type)) {
    if (object.object !== 'payment_intent') {
      throw new StripeIntegrationError('Stripe PaymentIntent event is invalid', 400, 'invalid_event');
    }
    const reference = requiredStripeId(object.id, 'pi_', 'PaymentIntent id');
    const statusByEvent: Record<string, string> = {
      'payment_intent.processing': 'processing',
      'payment_intent.requires_action': 'requires_action',
      'payment_intent.payment_failed': 'requires_payment_method',
      'payment_intent.succeeded': 'succeeded',
      'payment_intent.canceled': 'canceled',
    };
    if (object.status !== statusByEvent[event.type]) {
      throw new StripeIntegrationError(
        'Stripe PaymentIntent event status is inconsistent', 400, 'invalid_event',
      );
    }
    return {
      providerEventId,
      eventType: event.type,
      objectReference: reference,
      livemode: event.livemode,
      occurredAt,
      data: normalizedStripePaymentIntentData(object, event.type),
    };
  }

  if (REFUND_EVENTS.has(event.type)) {
    if (object.object !== 'refund') {
      throw new StripeIntegrationError('Stripe Refund event is invalid', 400, 'invalid_event');
    }
    const reference = requiredStripeId(object.id, 're_', 'Refund id');
    if (event.type === 'refund.failed' && object.status !== 'failed') {
      throw new StripeIntegrationError(
        'Stripe Refund event status is inconsistent', 400, 'invalid_event',
      );
    }
    return {
      providerEventId,
      eventType: event.type,
      objectReference: reference,
      livemode: event.livemode,
      occurredAt,
      data: normalizedStripeRefundData(object),
    };
  }

  const reference = typeof object.id === 'string' && STRIPE_ID.test(object.id) ? object.id : null;
  return {
    providerEventId,
    eventType: event.type,
    objectReference: reference,
    livemode: event.livemode,
    occurredAt,
    data: {
      object_type: typeof object.object === 'string' ? object.object.slice(0, 100) : null,
      status: typeof object.status === 'string' ? object.status.slice(0, 64) : null,
    },
  };
}

export type StripeFetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface StripeRequestOptions {
  secretKey: string;
  apiVersion?: string;
  apiBase?: string;
  idempotencyKey?: string;
  method?: 'GET' | 'POST';
  form?: Record<string, string>;
  fetcher?: StripeFetcher;
  timeoutMs?: number;
  maxNetworkRetries?: number;
  retryDelayMs?: number;
}

function normalizedStripeApiBase(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new StripeIntegrationError('Stripe API base URL is invalid', 500, 'stripe_config_invalid');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
    || url.hostname === 'host.docker.internal';
  const official = url.hostname === 'api.stripe.com';
  if ((!official && !local)
      || (official && (url.protocol !== 'https:' || (url.port && url.port !== '443')))
      || (local && !['http:', 'https:'].includes(url.protocol))
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new StripeIntegrationError('Stripe API base URL is untrusted', 500, 'stripe_config_invalid');
  }
  return url.origin;
}

export function parseStripeLivemode(value: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new StripeIntegrationError(
    'STRIPE_LIVEMODE must be true or false', 500, 'stripe_config_invalid',
  );
}

export function stripeApiBase(livemode: boolean, override = ''): string {
  const base = normalizedStripeApiBase(override || 'https://api.stripe.com');
  const local = new URL(base).hostname !== 'api.stripe.com';
  if (livemode && local) {
    throw new StripeIntegrationError(
      'Local Stripe API override is forbidden in live mode', 500, 'stripe_config_invalid',
    );
  }
  return base;
}

export function stripeApiVersion(value: unknown): string {
  if (typeof value !== 'string' || value.length > 64
      || !/^\d{4}-\d{2}-\d{2}(?:\.[a-z][a-z0-9_-]{0,31})?$/.test(value)) {
    throw new StripeIntegrationError('Stripe API version is invalid', 500, 'stripe_config_invalid');
  }
  return value;
}

export function parseStripeHttpTimeout(value: string): number {
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 20000) {
    throw new StripeIntegrationError(
      'STRIPE_HTTP_TIMEOUT_MS must be between 1000 and 20000',
      500,
      'stripe_config_invalid',
    );
  }
  return timeout;
}

export function parseStripeAllowRedirects(value: string): 'always' | 'never' {
  if (value === 'always' || value === 'never') return value;
  throw new StripeIntegrationError(
    'STRIPE_ALLOW_REDIRECTS must be always or never', 500, 'stripe_config_invalid',
  );
}

function requestErrorStatus(status: number): number {
  if (status === 401 || status === 403 || status === 424 || status >= 500 || status === 429) {
    return status === 429 ? 503 : 502;
  }
  if (status === 404 || status === 409) return 409;
  if (status === 402) return 402;
  return 400;
}

function retryableResponse(response: Response, safeToRetry: boolean, method: string): boolean {
  const directive = response.headers.get('Stripe-Should-Retry')?.toLowerCase();
  if (directive === 'false') return false;
  if (directive === 'true') return safeToRetry;
  if (response.status === 409 || response.status === 429) return safeToRetry;
  return method === 'GET' && response.status >= 500;
}

async function retryDelay(response: Response | null, attempt: number, configured?: number): Promise<void> {
  const retryAfter = response ? Number(response.headers.get('Retry-After') ?? NaN) : NaN;
  const milliseconds = Number.isFinite(retryAfter)
    ? Math.min(Math.max(retryAfter * 1000, 0), 1000)
    : configured ?? 100 * (attempt + 1);
  if (milliseconds > 0) await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function responseText(response: Response): Promise<string> {
  const declared = Number(response.headers.get('Content-Length') ?? 0);
  if (Number.isFinite(declared) && declared > MAX_PROVIDER_BODY_BYTES) {
    throw new StripeIntegrationError('Stripe response is too large', 502, 'stripe_bad_response');
  }
  const text = await response.text();
  if (encoder.encode(text).byteLength > MAX_PROVIDER_BODY_BYTES) {
    throw new StripeIntegrationError('Stripe response is too large', 502, 'stripe_bad_response');
  }
  return text;
}

export async function stripeRequest<T extends Record<string, unknown>>(
  path: string,
  options: StripeRequestOptions,
): Promise<T> {
  if (!/^\/v1\/[A-Za-z0-9_./%-]+$/.test(path) || path.includes('..')) {
    throw new StripeIntegrationError('Stripe API path is invalid', 500, 'stripe_config_invalid');
  }
  if (!options.secretKey || options.secretKey.length > 512 || /[\r\n]/.test(options.secretKey)) {
    throw new StripeIntegrationError('Stripe secret key is invalid', 500, 'stripe_key_invalid');
  }
  if (options.idempotencyKey
      && (options.idempotencyKey.length > 255
          || !/^[A-Za-z0-9_:-]+$/.test(options.idempotencyKey))) {
    throw new StripeIntegrationError('Stripe idempotency key is invalid', 500, 'stripe_config_invalid');
  }
  const method = options.method ?? 'POST';
  const apiBase = normalizedStripeApiBase(options.apiBase ?? 'https://api.stripe.com');
  const apiVersion = stripeApiVersion(options.apiVersion ?? DEFAULT_STRIPE_API_VERSION);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxRetries = options.maxNetworkRetries ?? 1;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 20_000
      || !Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 2) {
    throw new StripeIntegrationError('Stripe HTTP retry configuration is invalid', 500, 'stripe_config_invalid');
  }
  const headers = new Headers({
    Authorization: `Bearer ${options.secretKey}`,
    'Stripe-Version': apiVersion,
  });
  if (options.idempotencyKey) headers.set('Idempotency-Key', options.idempotencyKey);
  let body: URLSearchParams | undefined;
  if (method === 'POST') {
    headers.set('Content-Type', 'application/x-www-form-urlencoded');
    body = new URLSearchParams(options.form ?? {});
  }
  const safeToRetry = method === 'GET' || Boolean(options.idempotencyKey);
  let lastNetworkError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let response: Response;
    let text: string;
    try {
      response = await (options.fetcher ?? fetch)(`${apiBase}${path}`, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await responseText(response);
    } catch (error) {
      if (error instanceof StripeIntegrationError) throw error;
      lastNetworkError = error;
      if (!safeToRetry || attempt >= maxRetries) break;
      await retryDelay(null, attempt, options.retryDelayMs);
      continue;
    }

    if (!response.ok && attempt < maxRetries && retryableResponse(response, safeToRetry, method)) {
      await retryDelay(response, attempt, options.retryDelayMs);
      continue;
    }

    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new StripeIntegrationError('Stripe returned a non-JSON response', 502, 'stripe_bad_response');
    }
    if (!response.ok) {
      const error = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as { error?: { code?: unknown; type?: unknown } }).error
        : undefined;
      throw new StripeIntegrationError(
        'Stripe rejected the request',
        requestErrorStatus(response.status),
        safeProviderCode(error?.code) ?? safeProviderCode(error?.type) ?? 'stripe_request_failed',
      );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new StripeIntegrationError('Stripe response object is invalid', 502, 'stripe_bad_response');
    }
    return parsed as T;
  }

  void lastNetworkError;
  throw new StripeIntegrationError('Stripe request failed', 502, 'stripe_unavailable');
}

export function assertStripeKeyMode(secretKey: string, expectedLivemode: boolean): void {
  const live = secretKey.startsWith('sk_live_') || secretKey.startsWith('rk_live_');
  const test = secretKey.startsWith('sk_test_') || secretKey.startsWith('rk_test_');
  if ((!live && !test) || secretKey.length > 512 || /\s/.test(secretKey)) {
    throw new StripeIntegrationError(
      'Stripe secret key mode cannot be determined', 500, 'stripe_key_invalid',
    );
  }
  if (live !== expectedLivemode) {
    throw new StripeIntegrationError(
      'Stripe secret key does not match STRIPE_LIVEMODE', 500, 'stripe_mode_mismatch',
    );
  }
}

export function mapStripePaymentIntentStatus(
  status: unknown,
): 'requires_payment_method' | 'requires_action' | 'processing' {
  if (status === 'requires_payment_method') return status;
  if (status === 'processing') return status;
  if (status === 'requires_action' || status === 'requires_confirmation') return 'requires_action';
  throw new StripeIntegrationError(
    `PaymentIntent status ${String(status)} must be handled by webhook`,
    409,
    'unexpected_payment_status',
  );
}

export interface StripePaymentIntentResponse extends Record<string, unknown> {
  id: string;
  object: 'payment_intent';
  amount: number;
  amount_received: number;
  currency: string;
  status: string;
  client_secret: string | null;
  created: number;
  livemode: boolean;
  capture_method: string;
  confirmation_method: string;
  automatic_payment_methods?: { enabled?: boolean; allow_redirects?: string } | null;
  latest_charge?: string | null;
  canceled_at?: number | null;
  metadata?: Record<string, string>;
  last_payment_error?: Record<string, unknown> | null;
}

export interface StripeRefundResponse extends Record<string, unknown> {
  id: string;
  object: 'refund';
  amount: number;
  currency: string;
  status: string;
  created: number;
  // Unlike PaymentIntent and Event, Stripe Refund has no livemode field.
  payment_intent?: string | null;
  charge?: string | null;
  metadata?: Record<string, string>;
  failure_reason?: string | null;
  pending_reason?: string | null;
}
