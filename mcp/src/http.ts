import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { GrantAuthorizer, type AuthorizationConfig } from './authorization';
import { AdminBackend } from './backend';
import type { createCredentialCipher } from './credentials';
import { createAdminServer } from './server';

// Web Request handler only. Deployment owns TLS, listener limits and shutdown.
// No sessions, result replay, ambient administrator token or service-role business calls.
export function createAdminHttpHandler(
  config: AuthorizationConfig & { anonKey: string; allowWrites?: boolean },
  cipher: Awaited<ReturnType<typeof createCredentialCipher>>,
  request: (url: string, init: RequestInit) => Promise<Response> = fetch,
  admit?: (verifiedUserId: string) => number,
) {
  const c = { ...config, scopes: [...config.scopes], tokenProfile: 'oidc-provider' as const };
  const resource = new URL(c.resource);
  if (resource.protocol !== 'https:' || resource.pathname === '/' || !c.anonKey.trim())
    throw new Error('INVALID_MCP_HTTP_CONFIGURATION');
  const authorizer = new GrantAuthorizer(c, request);
  const metadata = new URL(`/.well-known/oauth-protected-resource${resource.pathname}`, resource.origin);
  const reply = (status: number, error: string, headers: Record<string, string> = {}) =>
    Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
  const unauthorized = () =>
    reply(401, 'unauthorized', {
      'WWW-Authenticate': `Bearer resource_metadata="${metadata.href}"`,
    });
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (
      url.origin !== resource.origin ||
      (req.headers.has('host') && req.headers.get('host') !== resource.host)
    )
      return reply(403, 'forbidden');
    if (req.headers.has('origin') && req.headers.get('origin') !== resource.origin)
      return reply(403, 'forbidden');
    if (url.search) return reply(400, 'invalid_request');
    if (url.pathname === metadata.pathname) {
      if (req.method !== 'GET') return reply(405, 'method_not_allowed', { Allow: 'GET' });
      return Response.json(
        {
          resource: c.resource,
          authorization_servers: [c.issuer],
          scopes_supported: c.scopes,
          bearer_methods_supported: ['header'],
        },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }
    if (url.pathname !== resource.pathname) return reply(404, 'not_found');
    const token = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i.exec(req.headers.get('authorization') ?? '')?.[1];
    if (!token || token.length > 16384) return unauthorized();
    let identity: Awaited<ReturnType<GrantAuthorizer['authorize']>>;
    try {
      identity = await authorizer.authorize(token);
    } catch {
      return unauthorized();
    }
    const retry = admit?.(identity.expectedUserId) ?? 0;
    if (retry) return reply(429, 'rate_limited', { 'Retry-After': String(retry) });
    if (req.method !== 'POST') return reply(405, 'method_not_allowed', { Allow: 'POST' });
    if (req.headers.has('mcp-session-id')) return reply(400, 'sessions_not_supported');
    // Bound the body even when Content-Length is missing or false.
    const reader = req.body?.getReader();
    const abort = () => {
      void reader?.cancel().catch(() => {});
    };
    req.signal.addEventListener('abort', abort, { once: true });
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let length = 0;
    try {
      if (req.signal.aborted) return reply(408, 'request_aborted');
      if (reader)
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.byteLength;
          if (length > 1024 * 1024) {
            await reader.cancel();
            return reply(413, 'request_too_large');
          }
          chunks.push(new Uint8Array(part.value));
        }
    } catch {
      return reply(400, 'invalid_request');
    } finally {
      req.signal.removeEventListener('abort', abort);
      reader?.releaseLock();
    }
    if (req.signal.aborted) return reply(408, 'request_aborted');
    let stored: Awaited<ReturnType<GrantAuthorizer['readCredentials']>>;
    try {
      stored = await authorizer.readCredentials(token, cipher);
      if (stored.credentials && stored.credentials.expiresAt <= Math.floor(Date.now() / 1000) + 30) {
        await authorizer.refreshCredentials(token, cipher, {
          expectedRevision: stored.revision,
          anonKey: c.anonKey,
        });
        stored = await authorizer.readCredentials(token, cipher);
      }
      if (
        stored.grantId !== identity.grantId ||
        stored.expectedUserId !== identity.expectedUserId ||
        !stored.credentials ||
        stored.credentials.expiresAt <= Math.floor(Date.now() / 1000)
      )
        throw new Error('Unavailable credentials');
    } catch {
      return reply(503, 'authorization_unavailable');
    }
    const backend = new AdminBackend(
      {
        url: c.supabaseUrl,
        anonKey: c.anonKey,
        accessToken: stored.credentials.accessToken,
        expectedUserId: identity.expectedUserId,
      },
      request,
    );
    const server = createAdminServer(backend, {
      allowWrites: c.allowWrites,
      authorization: identity.authorization,
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(
        new Request(req.url, {
          method: 'POST',
          headers: req.headers,
          body: new Blob(chunks),
          signal: req.signal,
        }),
      );
      response.headers.set('Cache-Control', 'no-store');
      return response;
    } catch {
      return reply(500, 'mcp_request_failed');
    } finally {
      await server.close();
    }
  };
}
