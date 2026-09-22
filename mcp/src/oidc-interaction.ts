import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type Provider from 'oidc-provider';
import { createLoginHttpHandler } from './login-http';
import { createOidcApproval } from './oidc-approval';
import type { AdminScope } from './permissions';

type Config = Omit<Parameters<typeof createOidcApproval>[1], 'clientId' | 'scopes'> & {
  publicOrigin: string;
  callbackUrl: string;
  scopes: readonly AdminScope[];
};
type Transaction = { fingerprint: string; expiresAt: number; state: 'pending' | 'completing' | 'finished' };

// Native Node HTTP handler for the authorization service, not an MCP tool/listener.
// Mount before provider.callback(); false means the provider owns the route.
// interactions.url must return /interaction/:uid. Provider cookie/session validation
// uses the ORIGINAL native request, never a reconstructed cookie or a caller UID.
export function createOidcInteractionHandler(
  provider: Provider,
  config: Config,
  cipher: Parameters<typeof createOidcApproval>[2],
  request: (url: string, init: RequestInit) => Promise<Response> = fetch,
) {
  const c = { ...config, scopes: [...config.scopes] };
  const origin = new URL(c.publicOrigin).origin;
  if (provider.issuer !== origin || new URL(c.callbackUrl).pathname.startsWith('/interaction/'))
    throw new Error('INVALID_INTERACTION_CONFIGURATION');
  const login = createLoginHttpHandler(c, request);
  const callbackPath = new URL(c.callbackUrl).pathname;
  const transactions = new Map<string, Transaction>();

  async function details(req: IncomingMessage, res: ServerResponse, uid: string) {
    const d = await provider.interactionDetails(req, res);
    const p = d.params;
    const scopes = typeof p.scope === 'string' ? p.scope.split(' ') : [];
    const storeScopes = scopes.filter((s) => c.scopes.includes(s as AdminScope)) as AdminScope[];
    if (
      d.uid !== uid ||
      d.result !== undefined ||
      !Number.isSafeInteger(d.exp) ||
      d.exp! <= Math.floor(Date.now() / 1000) ||
      !['login', 'consent'].includes(d.prompt.name) ||
      typeof p.client_id !== 'string' ||
      typeof p.redirect_uri !== 'string' ||
      p.response_type !== 'code' ||
      p.code_challenge_method !== 'S256' ||
      (p.resource !== c.resource &&
        !(Array.isArray(p.resource) && p.resource.length === 1 && p.resource[0] === c.resource)) ||
      !scopes.includes('openid') ||
      !scopes.includes('offline_access') ||
      !storeScopes.length ||
      scopes.some((s) => !['openid', 'offline_access', ...c.scopes].includes(s))
    )
      throw new Error('Rejected provider interaction');
    const consent = {
      clientId: p.client_id,
      redirectUri: p.redirect_uri,
      resource: c.resource,
      scopes: [...new Set(storeScopes)].sort(),
      offlineAccess: true,
    };
    return { consent, fingerprint: JSON.stringify(consent), expiresAt: d.exp! * 1000, session: d.session };
  }
  function current(uid: string, fingerprint?: string) {
    const tx = transactions.get(uid);
    if (!tx || Date.now() >= tx.expiresAt || (fingerprint && tx.fingerprint !== fingerprint))
      throw new Error('Rejected interaction transaction');
    return tx;
  }
  function json(body: unknown, status = 200) {
    return Response.json(body, { status });
  }
  async function send(res: ServerResponse, response: Response) {
    res.statusCode = response.status;
    for (const [name, value] of response.headers) if (name !== 'set-cookie') res.setHeader(name, value);
    const cookies = response.headers.getSetCookie();
    if (cookies.length) res.setHeader('Set-Cookie', cookies);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    res.end(await response.text());
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const raw = req.url ?? '';
    const path = raw.split('?')[0];
    if (!path.startsWith('/interaction/') && !path.startsWith('/login/') && path !== callbackPath)
      return false;
    try {
      // A trusted TLS host/proxy must preserve this configured authority. Never
      // generate origins/redirects from Host or Forwarded/X-Forwarded-* headers.
      if (req.headers.host !== new URL(origin).host || raw.includes('#') || raw.includes('\\'))
        throw new Error('Rejected authority');
      for (const [uid, tx] of transactions) if (Date.now() >= tx.expiresAt) transactions.delete(uid);
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers))
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      const hasBody =
        req.headers['transfer-encoding'] !== undefined ||
        (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0');
      if (hasBody && path !== '/login/email') throw new Error('Unexpected request body');
      const web = new Request(`${origin}${raw}`, {
        method: req.method,
        headers,
        ...(hasBody
          ? { body: Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>, duplex: 'half' }
          : {}),
      });
      if (new URL(web.url).pathname !== path) throw new Error('Noncanonical path');
      const rewrite = (destination: string) =>
        new Request(`${origin}${destination}`, { method: web.method, headers: web.headers });
      const match = /^\/interaction\/([A-Za-z0-9_-]{1,256})(?:\/(start|approve|cancel))?$/.exec(path);
      if (!match) {
        // Do not expose the standalone bootstrap/handoff/cancellation routes.
        if (!['/login/email', '/login/status', callbackPath].includes(path)) {
          await send(res, json({ error: 'NOT_FOUND' }, 404));
          return true;
        }
        const uid = login.interactionId(web);
        if (!uid) throw new Error('Unbound login');
        if (current(uid).state !== 'pending') {
          await send(res, json({ error: 'INTERACTION_ALREADY_ATTEMPTED' }, 409));
          return true;
        }
        await send(res, await login.handle(web));
        return true;
      }
      const [, uid, action] = match;
      if (raw !== path) throw new Error('Unexpected interaction query');
      if (web.method !== (action ? 'POST' : 'GET')) throw new Error('Unexpected method');
      const verified = await details(req, res, uid);
      if (!action) {
        await send(res, json(verified.consent));
        return true;
      }
      if (web.headers.get('origin') !== origin) throw new Error('Unexpected origin');
      if (action === 'start') {
        if (web.headers.get('x-tera-login') !== 'start') throw new Error('Missing bootstrap proof');
        if (transactions.has(uid)) {
          await send(res, json({ error: 'INTERACTION_ALREADY_STARTED' }, 409));
          return true;
        }
        if (transactions.size >= 1024) {
          await send(res, json({ error: 'INTERACTION_CAPACITY' }, 429));
          return true;
        }
        const tx: Transaction = {
          fingerprint: verified.fingerprint,
          expiresAt: Math.min(verified.expiresAt, Date.now() + 300_000),
          state: 'pending',
        };
        transactions.set(uid, tx); // Single admission, including uncertain responses.
        const response = await login.handle(rewrite('/login/session'), uid);
        if (response.status !== 201) tx.state = 'finished';
        await send(res, response);
        return true;
      }
      if (web.headers.get('x-tera-consent') !== (action === 'approve' ? 'approve' : 'deny'))
        throw new Error('Missing explicit consent decision');
      if (login.interactionId(web) !== uid) throw new Error('Different browser login');
      const tx = current(uid, verified.fingerprint);
      if (tx.state !== 'pending') {
        await send(res, json({ error: 'INTERACTION_ALREADY_ATTEMPTED' }, 409));
        return true;
      }
      if (action === 'cancel') {
        tx.state = 'completing';
        try {
          const cancelled = await login.handle(rewrite('/login/cancel'));
          if (!cancelled.ok) throw new Error('Cancellation failed');
          const location = await provider.interactionResult(
            req,
            res,
            { error: 'access_denied' },
            {
              mergeWithLastSubmission: false,
            },
          );
          cancelled.headers.set('Location', location);
          await send(res, new Response(null, { status: 303, headers: cancelled.headers }));
        } finally {
          tx.state = 'finished';
        }
        return true;
      }
      const identity = login.takeIdentity(rewrite('/login/approve'), uid);
      tx.state = 'completing'; // Claim synchronously before any persistence/completion await.
      const approval = createOidcApproval(provider, { ...c, ...verified.consent }, cipher, request);
      let persisted = false;
      try {
        if (verified.session?.accountId && verified.session.accountId !== identity.userId)
          throw new Error('Different provider account');
        const result = await approval.approve(identity);
        persisted = true;
        const latest = await details(req, res, uid);
        current(uid, latest.fingerprint);
        const location = await provider.interactionResult(
          req,
          res,
          {
            login: { accountId: identity.userId },
            consent: { grantId: result.providerGrantId },
          },
          { mergeWithLastSubmission: false },
        );
        current(uid, latest.fingerprint);
        if (identity.credentials.expiresAt <= Math.floor(Date.now() / 1000))
          throw new Error('Login expired during completion');
        await send(res, new Response(null, { status: 303, headers: { Location: location } }));
      } catch (error) {
        if (persisted) await approval.revoke();
        throw error;
      } finally {
        tx.state = 'finished';
      }
      return true;
    } catch (error) {
      // Do not log/return identity, credentials, provider messages or grant IDs.
      const code =
        error instanceof Error && error.message === 'APPROVAL_CLEANUP_UNCONFIRMED'
          ? 'APPROVAL_CLEANUP_UNCONFIRMED'
          : 'INTERACTION_REQUEST_REJECTED';
      await send(res, json({ error: code }, code === 'APPROVAL_CLEANUP_UNCONFIRMED' ? 503 : 403));
      return true;
    }
  };
}
