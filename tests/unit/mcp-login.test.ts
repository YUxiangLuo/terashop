import { expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createDownstreamLogin } from '../../mcp/src/login';

const config = { supabaseUrl: 'https://auth.example', anonKey: 'public-key', browserSession: 'a'.repeat(43) };
async function fixture() {
  const userId = crypto.randomUUID(),
    sessionId = crypto.randomUUID();
  const result = {
    access_token: 'access-secret',
    refresh_token: 'refresh-secret',
    token_type: 'bearer',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: userId, is_anonymous: false },
  };
  const calls: { url: string; init: RequestInit }[] = [];
  const state = {
    result: result as unknown,
    actualUser: userId,
    admin: true,
    lost: false,
    onIdentity: () => {},
  };
  const request = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith('?grant_type=pkce')) {
      if (state.lost) throw new Error('sensitive provider failure');
      return Response.json(state.result);
    }
    if (url.endsWith('/user'))
      return Response.json({ id: state.actualUser, is_anonymous: false, role: 'authenticated' });
    if (url.endsWith('/is_admin')) return Response.json(state.admin);
    if (url.endsWith('/get_mcp_downstream_session')) {
      state.onIdentity();
      return Response.json({ user_id: userId, session_id: sessionId });
    }
    throw new Error('Unexpected endpoint');
  };
  const rawAttempt = await createDownstreamLogin(config, request);
  const proof = { browserSession: config.browserSession, state: rawAttempt.state };
  const attempt = { ...rawAttempt, exchange: (code: string) => rawAttempt.exchange(code, proof) };
  return { attempt, rawAttempt, proof, calls, state, result, userId, sessionId };
}

test('PKCE verifier stays private and the host accepts only the fixed endpoint pair', async () => {
  const f = await fixture();
  expect(Object.keys(f.attempt).sort()).toEqual([
    'codeChallenge',
    'codeChallengeMethod',
    'exchange',
    'expiresAt',
    'state',
  ]);
  expect(f.attempt.codeChallengeMethod).toBe('s256');
  expect(await f.attempt.exchange('auth-code')).toEqual({
    userId: f.userId,
    sessionId: f.sessionId,
    credentials: {
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      expiresAt: f.result.expires_at,
    },
  });
  const first = f.calls[0];
  expect(first.url).toBe('https://auth.example/auth/v1/token?grant_type=pkce');
  const body = JSON.parse(first.init.body as string);
  expect(body.auth_code).toBe('auth-code');
  expect(body.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(createHash('sha256').update(body.code_verifier).digest('base64url')).toBe(f.attempt.codeChallenge);
  expect(first.init.redirect).toBe('error');
  expect(first.init.cache).toBe('no-store');
  expect(first.init.signal).toBeInstanceOf(AbortSignal);
  expect(new Headers(first.init.headers).get('Authorization')).toBeNull();
  expect(
    f.calls
      .slice(1)
      .every((c) => new Headers(c.init.headers).get('Authorization') === 'Bearer access-secret'),
  ).toBe(true);
});

test('concurrent and uncertain exchanges never replay a provider request', async () => {
  for (const lost of [false, true]) {
    const f = await fixture();
    f.state.lost = lost;
    const results = await Promise.allSettled([f.attempt.exchange('first'), f.attempt.exchange('second')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(lost ? 0 : 1);
    expect(f.calls.filter((c) => c.url.endsWith('?grant_type=pkce'))).toHaveLength(1);
    await expect(f.attempt.exchange('retry')).rejects.toThrow(/^LOGIN_EXCHANGE_UNCONFIRMED$/);
  }
});

test('browser and state are independently required before consuming or contacting Auth', async () => {
  const a = await fixture(),
    b = await fixture();
  expect(a.proof.state).not.toBe(b.proof.state);
  expect(a.proof.state).not.toBe(a.attempt.codeChallenge);
  for (const proof of [
    undefined,
    {},
    { ...a.proof, browserSession: 'b'.repeat(43) },
    { ...a.proof, state: b.proof.state },
    { ...a.proof, state: [a.proof.state, a.proof.state] },
    { ...a.proof, browserSession: '' },
  ]) {
    await expect(a.rawAttempt.exchange('code', proof as typeof a.proof)).rejects.toThrow(
      /^LOGIN_CALLBACK_REJECTED$/,
    );
    expect(a.calls).toHaveLength(0);
  }
  expect((await a.rawAttempt.exchange('code', a.proof)).userId).toBe(a.userId);
  await expect(a.rawAttempt.exchange('code', a.proof)).rejects.toThrow(/^LOGIN_EXCHANGE_UNCONFIRMED$/);
  expect(b.calls).toHaveLength(0);
});

test('malformed pairs, expired credentials, anonymous users and wrong admins disclose no result', async () => {
  for (const fault of ['missing', 'expired', 'anonymous', 'identity', 'role']) {
    const f = await fixture();
    if (fault === 'missing') f.state.result = { ...f.result, refresh_token: undefined };
    if (fault === 'expired') f.state.result = { ...f.result, expires_at: 1 };
    if (fault === 'anonymous')
      f.state.result = { ...f.result, user: { ...f.result.user, is_anonymous: true } };
    if (fault === 'identity') f.state.actualUser = crypto.randomUUID();
    if (fault === 'role') f.state.admin = false;
    await expect(f.attempt.exchange('code')).rejects.toThrow(/^LOGIN_EXCHANGE_UNCONFIRMED$/);
    await expect(f.attempt.exchange('code')).rejects.toThrow(/^LOGIN_EXCHANGE_UNCONFIRMED$/);
    expect(f.calls.filter((c) => c.url.endsWith('?grant_type=pkce'))).toHaveLength(1);
  }
});

test('attempt expiry is enforced at the boundary and again after requests', async () => {
  const clock = spyOn(Date, 'now').mockReturnValue(2_000_000_000_000);
  try {
    const expired = await fixture();
    clock.mockReturnValue(expired.attempt.expiresAt);
    await expect(expired.attempt.exchange('code')).rejects.toThrow(/^LOGIN_EXCHANGE_UNCONFIRMED$/);
    expect(expired.calls).toHaveLength(0);
    const started = await fixture();
    clock.mockReturnValue(started.attempt.expiresAt - 1);
    expect((await started.attempt.exchange('code')).userId).toBe(started.userId);
    const delayed = await fixture();
    delayed.state.onIdentity = () => {
      clock.mockReturnValue(delayed.attempt.expiresAt);
    };
    await expect(delayed.attempt.exchange('code')).rejects.toThrow(/^LOGIN_EXCHANGE_UNCONFIRMED$/);
  } finally {
    clock.mockRestore();
  }
});

test('untrusted endpoint configuration is rejected before requests', async () => {
  for (const url of [
    'http://remote.example',
    'https://user:pass@auth.example',
    'https://auth.example/path',
    'https://auth.example?x=1',
  ])
    await expect(createDownstreamLogin({ ...config, supabaseUrl: url })).rejects.toThrow(
      /^INVALID_LOGIN_CONFIGURATION$/,
    );
});
