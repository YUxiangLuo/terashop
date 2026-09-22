import { expect, test } from 'bun:test';
import { createDownstreamLogin } from '../mcp/src/login';
import { createLoginHttpHandler } from '../mcp/src/login-http';
import { API, ANON_KEY, SERVICE_KEY, api, checked, signup, makeAdmin, rpc } from './helpers';
import { authMail, authMessages } from './support/mail';
import Provider from 'oidc-provider';
import { generateKeyPairSync } from 'node:crypto';
import { createOidcApproval } from '../mcp/src/oidc-approval';
import { createCredentialCipher } from '../mcp/src/credentials';
import { testDatabase } from './database-concurrency';

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

test.each(['none', 'create', 'write'] as const)(
  'email login hands off once and persists initial approval (lost receipt=%s)',
  async (loseReceipt) => {
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
    const project = `approval-${crypto.randomUUID()}`;
    const db = testDatabase();
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const provider = new Provider('https://authorization.example', {
      features: { devInteractions: { enabled: false } },
      jwks: { keys: [{ ...privateKey.export({ format: 'jwk' }), kid: 'test', alg: 'ES256', use: 'sig' }] },
      clients: [
        {
          client_id: 'agent',
          token_endpoint_auth_method: 'none',
          id_token_signed_response_alg: 'ES256',
          redirect_uris: ['https://client.example/cb'],
        },
      ],
    });
    const cipher = await createCredentialCipher(
      new Map([['test', crypto.getRandomValues(new Uint8Array(32))]]),
      'test',
    );
    let writes = 0;
    const approval = createOidcApproval(
      provider,
      {
        resource: 'https://shop.example/mcp',
        project,
        clientId: 'agent',
        scopes: ['store:read'],
        supabaseUrl: API,
        anonKey: ANON_KEY,
        serviceRoleKey: SERVICE_KEY,
      },
      cipher,
      async (url, init) => {
        const response = await fetch(url, init);
        if (
          loseReceipt === 'create' &&
          url.endsWith('/mcp_grant_command') &&
          JSON.parse(init.body as string).p_action === 'create' &&
          response.ok
        ) {
          await response.body?.cancel();
          throw new Error('Lost committed grant response');
        }
        if (url.endsWith('/mcp_credential_command')) {
          writes++;
          if (loseReceipt === 'write' && response.ok) {
            await response.body?.cancel();
            throw new Error('Lost committed credential response');
          }
        }
        return response;
      },
    );
    try {
      if (loseReceipt !== 'none') {
        await expect(approval.approve(result)).rejects.toThrow(/^APPROVAL_UNCONFIRMED$/);
        const [grant] =
          await db`select id,binding,state from private.mcp_grants where binding->>'project'=${project}`;
        expect(grant.state).toBe('revoked');
        expect(await provider.Grant.find(grant.binding.session_id)).toBeUndefined();
        expect(await db`select 1 from private.mcp_credentials where grant_id=${grant.id}`).toHaveLength(0);
      } else {
        const approved = await approval.approve(result);
        const [grant] =
          await db`select binding,user_id,downstream_session_id from private.mcp_grants where id=${approved.grantId}::uuid`;
        expect(grant.user_id).toBe(result.userId);
        expect(grant.downstream_session_id).toBe(result.sessionId);
        expect(grant.binding.session_id).toBe(approved.providerGrantId);
        const stored = await checked<{ revision: number; envelope: unknown }>(
          rpc(
            'mcp_credential_command',
            {
              p_action: 'read',
              p_binding: grant.binding,
              p_grant_id: approved.grantId,
              p_user_id: result.userId,
            },
            undefined,
            true,
          ),
        );
        expect(stored.revision).toBe(1);
        expect(
          await cipher.open(
            { project, grantId: approved.grantId, userId: result.userId, revision: 1 },
            stored.envelope,
          ),
        ).toEqual(result.credentials);
        await provider.Grant.find(approved.providerGrantId).then((g) => g?.destroy());
      }
      expect(writes).toBe(loseReceipt === 'create' ? 0 : 1);
      await expect(approval.approve(result)).rejects.toThrow('APPROVAL_ALREADY_ATTEMPTED');
    } finally {
      try {
        await db`delete from private.mcp_grants where binding->>'project'=${project}`;
      } finally {
        await db.close();
      }
      await checked(
        api('/auth/v1/logout?scope=local', { method: 'POST', token: result.credentials.accessToken }),
      );
    }
  },
);
