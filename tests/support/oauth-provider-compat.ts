import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import Provider, { errors, type AdapterConstructor } from 'oidc-provider';
import { GrantAuthorizer } from '../../mcp/src/authorization';

// Compatibility experiment, NOT an authentication service. The loopback-only
// interaction automatically approves a synthetic identity; never reuse it as login.
export async function verifyOAuthProvider(
  accessTokenFormat: 'jwt' | 'opaque' = 'jwt',
  adapter?: AdapterConstructor,
) {
  const resource = 'https://tera.example/mcp';
  const callback = 'http://127.0.0.1:49199/callback';
  const clientId = 'tera-compatibility';
  const subject = crypto.randomUUID();
  const introspectionClient = 'tera-resource';
  const introspectionSecret = randomBytes(32).toString('base64url');
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
            { login: { accountId: subject } },
            { mergeWithLastSubmission: false },
          );
          return;
        }
        if (interaction.prompt.name !== 'consent') throw new Error('Unexpected fixture prompt');
        const grant = new provider.Grant({
          accountId: subject,
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
      adapter,
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
        {
          client_id: introspectionClient,
          client_secret: introspectionSecret,
          token_endpoint_auth_method: 'client_secret_post',
          id_token_signed_response_alg: 'ES256',
          response_types: [],
          grant_types: [],
          redirect_uris: [],
        },
      ],
      scopes: ['openid', 'offline_access'],
      features: {
        devInteractions: { enabled: false },
        revocation: { enabled: true },
        introspection: {
          enabled: true,
          allowedPolicy(_ctx, client, token) {
            return (
              client.clientId === introspectionClient &&
              token.kind === 'AccessToken' &&
              (token.aud === resource ||
                (Array.isArray(token.aud) && token.aud.length === 1 && token.aud[0] === resource))
            );
          },
        },
        resourceIndicators: {
          enabled: true,
          getResourceServerInfo(_ctx, target) {
            if (target !== resource) throw new errors.InvalidTarget();
            return {
              scope: 'store:read store:write',
              audience: resource,
              accessTokenTTL: 60,
              accessTokenFormat,
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
      extraTokenClaims: (_ctx, token) =>
        token.kind === 'AccessToken' ? { grant_id: token.grantId, token_kind: 'AccessToken' } : {},
      findAccount: async (_ctx, id) => ({ accountId: id, claims: async () => ({ sub: id }) }),
    });
    const metadata = await (await fetch(`${issuer}/.well-known/openid-configuration`)).json();
    assert.equal(metadata.issuer, issuer);
    assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
    assert.equal(metadata.revocation_endpoint, `${issuer}/token/revocation`);
    const jwks = await (await fetch(metadata.jwks_uri)).json();
    assert.equal(jwks.keys.length, 1);
    for (const [key, value] of Object.entries({ ...publicKey.export({ format: 'jwk' }), kid: 'disposable' }))
      assert.equal(jwks.keys[0][key], value);
    assert(!('d' in jwks.keys[0]));

    async function introspect(value: string, caller = introspectionClient, expectedStatus = 200) {
      const response = await fetch(metadata.introspection_endpoint, {
        method: 'POST',
        body: new URLSearchParams({
          token: value,
          token_type_hint: 'access_token',
          client_id: caller,
          ...(caller === introspectionClient ? { client_secret: introspectionSecret } : {}),
        }),
      });
      const result = await response.json();
      assert.equal(
        response.status,
        expectedStatus,
        JSON.stringify({ error: result.error, description: result.error_description }),
      );
      return result;
    }

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
          assert.equal(response.status, 400);
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
      assert.equal(result.get('state'), 'fixture-state');
      assert.equal(result.has('error'), false);
      const code = result.get('code');
      assert.equal(typeof code, 'string');
      const response = await token({
        grant_type: 'authorization_code',
        code: code!,
        redirect_uri: callback,
        code_verifier: verifier,
      });
      assert.equal(response.status, 200);
      assert.equal(typeof response.data.refresh_token, 'string');
      return response.data;
    }
    async function claims(value: string) {
      let result;
      if (accessTokenFormat === 'jwt') {
        const [header, payload, signature] = value.split('.');
        assert.equal(JSON.parse(Buffer.from(header, 'base64url').toString()).alg, 'ES256');
        assert(
          verify(
            'sha256',
            Buffer.from(`${header}.${payload}`),
            { key: publicKey, dsaEncoding: 'ieee-p1363' },
            Buffer.from(signature, 'base64url'),
          ),
        );
        result = JSON.parse(Buffer.from(payload, 'base64url').toString());
      } else {
        assert.equal(value.includes('.'), false);
        result = await introspect(value);
        assert.equal(result.active, true);
        assert.equal(result.token_type, 'Bearer');
      }
      for (const [key, expected] of Object.entries({
        iss: issuer,
        aud: resource,
        sub: subject,
        client_id: clientId,
        scope: 'store:read',
        token_kind: 'AccessToken',
      }))
        assert.equal(result[key], expected);
      assert.equal(result.exp - result.iat, 60);
      assert.equal(typeof result.grant_id, 'string');
      assert.notEqual(result.grant_id, 'forged-client-grant');
      return result;
    }
    assert.equal((await authorize({ resource: 'https://other.example/mcp' })).get('error'), 'invalid_target');
    assert.equal(
      (await authorize({ code_challenge: '', code_challenge_method: '' })).get('error'),
      'invalid_request',
    );
    assert.equal((await authorize({ code_challenge_method: 'plain' })).get('error'), 'invalid_request');
    const badRedirect = await authorize({ redirect_uri: `${callback}/unregistered` });
    assert.equal(badRedirect.has('error'), true);
    assert.equal(badRedirect.has('code'), false);
    const badCode = (await authorize()).get('code')!;
    assert.equal(
      (
        await token({
          grant_type: 'authorization_code',
          code: badCode,
          redirect_uri: callback,
          code_verifier: randomBytes(32).toString('base64url'),
        })
      ).data.error,
      'invalid_grant',
    );

    const wrongTarget = await issue();
    const wrongTargetClaims = await claims(wrongTarget.access_token);
    assert.equal(
      (
        await token({
          grant_type: 'refresh_token',
          refresh_token: wrongTarget.refresh_token,
          resource: 'https://other.example/mcp',
        })
      ).data.error,
      'invalid_target',
    );
    // This version consumes a rotating refresh token before target rejection.
    // Retrying it is reuse and revokes the grant, not harmless error recovery.
    assert.equal(
      (await token({ grant_type: 'refresh_token', refresh_token: wrongTarget.refresh_token })).data.error,
      'invalid_grant',
    );
    assert.equal(await provider.Grant.find(wrongTargetClaims.grant_id), undefined);

    const first = await issue();
    const firstClaims = await claims(first.access_token);
    // Real provider introspection plus a synthetic local approval store: this
    // tests the resource-server profile, not account linking or persistence.
    const approvals = new Map<string, string>();
    const authorizer = new GrantAuthorizer(
      {
        tokenProfile: 'oidc-provider',
        issuer,
        introspectionEndpoint: metadata.introspection_endpoint,
        introspectionClientId: introspectionClient,
        introspectionClientSecret: introspectionSecret,
        resource,
        project: 'compat-project',
        supabaseUrl: 'https://db.example',
        serviceRoleKey: 'fixture-only',
        scopes: ['store:read', 'store:write'],
      },
      async (url, init) => {
        if (url === metadata.introspection_endpoint) return fetch(url, init);
        assert.equal(url, 'https://db.example/rest/v1/rpc/mcp_grant_command');
        const { p_binding: binding, p_action: action } = JSON.parse(init.body as string);
        assert.equal(action, 'resolve');
        assert.deepEqual(
          { ...binding, session_id: undefined },
          {
            issuer,
            subject,
            client_id: clientId,
            resource,
            project: 'compat-project',
            session_id: undefined,
          },
        );
        const id = approvals.get(binding.session_id);
        return id
          ? Response.json({ id, user_id: subject, scopes: ['store:read'], state: 'active', version: 1 })
          : new Response(null, { status: 403 });
      },
    );
    let authorization: Awaited<ReturnType<GrantAuthorizer['authorize']>> | undefined;
    if (accessTokenFormat === 'opaque') {
      await assert.rejects(authorizer.authorize(first.access_token), /^Error: AUTHORIZATION_DENIED$/);
      approvals.set(firstClaims.grant_id, crypto.randomUUID());
      authorization = await authorizer.authorize(first.access_token);
      assert.equal(authorization.expectedUserId, subject);
      assert.deepEqual(authorization.authorization.scopes, ['store:read']);
      await assert.rejects(authorizer.authorize(first.refresh_token), /^Error: AUTHORIZATION_DENIED$/);
    }
    assert.deepEqual(await introspect(first.refresh_token), { active: false });
    if (accessTokenFormat === 'opaque')
      assert.deepEqual(await introspect(first.access_token, clientId), { active: false });
    else
      assert.equal(
        (await introspect(first.access_token, introspectionClient, 400)).error,
        'unsupported_token_type',
      );
    assert.equal(
      (await token({ grant_type: 'refresh_token', refresh_token: first.refresh_token, scope: 'store:write' }))
        .data.error,
      'invalid_scope',
    );
    const rotated = await token({ grant_type: 'refresh_token', refresh_token: first.refresh_token });
    assert.equal(rotated.status, 200);
    assert.notEqual(rotated.data.refresh_token, first.refresh_token);
    assert.equal((await claims(rotated.data.access_token)).grant_id, firstClaims.grant_id);
    if (authorization) {
      const rotatedAuthorization = await authorizer.authorize(rotated.data.access_token);
      assert.equal(rotatedAuthorization.grantId, authorization.grantId);
    }
    assert.equal(
      (await token({ grant_type: 'refresh_token', refresh_token: first.refresh_token })).data.error,
      'invalid_grant',
    );
    assert.equal(
      (await token({ grant_type: 'refresh_token', refresh_token: rotated.data.refresh_token })).data.error,
      'invalid_grant',
    );
    assert.equal(await provider.Grant.find(firstClaims.grant_id), undefined);
    if (accessTokenFormat === 'opaque')
      assert.deepEqual(await introspect(rotated.data.access_token), { active: false });
    if (authorization)
      await assert.rejects(authorization.authorization.currentScopes(), /^Error: AUTHORIZATION_DENIED$/);

    const second = await issue();
    const secondClaims = await claims(second.access_token);
    assert.notEqual(secondClaims.grant_id, firstClaims.grant_id);
    if (accessTokenFormat === 'opaque')
      await assert.rejects(authorizer.authorize(second.access_token), /^Error: AUTHORIZATION_DENIED$/);
    const revoked = await fetch(metadata.revocation_endpoint, {
      method: 'POST',
      body: new URLSearchParams({
        client_id: clientId,
        token: second.refresh_token,
        token_type_hint: 'refresh_token',
      }),
    });
    assert.equal(revoked.status, 200);
    await revoked.text();
    assert.equal(await provider.Grant.find(secondClaims.grant_id), undefined);
    assert.equal(
      (await token({ grant_type: 'refresh_token', refresh_token: second.refresh_token })).data.error,
      'invalid_grant',
    );
    // A signed JWT remains cryptographically valid: resource servers must check
    // the online grant, not claim that RFC7009 rewrites an already issued JWT.
    if (accessTokenFormat === 'jwt') await claims(second.access_token);
    else assert.deepEqual(await introspect(second.access_token), { active: false });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
