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

function hex(bytes: ArrayBuffer | Uint8Array): string {
  const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function decodeHex(value: string): Uint8Array | null {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) return null;
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

export async function verifyStripeSignature(
  payload: string,
  signatureHeader: string | null,
  secrets: readonly string[],
  options: { nowSeconds?: number; toleranceSeconds?: number } = {},
): Promise<{ timestamp: number }> {
  if (!signatureHeader) throw new StripeIntegrationError('Missing Stripe-Signature header', 400, 'missing_signature');
  const timestampValues: string[] = [];
  const signatures: string[] = [];
  for (const part of signatureHeader.split(',')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === 't') timestampValues.push(value);
    if (key === 'v1') signatures.push(value);
  }
  const timestampText = timestampValues.at(-1);
  if (!timestampText || !/^\d{1,12}$/.test(timestampText) || signatures.length === 0) {
    throw new StripeIntegrationError('Malformed Stripe-Signature header', 400, 'malformed_signature');
  }
  const timestamp = Number(timestampText);
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = options.toleranceSeconds ?? 300;
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > tolerance) {
    throw new StripeIntegrationError('Stripe signature timestamp is outside tolerance', 400, 'stale_signature');
  }
  const configuredSecrets = secrets.map((secret) => secret.trim()).filter(Boolean);
  if (configuredSecrets.length === 0) {
    throw new StripeIntegrationError('Stripe webhook secret is not configured', 500, 'missing_webhook_secret');
  }
  const supplied = signatures.map(decodeHex).filter((value): value is Uint8Array => value !== null);
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
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new StripeIntegrationError('Amount must be a positive CNY decimal with at most two places');
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
  if (!/^[1-9]\d*$/.test(text)) throw new StripeIntegrationError('Stripe amount must be a positive integer');
  const padded = text.padStart(3, '0');
  return `${padded.slice(0, -2)}.${padded.slice(-2)}`;
}

function safeMetadata(input: unknown, keys: readonly string[]): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const source = input as Record<string, unknown>;
  return Object.fromEntries(
    keys.flatMap((key) => typeof source[key] === 'string' ? [[key, source[key] as string]] : []),
  );
}

function integerString(value: unknown, field: string): string {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+$/.test(String(value))) {
    throw new StripeIntegrationError(`Stripe ${field} must be an integer`, 400, 'invalid_event');
  }
  return String(value);
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

export interface NormalizedProviderEvent {
  providerEventId: string;
  eventType: string;
  objectReference: string | null;
  livemode: boolean;
  occurredAt: string;
  data: Record<string, unknown>;
}

export function normalizeStripeEvent(input: unknown): NormalizedProviderEvent {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new StripeIntegrationError('Stripe event must be an object', 400, 'invalid_event');
  }
  const event = input as Record<string, unknown>;
  if (typeof event.id !== 'string' || !event.id.startsWith('evt_')
      || typeof event.type !== 'string' || !event.type
      || typeof event.created !== 'number' || !Number.isSafeInteger(event.created)
      || typeof event.livemode !== 'boolean') {
    throw new StripeIntegrationError('Stripe event envelope is invalid', 400, 'invalid_event');
  }
  const dataContainer = event.data;
  if (!dataContainer || typeof dataContainer !== 'object' || Array.isArray(dataContainer)) {
    throw new StripeIntegrationError('Stripe event data is invalid', 400, 'invalid_event');
  }
  const object = (dataContainer as { object?: unknown }).object as StripeObject | undefined;
  if (!object || typeof object !== 'object' || Array.isArray(object)) {
    throw new StripeIntegrationError('Stripe event object is invalid', 400, 'invalid_event');
  }
  const reference = typeof object.id === 'string' ? object.id : null;
  const occurredAt = new Date(event.created * 1000).toISOString();

  if (event.type.startsWith('payment_intent.')) {
    if (object.object !== 'payment_intent' || !reference || typeof object.currency !== 'string') {
      throw new StripeIntegrationError('Stripe PaymentIntent event is invalid', 400, 'invalid_event');
    }
    const error = object.last_payment_error && typeof object.last_payment_error === 'object'
      ? object.last_payment_error as Record<string, unknown>
      : {};
    const amount = event.type === 'payment_intent.succeeded' && Number(object.amount_received) > 0
      ? object.amount_received
      : object.amount;
    return {
      providerEventId: event.id,
      eventType: event.type,
      objectReference: reference,
      livemode: event.livemode,
      occurredAt,
      data: {
        object_type: 'payment_intent',
        status: typeof object.status === 'string' ? object.status : null,
        amount_minor: integerString(amount, 'PaymentIntent amount'),
        currency: object.currency.toLowerCase(),
        latest_charge: typeof object.latest_charge === 'string' ? object.latest_charge : null,
        failure_code: typeof error.code === 'string' ? error.code : null,
        failure_message: typeof error.message === 'string' ? error.message.slice(0, 2000) : null,
        metadata: safeMetadata(object.metadata, ['tera_payment_intent_id', 'tera_order_id']),
      },
    };
  }

  if (event.type.startsWith('refund.')) {
    if (object.object !== 'refund' || !reference || typeof object.currency !== 'string') {
      throw new StripeIntegrationError('Stripe Refund event is invalid', 400, 'invalid_event');
    }
    return {
      providerEventId: event.id,
      eventType: event.type,
      objectReference: reference,
      livemode: event.livemode,
      occurredAt,
      data: {
        object_type: 'refund',
        status: typeof object.status === 'string' ? object.status : null,
        amount_minor: integerString(object.amount, 'Refund amount'),
        currency: object.currency.toLowerCase(),
        payment_intent_reference: typeof object.payment_intent === 'string' ? object.payment_intent : null,
        charge_reference: typeof object.charge === 'string' ? object.charge : null,
        failure_code: typeof object.failure_reason === 'string' ? object.failure_reason : null,
        failure_message: typeof object.failure_reason === 'string' ? object.failure_reason : null,
        pending_reason: typeof object.pending_reason === 'string' ? object.pending_reason : null,
        metadata: safeMetadata(object.metadata, ['tera_refund_request_id', 'tera_order_id']),
      },
    };
  }

  return {
    providerEventId: event.id,
    eventType: event.type,
    objectReference: reference,
    livemode: event.livemode,
    occurredAt,
    data: {
      object_type: typeof object.object === 'string' ? object.object : null,
      status: typeof object.status === 'string' ? object.status : null,
    },
  };
}

export type StripeFetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface StripeRequestOptions {
  secretKey: string;
  apiVersion?: string;
  apiBase?: string;
  idempotencyKey?: string;
  method?: 'GET' | 'POST';
  form?: Record<string, string>;
  fetcher?: StripeFetcher;
}

export async function stripeRequest<T extends Record<string, unknown>>(
  path: string,
  options: StripeRequestOptions,
): Promise<T> {
  const method = options.method ?? 'POST';
  const headers = new Headers({
    Authorization: `Bearer ${options.secretKey}`,
    'Stripe-Version': options.apiVersion ?? DEFAULT_STRIPE_API_VERSION,
  });
  if (options.idempotencyKey) headers.set('Idempotency-Key', options.idempotencyKey);
  let body: URLSearchParams | undefined;
  if (method === 'POST') {
    headers.set('Content-Type', 'application/x-www-form-urlencoded');
    body = new URLSearchParams(options.form ?? {});
  }
  const response = await (options.fetcher ?? fetch)(`${options.apiBase ?? 'https://api.stripe.com'}${path}`, {
    method,
    headers,
    body,
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new StripeIntegrationError('Stripe returned a non-JSON response', 502, 'stripe_bad_response');
  }
  if (!response.ok) {
    const error = parsed && typeof parsed === 'object'
      ? (parsed as { error?: { code?: string; type?: string } }).error
      : undefined;
    throw new StripeIntegrationError(
      'Stripe rejected the request',
      response.status >= 500 ? 502 : 400,
      error?.code ?? error?.type ?? 'stripe_request_failed',
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new StripeIntegrationError('Stripe response object is invalid', 502, 'stripe_bad_response');
  }
  return parsed as T;
}

export function assertStripeKeyMode(secretKey: string, expectedLivemode: boolean): void {
  const live = secretKey.startsWith('sk_live_') || secretKey.startsWith('rk_live_');
  const test = secretKey.startsWith('sk_test_') || secretKey.startsWith('rk_test_');
  if (!live && !test) {
    throw new StripeIntegrationError('Stripe secret key mode cannot be determined', 500, 'stripe_key_invalid');
  }
  if (live !== expectedLivemode) {
    throw new StripeIntegrationError('Stripe secret key does not match STRIPE_LIVEMODE', 500, 'stripe_mode_mismatch');
  }
}

export function mapStripePaymentIntentStatus(status: unknown): 'requires_payment_method' | 'requires_action' | 'processing' {
  if (status === 'requires_payment_method') return status;
  if (status === 'processing') return status;
  if (status === 'requires_action' || status === 'requires_confirmation' || status === 'requires_capture') {
    return 'requires_action';
  }
  throw new StripeIntegrationError(`PaymentIntent status ${String(status)} must be handled by webhook`, 409, 'unexpected_payment_status');
}

export interface StripePaymentIntentResponse extends Record<string, unknown> {
  id: string;
  object: 'payment_intent';
  amount: number;
  currency: string;
  status: string;
  client_secret: string | null;
  metadata?: Record<string, string>;
}

export interface StripeRefundResponse extends Record<string, unknown> {
  id: string;
  object: 'refund';
  amount: number;
  currency: string;
  status: string;
  created: number;
  livemode?: boolean;
  payment_intent?: string;
  charge?: string;
  metadata?: Record<string, string>;
  failure_reason?: string | null;
  pending_reason?: string | null;
}
