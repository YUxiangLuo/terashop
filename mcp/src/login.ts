import * as z from 'zod/v4';
import { createHash, timingSafeEqual } from 'node:crypto';
import { AdminBackend } from './backend';
import type { DownstreamCredentials } from './credentials';

const token = z
  .string()
  .min(1)
  .max(16384)
  .regex(/^[\x21-\x7e]+$/);
const responseSchema = z.object({
  access_token: token,
  refresh_token: token,
  token_type: z.literal('bearer'),
  expires_at: z.number().int().positive(),
  user: z.object({ id: z.uuid(), is_anonymous: z.literal(false) }),
});
const browserSessionSchema = z
  .string()
  .min(32)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);
const callbackSchema = z.strictObject({
  browserSession: browserSessionSchema,
  state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

// Trusted-host primitive, not a browser callback or MCP tool. The host must bind
// this attempt to its authenticated browser transaction and require consent
// before creating a grant. Never accept caller-supplied credential pairs.
export async function createDownstreamLogin(
  config: { supabaseUrl: string; anonKey: string; browserSession: string },
  request: (url: string, init: RequestInit) => Promise<Response> = fetch,
) {
  let origin: string;
  let browserDigest: Buffer;
  const anonKey = config.anonKey;
  try {
    const url = new URL(config.supabaseUrl);
    if (
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      !anonKey.trim()
    )
      throw new Error('Invalid login endpoint');
    origin = url.origin;
    browserDigest = createHash('sha256').update(browserSessionSchema.parse(config.browserSession)).digest();
  } catch {
    throw new Error('INVALID_LOGIN_CONFIGURATION');
  }
  let verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  const challenge = Buffer.from(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
  ).toString('base64url');
  const expiresAt = Date.now() + 5 * 60_000;
  const state = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  const stateDigest = createHash('sha256').update(state).digest();
  let used = false;
  return {
    state,
    codeChallenge: challenge,
    codeChallengeMethod: 's256' as const,
    expiresAt,
    async exchange(
      code: string,
      callback: { browserSession: string; state: string },
    ): Promise<{ userId: string; sessionId: string; credentials: DownstreamCredentials }> {
      // The host obtains browserSession from its protected session, never from
      // callback query/body. Invalid proofs cannot consume another browser's flow.
      try {
        const proof = callbackSchema.parse(callback);
        if (
          !timingSafeEqual(browserDigest, createHash('sha256').update(proof.browserSession).digest()) ||
          !timingSafeEqual(stateDigest, createHash('sha256').update(proof.state).digest())
        )
          throw new Error('Mismatched login transaction');
      } catch {
        throw new Error('LOGIN_CALLBACK_REJECTED');
      }
      // Claim before the first await; even a timeout or invalid code consumes the
      // local attempt. No retry after the provider may have issued a session.
      if (used) throw new Error('LOGIN_EXCHANGE_UNCONFIRMED');
      used = true;
      const secret = verifier;
      verifier = '';
      try {
        if (Date.now() >= expiresAt) throw new Error('Expired login attempt');
        token.parse(code);
        const response = await request(`${origin}/auth/v1/token?grant_type=pkce`, {
          method: 'POST',
          headers: { apikey: anonKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ auth_code: code, code_verifier: secret }),
          redirect: 'error',
          cache: 'no-store',
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error('Login exchange failed');
        const result = responseSchema.parse(await response.json());
        const backend = new AdminBackend(
          {
            url: origin,
            anonKey,
            accessToken: result.access_token,
            expectedUserId: result.user.id,
          },
          request,
        );
        const identity = z
          .strictObject({ user_id: z.uuid(), session_id: z.uuid() })
          .parse(await backend.rpc('get_mcp_downstream_session', {}, false));
        if (
          identity.user_id !== result.user.id ||
          Date.now() >= expiresAt ||
          result.expires_at <= Math.floor(Date.now() / 1000)
        )
          throw new Error('Invalid login identity');
        return {
          userId: identity.user_id,
          sessionId: identity.session_id,
          credentials: {
            accessToken: result.access_token,
            refreshToken: result.refresh_token,
            expiresAt: result.expires_at,
          },
        };
      } catch {
        // The code may be consumed and a session may exist. Start a new login;
        // do not replay the old code or reveal a partial credential response.
        throw new Error('LOGIN_EXCHANGE_UNCONFIRMED');
      }
    },
  };
}
