import { createHash } from 'node:crypto';
import * as z from 'zod/v4';
import { createLoginBrowserSessions } from './browser-sessions';
import { createDownstreamLogin } from './login';

type Attempt = Awaited<ReturnType<typeof createDownstreamLogin>>;
type Identity = Awaited<ReturnType<Attempt['exchange']>>;
type Transaction = {
  expiresAt: number;
  status: 'issued' | 'sending' | 'awaiting_callback' | 'exchanging' | 'authenticated' | 'consumed' | 'failed';
  attempt?: Attempt;
  identity?: Identity;
};
const key = (id: string) => createHash('sha256').update(id).digest('hex');

// Mount only behind the host's trusted upstream authorization transaction.
// This proves the downstream identity; it does NOT approve or create an MCP grant.
// No listener, CORS policy, upstream identity, or automatic credential persistence.
export function createLoginHttpHandler(
  config: { publicOrigin: string; callbackUrl: string; supabaseUrl: string; anonKey: string },
  request: (url: string, init: RequestInit) => Promise<Response> = fetch,
) {
  const c = { ...config };
  const sessions = createLoginBrowserSessions(c.publicOrigin);
  const origin = new URL(c.publicOrigin).origin;
  const callback = new URL(c.callbackUrl);
  if (
    callback.origin !== origin ||
    callback.href !== `${origin}${callback.pathname}` ||
    callback.pathname.startsWith('/login/')
  )
    throw new Error('INVALID_LOGIN_HTTP_CONFIGURATION');
  const transactions = new Map<string, Transaction>();
  let windowStart = Date.now(),
    issued = 0;

  function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
    return Response.json(body, {
      status,
      headers: {
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
        ...headers,
      },
    });
  }
  function current(req: Request, mutation: boolean) {
    for (const [id, tx] of transactions) if (Date.now() >= tx.expiresAt) transactions.delete(id);
    const id = sessions.read(req, mutation);
    const transaction = transactions.get(key(id));
    if (!transaction || Date.now() >= transaction.expiresAt) {
      transactions.delete(key(id));
      throw new Error('Rejected login transaction');
    }
    return { id, transaction };
  }
  function exact(req: Request, path: string) {
    if (req.url !== `${origin}${path}`) throw new Error('Invalid login destination');
  }
  async function email(req: Request) {
    if (req.headers.get('content-type') !== 'application/json' || !req.body)
      throw new Error('Invalid email request');
    const reader = req.body.getReader();
    let bytes = new Uint8Array(0),
      timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void reader.cancel().catch(() => {});
    }, 10_000);
    try {
      while (true) {
        const part = await reader.read();
        if (timedOut) throw new Error('Request timed out');
        if (part.done) break;
        if (bytes.length + part.value.length > 1024) throw new Error('Request too large');
        bytes = new Uint8Array([...bytes, ...part.value]);
      }
      return z.strictObject({ email: z.email().max(254) }).parse(JSON.parse(new TextDecoder().decode(bytes)))
        .email;
    } finally {
      clearTimeout(timer);
      await reader.cancel().catch(() => {});
    }
  }

  return {
    async handle(req: Request): Promise<Response> {
      try {
        const url = new URL(req.url);
        if (url.origin !== origin || url.username || url.password || url.hash)
          return json({ error: 'LOGIN_REQUEST_REJECTED' }, 403);
        if (url.pathname === '/login/session') {
          exact(req, '/login/session');
          // A cross-site navigation or form cannot bootstrap/reset this cookie.
          if (
            req.method !== 'POST' ||
            req.headers.get('origin') !== origin ||
            req.headers.get('x-tera-login') !== 'start' ||
            req.body !== null
          )
            return json({ error: 'LOGIN_REQUEST_REJECTED' }, 403);
          const now = Date.now();
          for (const [id, tx] of transactions) if (now >= tx.expiresAt) transactions.delete(id);
          if (now - windowStart >= 60_000) {
            windowStart = now;
            issued = 0;
          }
          if (issued >= 20) return json({ error: 'LOGIN_RATE_LIMITED' }, 429, { 'Retry-After': '60' });
          issued++;
          const result = sessions.issue();
          const cookie = result.setCookie.split(';')[0];
          const id = sessions.read(new Request(`${origin}/login/status`, { headers: { cookie } }), false);
          transactions.set(key(id), { expiresAt: now + 300_000, status: 'issued' });
          return json({ csrfToken: result.csrfToken }, 201, { 'Set-Cookie': result.setCookie });
        }
        if (url.pathname === '/login/email') {
          exact(req, '/login/email');
          const { id, transaction: tx } = current(req, true);
          const address = await email(req);
          current(req, true);
          if (tx.status !== 'issued') return json({ error: 'LOGIN_ALREADY_STARTED' }, 409);
          tx.status = 'sending'; // Claim before any provider request, including uncertain sends.
          try {
            const attempt = await createDownstreamLogin({ ...c, browserSession: id }, request);
            current(req, true);
            tx.attempt = attempt;
            const response = await request(
              `${new URL(c.supabaseUrl).origin}/auth/v1/otp?redirect_to=${encodeURIComponent(attempt.redirectTo)}`,
              {
                method: 'POST',
                headers: { apikey: c.anonKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  email: address,
                  create_user: false,
                  code_challenge: attempt.codeChallenge,
                  code_challenge_method: attempt.codeChallengeMethod,
                }),
                redirect: 'error',
                cache: 'no-store',
                signal: AbortSignal.timeout(10_000),
              },
            );
            await response.body?.cancel();
            if (!response.ok) throw new Error('Email request failed');
            current(req, true);
            tx.status = 'awaiting_callback';
          } catch {
            tx.status = 'failed';
            tx.attempt = undefined;
          }
          // Do not disclose whether the email belongs to an existing account.
          return json({ status: 'email_requested' }, 202);
        }
        if (url.pathname === callback.pathname) {
          const { id, transaction: tx } = current(req, false);
          if (tx.status !== 'awaiting_callback' || !tx.attempt)
            return json({ error: 'LOGIN_CALLBACK_REJECTED' }, 400);
          tx.status = 'exchanging';
          try {
            const identity = await tx.attempt.exchange(req.url, id);
            current(req, false); // Cancellation/expiry while Auth was in flight wins.
            tx.identity = identity;
            tx.attempt = undefined;
            tx.status = 'authenticated';
          } catch (error) {
            if (error instanceof Error && error.message === 'LOGIN_CALLBACK_REJECTED') {
              tx.status = 'awaiting_callback';
              return json({ error: 'LOGIN_CALLBACK_REJECTED' }, 400);
            }
            tx.status = 'failed';
            tx.attempt = undefined;
          }
          return json({ status: 'callback_processed' }, 303, { Location: `${origin}/login/status` });
        }
        if (url.pathname === '/login/status') {
          exact(req, '/login/status');
          const { transaction: tx } = current(req, false);
          // Before proof of email ownership, failures and successful sends look alike.
          const status = tx.status === 'authenticated' || tx.status === 'consumed' ? tx.status : 'pending';
          return json({ status });
        }
        if (url.pathname === '/login/cancel') {
          exact(req, '/login/cancel');
          const { id } = current(req, true);
          const cookie = sessions.revoke(req);
          transactions.delete(key(id));
          return json({ status: 'cancelled' }, 200, { 'Set-Cookie': cookie });
        }
        return json({ error: 'NOT_FOUND' }, 404);
      } catch {
        return json({ error: 'LOGIN_REQUEST_REJECTED' }, 403);
      }
    },
    // Internal handoff only. The caller MUST separately prove/bind upstream identity
    // and obtain consent. This path is deliberately NOT served by handle().
    takeIdentity(req: Request): Identity {
      exact(req, '/login/approve');
      const { transaction: tx } = current(req, true);
      if (tx.status !== 'authenticated' || !tx.identity) throw new Error('LOGIN_IDENTITY_UNAVAILABLE');
      const identity = tx.identity;
      tx.identity = undefined;
      tx.status = 'consumed';
      if (identity.credentials.expiresAt <= Math.floor(Date.now() / 1000))
        throw new Error('LOGIN_IDENTITY_UNAVAILABLE');
      return identity;
    },
  };
}
