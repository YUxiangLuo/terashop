export class HttpError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = 'bad_request',
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new HttpError(`Server secret ${name} is not configured`, 500, 'server_misconfigured');
  return value;
}

export function optionalEnv(name: string, fallback = ''): string {
  return Deno.env.get(name)?.trim() || fallback;
}

const securityHeaders = {
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export function jsonResponse(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...securityHeaders, ...Object.fromEntries(new Headers(headers)) },
  });
}

export function errorResponse(error: unknown, headers: HeadersInit = {}): Response {
  const status = error instanceof HttpError
    ? error.status
    : typeof error === 'object' && error !== null && 'status' in error
      ? Number((error as { status: unknown }).status) || 500
      : 500;
  const code = error instanceof HttpError
    ? error.code
    : typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : 'internal_error';
  const message = status >= 500
    ? 'Payment service temporarily unavailable'
    : error instanceof Error ? error.message : 'Invalid request';
  return jsonResponse({ error: { code, message } }, status, headers);
}

export function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin');
  if (!origin) return {};
  const configured = optionalEnv(
    'PAYMENT_ALLOWED_ORIGINS',
    'http://localhost:3000,http://127.0.0.1:3000',
  ).split(',').map((value) => value.trim()).filter(Boolean);
  if (!configured.includes(origin)) throw new HttpError('Origin is not allowed', 403, 'origin_denied');
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

export async function readJsonBody(request: Request, maxBytes = 32768): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get('Content-Length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new HttpError('Request body is too large', 413, 'body_too_large');
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new HttpError('Request body is too large', 413, 'body_too_large');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError('Request body must be valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError('Request body must be an object');
  }
  return parsed as Record<string, unknown>;
}

interface SupabaseUser {
  id: string;
  email?: string;
}

export async function authenticatedUser(request: Request): Promise<SupabaseUser> {
  const authorization = request.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ') || authorization.length > 8192) {
    throw new HttpError('Authentication required', 401, 'unauthorized');
  }
  const supabaseUrl = requiredEnv('SUPABASE_URL');
  const anonKey = requiredEnv('SUPABASE_ANON_KEY');
  let response: Response;
  try {
    response = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: anonKey, Authorization: authorization },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new HttpError('Authentication service unavailable', 503, 'auth_unavailable');
  }
  if (!response.ok) {
    if (response.status >= 500) {
      throw new HttpError('Authentication service unavailable', 503, 'auth_unavailable');
    }
    throw new HttpError('Authentication required', 401, 'unauthorized');
  }
  let user: Partial<SupabaseUser>;
  try {
    user = await response.json() as Partial<SupabaseUser>;
  } catch {
    throw new HttpError('Authentication service unavailable', 503, 'auth_unavailable');
  }
  if (typeof user.id !== 'string') throw new HttpError('Authentication required', 401, 'unauthorized');
  return { id: user.id, email: user.email };
}

export function requireServiceRoleRequest(request: Request): void {
  const authorization = request.headers.get('Authorization');
  const expected = `Bearer ${requiredEnv('SUPABASE_SERVICE_ROLE_KEY')}`;
  if (!authorization || authorization.length !== expected.length) {
    throw new HttpError('Service role authentication required', 401, 'unauthorized');
  }
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= authorization.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  if (difference !== 0) {
    throw new HttpError('Service role authentication required', 401, 'unauthorized');
  }
}

export async function serviceRpc<T>(name: string, body: Record<string, unknown>): Promise<T> {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new HttpError('Invalid RPC name', 500, 'server_misconfigured');
  const supabaseUrl = requiredEnv('SUPABASE_URL');
  const serviceKey = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
  let response: Response;
  try {
    response = await fetch(`${supabaseUrl}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new HttpError('Database payment operation unavailable', 502, 'database_unavailable');
  }
  const declaredLength = Number(response.headers.get('Content-Length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > 1_048_576) {
    throw new HttpError('Database payment response is too large', 502, 'database_bad_response');
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new HttpError('Database payment operation unavailable', 502, 'database_unavailable');
  }
  if (new TextEncoder().encode(text).byteLength > 1_048_576) {
    throw new HttpError('Database payment response is too large', 502, 'database_bad_response');
  }
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const message = parsed && typeof parsed === 'object' && 'message' in parsed
      ? String((parsed as { message: unknown }).message)
      : 'Database payment operation failed';
    const code = parsed && typeof parsed === 'object' && 'code' in parsed
      ? String((parsed as { code: unknown }).code)
      : 'database_error';
    throw new HttpError(message, response.status >= 500 ? 502 : response.status, code);
  }
  return parsed as T;
}

export function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new HttpError(`${field} must be a UUID`);
  }
  return value;
}

export function requireIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > 200) {
    throw new HttpError('idempotency_key is required and must be at most 200 characters');
  }
  return value.trim();
}
