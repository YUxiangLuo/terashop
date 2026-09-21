import { expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { createHash, generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import Provider, { errors } from 'oidc-provider';

// Compatibility experiment, NOT an authentication service. The loopback-only
// interaction automatically approves a synthetic identity; never reuse it as login.
test('oidc-provider on Bun: resource, PKCE, scope, rotation and grant revocation', async () => {
  const resource = 'https://tera.example/mcp';
  const callback = 'http://127.0.0.1:49199/callback';
  const clientId = 'tera-compatibility';
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const key = { ...privateKey.export({ format: 'jwk' }), kid: 'disposable', alg: 'ES256', use: 'sig' };
  let provider: Provider;
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/interaction/')) {
      void (async () => {
        const interaction = await provider.interactionDetails(req, res);
        if (interaction.prompt.name === 'login') {
          await provider.interactionFinished(
            req,
            res,
            { login: { accountId: 'fixture-admin-a' } },
            { mergeWithLastSubmission: false },
          );
          return;
        }
        if (interaction.prompt.name !== 'consent') throw new Error('Unexpected fixture prompt');
        const grant = new provider.Grant({
          accountId: 'fixture-admin-a',
          clientId: interaction.params.client_id as string,
        });
        grant.addOIDCScope('openid offline_access');
        grant.addResourceScope(resource, 'store:read');
        await provider.interactionFinished(
          req,
          res,
          {
            consent: { grantId: await grant.save() },
          },
          { mergeWithLastSubmission: true },
        );
      })().catch(() => {
        res.statusCode = 500;
        res.end('Fixture interaction failed');
      });
    } else {
      void provider.callback()(req, res);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing loopback address');
  const issuer = `http://127.0.0.1:${address.port}`;
  try {
    provider = new Provider(issuer, {
      jwks: { keys: [key] },
      cookies: { keys: [randomBytes(32).toString('hex')] },
      renderError: (ctx, output) => {
        ctx.body = output;
      },
      clients: [
        {
          client_id: clientId,
          token_endpoint_auth_method: 'none',
          id_token_signed_response_alg: 'ES256',
          redirect_uris: [callback],
          response_types: ['code'],
          grant_types: ['authorization_code', 'refresh_token'],
        },
      ],
      scopes: ['openid', 'offline_access'],
      features: {
        devInteractions: { enabled: false },
        revocation: { enabled: true },
        resourceIndicators: {
          enabled: true,
          getResourceServerInfo(_ctx, target) {
            if (target !== resource) throw new errors.InvalidTarget();
            return {
              scope: 'store:read store:write',
              audience: resource,
              accessTokenTTL: 60,
              accessTokenFormat: 'jwt',
              jwt: { sign: { alg: 'ES256' } },
            };
          },
        },
      },
      pkce: { required: () => true },
      rotateRefreshToken: true,
      revokeGrantPolicy: () => true,
      issueRefreshToken: (_ctx, client, token) =>
        client.grantTypeAllowed('refresh_token') && token.scopes.has('offline_access'),
      extraTokenClaims: (_ctx, token) => ('grantId' in token ? { grant_id: token.grantId } : {}),
      findAccount: async (_ctx, id) => ({ accountId: id, claims: async () => ({ sub: id }) }),
    });
    const metadata = await (await fetch(`${issuer}/.well-known/openid-configuration`)).json();
    expect(metadata.issuer).toBe(issuer);
    expect(metadata.code_challenge_methods_supported).toEqual(['S256']);
    expect(metadata.revocation_endpoint).toBe(`${issuer}/token/revocation`);
    const jwks = await (await fetch(metadata.jwks_uri)).json();
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ ...publicKey.export({ format: 'jwk' }), kid: 'disposable' });
    expect(jwks.keys[0]).not.toHaveProperty('d');

    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    async function authorize(overrides: Record<string, string> = {}) {
      const params = new URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        redirect_uri: callback,
        scope: 'openid offline_access store:read',
        resource,
        state: 'fixture-state',
        prompt: 'consent',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        ...overrides,
      });
      for (const [name, value] of Object.entries(overrides)) if (value === '') params.delete(name);
      const cookies = new Map<string, string>();
      let url = `${metadata.authorization_endpoint}?${params}`;
      for (let i = 0; i < 10; i++) {
        // Do not send fixture cookies to a callback or arbitrary redirect host.
        if (url.startsWith(`${callback}?`)) return new URL(url).searchParams;
        if (new URL(url).origin !== issuer) throw new Error('Unexpected fixture redirect');
        const response = await fetch(url, {
          redirect: 'manual',
          headers: { cookie: [...cookies.values()].join('; ') },
        });
        for (const cookie of response.headers.getSetCookie()) {
          const value = cookie.split(';')[0];
          cookies.set(value.split('=')[0], value);
        }
        const body = await response.text();
        const location = response.headers.get('location');
        if (!location) {
          expect(response.status).toBe(400);
          return new URLSearchParams(JSON.parse(body));
        }
        url = new URL(location, issuer).href;
      }
      throw new Error('Too many fixture redirects');
    }
    async function token(params: Record<string, string>) {
      const response = await fetch(metadata.token_endpoint, {
        method: 'POST',
        body: new URLSearchParams({ client_id: clientId, resource, ...params }),
      });
      return { status: response.status, data: await response.json() };
    }
    async function issue() {
      const result = await authorize({ grant_id: 'forged-client-grant' });
      expect(result.get('state')).toBe('fixture-state');
      expect(result.has('error')).toBe(false);
      const code = result.get('code');
      expect(code).toBeString();
      const response = await token({
        grant_type: 'authorization_code',
        code: code!,
        redirect_uri: callback,
        code_verifier: verifier,
      });
      expect(response.status).toBe(200);
      expect(response.data.refresh_token).toBeString();
      return response.data;
    }
    function claims(jwt: string) {
      const [header, payload, signature] = jwt.split('.');
      expect(JSON.parse(Buffer.from(header, 'base64url').toString()).alg).toBe('ES256');
      expect(
        verify(
          'sha256',
          Buffer.from(`${header}.${payload}`),
          { key: publicKey, dsaEncoding: 'ieee-p1363' },
          Buffer.from(signature, 'base64url'),
        ),
      ).toBe(true);
      const result = JSON.parse(Buffer.from(payload, 'base64url').toString());
      expect(result).toMatchObject({
        iss: issuer,
        aud: resource,
        sub: 'fixture-admin-a',
        client_id: clientId,
        scope: 'store:read',
      });
      expect(result.exp - result.iat).toBe(60);
      expect(result.grant_id).toBeString();
      expect(result.grant_id).not.toBe('forged-client-grant');
      return result;
    }
    expect((await authorize({ resource: 'https://other.example/mcp' })).get('error')).toBe('invalid_target');
    expect((await authorize({ code_challenge: '', code_challenge_method: '' })).get('error')).toBe(
      'invalid_request',
    );
    expect((await authorize({ code_challenge_method: 'plain' })).get('error')).toBe('invalid_request');
    const badRedirect = await authorize({ redirect_uri: `${callback}/unregistered` });
    expect(badRedirect.has('error')).toBe(true);
    expect(badRedirect.has('code')).toBe(false);
    const badCode = (await authorize()).get('code')!;
    expect(
      (
        await token({
          grant_type: 'authorization_code',
          code: badCode,
          redirect_uri: callback,
          code_verifier: randomBytes(32).toString('base64url'),
        })
      ).data.error,
    ).toBe('invalid_grant');

    const wrongTarget = await issue();
    const wrongTargetClaims = claims(wrongTarget.access_token);
    expect(
      (
        await token({
          grant_type: 'refresh_token',
          refresh_token: wrongTarget.refresh_token,
          resource: 'https://other.example/mcp',
        })
      ).data.error,
    ).toBe('invalid_target');
    // This version consumes a rotating refresh token before target rejection.
    // Retrying it is reuse and revokes the grant, not harmless error recovery.
    expect(
      (await token({ grant_type: 'refresh_token', refresh_token: wrongTarget.refresh_token })).data.error,
    ).toBe('invalid_grant');
    expect(await provider.Grant.find(wrongTargetClaims.grant_id)).toBeUndefined();

    const first = await issue();
    const firstClaims = claims(first.access_token);
    expect(
      (await token({ grant_type: 'refresh_token', refresh_token: first.refresh_token, scope: 'store:write' }))
        .data.error,
    ).toBe('invalid_scope');
    const rotated = await token({ grant_type: 'refresh_token', refresh_token: first.refresh_token });
    expect(rotated.status).toBe(200);
    expect(rotated.data.refresh_token).not.toBe(first.refresh_token);
    expect(claims(rotated.data.access_token).grant_id).toBe(firstClaims.grant_id);
    expect(
      (await token({ grant_type: 'refresh_token', refresh_token: first.refresh_token })).data.error,
    ).toBe('invalid_grant');
    expect(
      (await token({ grant_type: 'refresh_token', refresh_token: rotated.data.refresh_token })).data.error,
    ).toBe('invalid_grant');
    expect(await provider.Grant.find(firstClaims.grant_id)).toBeUndefined();

    const second = await issue();
    const secondClaims = claims(second.access_token);
    expect(secondClaims.grant_id).not.toBe(firstClaims.grant_id);
    const revoked = await fetch(metadata.revocation_endpoint, {
      method: 'POST',
      body: new URLSearchParams({
        client_id: clientId,
        token: second.refresh_token,
        token_type_hint: 'refresh_token',
      }),
    });
    expect(revoked.status).toBe(200);
    await revoked.text();
    expect(await provider.Grant.find(secondClaims.grant_id)).toBeUndefined();
    expect(
      (await token({ grant_type: 'refresh_token', refresh_token: second.refresh_token })).data.error,
    ).toBe('invalid_grant');
    // A signed JWT remains cryptographically valid: resource servers must check
    // the online grant, not claim that RFC7009 rewrites an already issued JWT.
    claims(second.access_token);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 15_000);
