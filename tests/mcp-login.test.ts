import { expect, test } from 'bun:test';
import { createDownstreamLogin } from '../mcp/src/login';
import { API, ANON_KEY, api, checked, signup, makeAdmin, rpc } from './helpers';
import { authMail, authMessages } from './support/mail';

test('real email S256 flow returns a new administrator session only to its original host attempt', async () => {
  const user = await signup();
  await makeAdmin(user.userId);
  const original = await checked<{ session_id: string }>(rpc('get_mcp_downstream_session', {}, user.token));
  const previous = (await authMessages(user.email)).map((m) => m.ID);
  const attempt = await createDownstreamLogin({ supabaseUrl: API, anonKey: ANON_KEY });
  await checked(
    api('/auth/v1/otp', {
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
  const code = callback.searchParams.get('code');
  expect(code).toBeTruthy();
  const wrongAttempt = await createDownstreamLogin({ supabaseUrl: API, anonKey: ANON_KEY });
  await expect(wrongAttempt.exchange(code!)).rejects.toThrow(/^LOGIN_EXCHANGE_UNCONFIRMED$/);
  const result = await attempt.exchange(code!);
  expect(result.userId).toBe(user.userId);
  expect(result.sessionId).not.toBe(original.session_id);
  expect((await rpc('get_mcp_downstream_session', {}, result.credentials.accessToken)).data).toEqual({
    user_id: user.userId,
    session_id: result.sessionId,
  });
  expect(result.credentials.refreshToken.length).toBeGreaterThan(0);
  await expect(attempt.exchange(code!)).rejects.toThrow(/^LOGIN_EXCHANGE_UNCONFIRMED$/);
  await checked(
    api('/auth/v1/logout?scope=local', { method: 'POST', token: result.credentials.accessToken }),
  );
});
