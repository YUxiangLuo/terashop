import { expect, test } from 'bun:test';
import { createDownstreamLogin } from '../mcp/src/login';
import { createLoginHttpHandler } from '../mcp/src/login-http';
import { API, ANON_KEY, api, checked, signup, makeAdmin, rpc } from './helpers';
import { authMail, authMessages } from './support/mail';

test('real email S256 flow returns a new administrator session only to its original host attempt', async () => {
  const user = await signup();
  await makeAdmin(user.userId);
  const original = await checked<{ session_id: string }>(rpc('get_mcp_downstream_session', {}, user.token));
  const previous = (await authMessages(user.email)).map((m) => m.ID);
  const browserSession = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  const config = {
    supabaseUrl: API,
    anonKey: ANON_KEY,
    browserSession,
    callbackUrl: 'http://127.0.0.1:3000/',
  };
  const attempt = await createDownstreamLogin(config);
  const redirectTo = attempt.redirectTo;
  await checked(
    api(`/auth/v1/otp?redirect_to=${encodeURIComponent(redirectTo)}`, {
      method: 'POST',
      body: {
        email: user.email,
        create_user: false,
        code_challenge: attempt.codeChallenge,
        code_challenge_method: attempt.codeChallengeMethod,
      },
    }),
  );
  const link = await authMail(user.email, 'magiclink', previous);
  const verified = await fetch(link, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  expect(verified.status).toBe(303);
  const callback = new URL(verified.headers.get('location')!);
  expect(callback.origin).toBe('http://127.0.0.1:3000');
  expect(callback.hash).toBe('');
  expect(callback.searchParams.get('state')).toBe(attempt.state);
  const code = callback.searchParams.get('code');
  expect(code).toBeTruthy();
  const wrongAttempt = await createDownstreamLogin(config);
  await expect(attempt.exchange(callback.href, 'x'.repeat(43))).rejects.toThrow(/^LOGIN_CALLBACK_REJECTED$/);
  await expect(wrongAttempt.exchange(callback.href, browserSession)).rejects.toThrow(
    /^LOGIN_CALLBACK_REJECTED$/,
  );
  const wrongCallback = new URL(callback);
  wrongCallback.searchParams.set('state', wrongAttempt.state);
  await expect(wrongAttempt.exchange(wrongCallback.href, browserSession)).rejects.toThrow(
    /^LOGIN_EXCHANGE_UNCONFIRMED$/,
  );
  const result = await attempt.exchange(callback.href, browserSession);
  expect(result.userId).toBe(user.userId);
  expect(result.sessionId).not.toBe(original.session_id);
  expect((await rpc('get_mcp_downstream_session', {}, result.credentials.accessToken)).data).toEqual({
    user_id: user.userId,
    session_id: result.sessionId,
  });
  expect(result.credentials.refreshToken.length).toBeGreaterThan(0);
  await expect(attempt.exchange(callback.href, browserSession)).rejects.toThrow(
    /^LOGIN_EXCHANGE_UNCONFIRMED$/,
  );
  await checked(
    api('/auth/v1/logout?scope=local', { method: 'POST', token: result.credentials.accessToken }),
  );
});

test('HTTP handler sends real login email and retains credentials only for a single internal handoff', async () => {
  const user = await signup();
  await makeAdmin(user.userId);
  const previous = (await authMessages(user.email)).map((m) => m.ID);
  // Exact HTTPS redirect already allowlisted by the disposable local Auth config.
  const origin = 'https://127.0.0.1:3000';
  const host = createLoginHttpHandler({
    publicOrigin: origin,
    callbackUrl: `${origin}/`,
    supabaseUrl: API,
    anonKey: ANON_KEY,
  });
  const issued = await host.handle(
    new Request(`${origin}/login/session`, {
      method: 'POST',
      headers: { origin, 'x-tera-login': 'start' },
    }),
  );
  expect(issued.status).toBe(201);
  const cookie = issued.headers.get('set-cookie')!.split(';')[0];
  const { csrfToken } = (await issued.json()) as { csrfToken: string };
  const post = (path: string, body?: string) =>
    new Request(`${origin}${path}`, {
      method: 'POST',
      headers: { cookie, origin, 'x-csrf-token': csrfToken, 'content-type': 'application/json' },
      body,
    });
  expect((await host.handle(post('/login/email', JSON.stringify({ email: user.email })))).status).toBe(202);
  const link = await authMail(user.email, 'magiclink', previous);
  const verified = await fetch(link, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  expect(verified.status).toBe(303);
  const callback = new URL(verified.headers.get('location')!);
  expect(callback.origin).toBe(origin);
  const completed = await host.handle(new Request(callback, { headers: { cookie } }));
  expect(completed.status).toBe(303);
  expect(completed.headers.get('location')).toBe(`${origin}/login/status`);
  expect(await completed.json()).toEqual({ status: 'callback_processed' });
  const result = host.takeIdentity(post('/login/approve'));
  expect(result.userId).toBe(user.userId);
  expect((await rpc('get_mcp_downstream_session', {}, result.credentials.accessToken)).data).toEqual({
    user_id: user.userId,
    session_id: result.sessionId,
  });
  expect(() => host.takeIdentity(post('/login/approve'))).toThrow();
  await checked(
    api('/auth/v1/logout?scope=local', { method: 'POST', token: result.credentials.accessToken }),
  );
});
