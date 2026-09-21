// Disposable protocol experiment. Never use this realm, passwords, start-dev,
// HTTP, or consent-free clients as production configuration.
import assert from 'node:assert/strict';
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeycloakGrantAuthorizer } from '../mcp/src/authorization';
import { localSupabase } from './lib/local-supabase';

// Opt-in only. Resolve this checkout's loopback credentials before creating fixtures.
const local = Bun.argv.includes('--with-supabase') ? localSupabase() : undefined;

const image =
  'quay.io/keycloak/keycloak:26.7.0@sha256:0f198be292568439d700cdbfb893e69a6009bb43a94a06a945b1d3d506c76b13';
const name = `tera-auth-compat-${crypto.randomUUID()}`;
const directory = await mkdtemp(join(tmpdir(), 'tera-auth-compat-'));
const resource = 'https://tera.example/mcp';
const callback = 'http://127.0.0.1:49199/callback';
const client = 'tera-compat';
const secondClient = 'tera-compat-b';
type FixtureBrowser = { username: string; cookies: Map<string, string> };
const password = randomBytes(24).toString('base64url');
const secret = randomBytes(24).toString('base64url');

function docker(...args: string[]) {
  const result = Bun.spawnSync(['docker', ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`Docker ${args[0]} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

try {
  await chmod(directory, 0o755); // The non-root container reads only disposable fixture credentials.
  await Bun.write(
    join(directory, 'realm.json'),
    JSON.stringify({
      realm: 'tera-compat',
      enabled: true,
      sslRequired: 'none',
      revokeRefreshToken: true,
      refreshTokenMaxReuse: 0,
      clientScopes: ['store:read', 'store:write'].map((scope) => ({
        name: scope,
        protocol: 'openid-connect',
        attributes: { 'include.in.token.scope': 'true' },
      })),
      clients: [
        ...[client, secondClient].map((clientId) => ({
          clientId,
          enabled: true,
          protocol: 'openid-connect',
          publicClient: true,
          standardFlowEnabled: true,
          directAccessGrantsEnabled: false,
          implicitFlowEnabled: false,
          fullScopeAllowed: false,
          consentRequired: false,
          redirectUris: [callback],
          attributes: { 'pkce.code.challenge.method': 'S256' },
          defaultClientScopes: ['basic'],
          optionalClientScopes: ['store:read', 'store:write'],
          protocolMappers: [
            {
              name: 'resource-audience',
              protocol: 'openid-connect',
              protocolMapper: 'oidc-audience-mapper',
              config: {
                'included.client.audience': resource,
                'access.token.claim': 'true',
                'introspection.token.claim': 'true',
              },
            },
            {
              name: 'subject',
              protocol: 'openid-connect',
              protocolMapper: 'oidc-sub-mapper',
              config: { 'access.token.claim': 'true', 'introspection.token.claim': 'true' },
            },
          ],
        })),
        {
          clientId: resource,
          enabled: true,
          protocol: 'openid-connect',
          publicClient: false,
          clientAuthenticatorType: 'client-secret',
          secret,
          standardFlowEnabled: false,
          directAccessGrantsEnabled: false,
          serviceAccountsEnabled: false,
          attributes: { resource_url: resource },
        },
        {
          clientId: 'tera-introspection',
          enabled: true,
          protocol: 'openid-connect',
          publicClient: false,
          clientAuthenticatorType: 'client-secret',
          secret,
          standardFlowEnabled: false,
          directAccessGrantsEnabled: false,
          serviceAccountsEnabled: false,
        },
      ],
      users: ['fixture-admin', 'fixture-admin-b'].map((username) => ({
        username,
        enabled: true,
        firstName: 'Fixture',
        lastName: 'Admin',
        email: `${username}@example.test`,
        emailVerified: true,
        credentials: [{ type: 'password', value: password, temporary: false }],
      })),
    }),
  );
  docker(
    'run',
    '--detach',
    '--rm',
    '--name',
    name,
    '--memory=1g',
    '-p',
    '127.0.0.1::8080',
    '-v',
    `${directory}:/opt/keycloak/data/import:ro`,
    image,
    'start-dev',
    '--import-realm',
    '--features=resource-indicators',
    '--hostname-strict=false',
  );
  const ports = JSON.parse(docker('inspect', '--format', '{{json .NetworkSettings.Ports}}', name));
  const origin = `http://127.0.0.1:${ports['8080/tcp'][0].HostPort}`;
  const issuer = `${origin}/realms/tera-compat`;
  let metadata: Record<string, any> | undefined;
  for (let i = 0; i < 120; i++) {
    try {
      const response = await fetch(`${issuer}/.well-known/openid-configuration`, {
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) {
        metadata = await response.json();
        break;
      }
    } catch {
      /* container is still starting */
    }
    await Bun.sleep(1000);
  }
  assert(metadata, 'Keycloak startup timed out');
  assert.equal(metadata.issuer, issuer);
  const jwks = await (await fetch(metadata.jwks_uri)).json();
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  async function authorize(
    overrides: Record<string, string> = {},
    browser: FixtureBrowser = { username: 'fixture-admin', cookies: new Map() },
  ) {
    const params = new URLSearchParams({
      client_id: client,
      response_type: 'code',
      redirect_uri: callback,
      scope: 'openid store:read',
      resource,
      state: 'fixture-state',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      ...overrides,
    });
    for (const [key, value] of Object.entries(overrides)) if (!value) params.delete(key);
    let url = `${metadata!.authorization_endpoint}?${params}`;
    let body: URLSearchParams | undefined;
    const cookies = browser.cookies;
    for (let i = 0; i < 12; i++) {
      if (url.startsWith(`${callback}?`)) return new URL(url).searchParams;
      assert.equal(new URL(url).origin, origin, 'Never follow a foreign fixture redirect');
      const response = await fetch(url, {
        method: body ? 'POST' : 'GET',
        body,
        redirect: 'manual',
        headers: { cookie: [...cookies.values()].join('; ') },
        signal: AbortSignal.timeout(5000),
      });
      for (const cookie of response.headers.getSetCookie()) {
        const value = cookie.split(';')[0];
        cookies.set(value.split('=')[0], value);
      }
      const html = await response.text();
      const location = response.headers.get('location');
      body = undefined;
      if (location) {
        url = new URL(location, origin).href;
        continue;
      }
      const action = html.match(/<form\b[^>]*\bid="kc-form-login"[^>]*\baction="([^"]+)"/);
      assert(action, `Expected fixture login form, got status ${response.status}`);
      url = action[1].replaceAll('&amp;', '&');
      body = new URLSearchParams({ username: browser.username, password, credentialId: '' });
    }
    throw new Error('Too many fixture redirects');
  }
  async function token(params: Record<string, string>) {
    const response = await fetch(metadata!.token_endpoint, {
      method: 'POST',
      body: new URLSearchParams({ client_id: client, resource, ...params }),
    });
    return { status: response.status, data: await response.json() };
  }
  async function issue(clientId = client, browser?: FixtureBrowser, scope = 'openid store:read') {
    const authorization = await authorize({ client_id: clientId, scope }, browser);
    assert.equal(authorization.get('state'), 'fixture-state');
    assert(authorization.get('code'), 'Authorization must produce a code');
    const result = await token({
      grant_type: 'authorization_code',
      client_id: clientId,
      code: authorization.get('code')!,
      redirect_uri: callback,
      code_verifier: verifier,
    });
    assert.equal(
      result.status,
      200,
      `Code redemption: ${result.data.error}: ${result.data.error_description}`,
    );
    assert.equal(typeof result.data.refresh_token, 'string');
    return result.data;
  }
  function claims(jwt: string, expectedClient = client, writes = false) {
    const [header, payload, signature] = jwt.split('.');
    const parsedHeader = JSON.parse(Buffer.from(header, 'base64url').toString());
    assert.equal(parsedHeader.alg, 'RS256');
    const jwk = jwks.keys.find((key: { kid: string }) => key.kid === parsedHeader.kid);
    assert(jwk, 'Token key must be discoverable');
    assert(
      verify(
        'RSA-SHA256',
        Buffer.from(`${header}.${payload}`),
        createPublicKey({ key: jwk, format: 'jwk' }),
        Buffer.from(signature, 'base64url'),
      ),
    );
    const result = JSON.parse(Buffer.from(payload, 'base64url').toString());
    assert.equal(result.iss, issuer);
    assert.equal(result.aud, resource);
    assert.equal(result.azp, expectedClient);
    assert.equal(typeof result.sub, 'string');
    assert.equal(typeof result.sid, 'string');
    assert(result.scope.split(' ').includes('store:read'));
    assert.equal(result.scope.split(' ').includes('store:write'), writes);
    return result;
  }
  async function introspect(accessToken: string, caller = resource) {
    const response = await fetch(metadata!.introspection_endpoint, {
      method: 'POST',
      body: new URLSearchParams({
        client_id: caller,
        client_secret: secret,
        token: accessToken,
      }),
    });
    assert.equal(response.status, 200);
    return response.json();
  }

  assert.equal(
    (await authorize({ code_challenge: '', code_challenge_method: '' })).get('error'),
    'invalid_request',
  );
  assert.equal((await authorize({ code_challenge_method: 'plain' })).get('error'), 'invalid_request');
  assert.equal((await authorize({ scope: 'openid store:unknown' })).get('error'), 'invalid_scope');
  const wrongTargetCode = (await authorize()).get('code')!;
  const wrongTarget = await token({
    grant_type: 'authorization_code',
    code: wrongTargetCode,
    redirect_uri: callback,
    code_verifier: verifier,
    resource: 'https://other.example/mcp',
  });
  assert.equal(wrongTarget.data.error, 'invalid_target');
  console.log('PASS: S256, unknown scope and code resource binding');

  const first = await issue();
  const firstClaims = claims(first.access_token);
  assert.equal((await introspect(first.access_token, 'tera-introspection')).active, false);
  const active = await introspect(first.access_token);
  assert.equal(active.active, true);
  assert.equal(active.aud, resource);
  // Real introspection with a synthetic grant store: no Supabase credentials or
  // business calls. The SQL store has separate local integration tests.
  const fixtureGrant = {
    id: crypto.randomUUID(),
    user_id: crypto.randomUUID(),
    scopes: ['store:read'],
    state: 'active',
    version: 1,
  };
  let grantReads = 0;
  const authorizer = new KeycloakGrantAuthorizer(
    {
      issuer,
      introspectionEndpoint: metadata!.introspection_endpoint,
      introspectionClientId: resource,
      introspectionClientSecret: secret,
      resource,
      project: 'compat-fixture',
      supabaseUrl: 'https://unused.example',
      serviceRoleKey: 'synthetic-only',
      scopes: ['store:read', 'store:write'],
    },
    async (url, init) => {
      if (url === 'https://unused.example/rest/v1/rpc/mcp_grant_command') {
        grantReads++;
        const body = JSON.parse(init.body as string);
        assert.deepEqual(body, {
          p_action: 'resolve',
          p_binding: {
            issuer,
            subject: firstClaims.sub,
            client_id: client,
            resource,
            project: 'compat-fixture',
            session_id: firstClaims.sid,
          },
        });
        return Response.json(fixtureGrant);
      }
      assert.equal(url, metadata!.introspection_endpoint);
      return fetch(url, init);
    },
  );
  const authorized = await authorizer.authorize(first.access_token);
  assert.equal(authorized.expectedUserId, fixtureGrant.user_id);
  assert.deepEqual(authorized.authorization.scopes, ['store:read']);
  await assert.rejects(authorizer.authorize(first.refresh_token), /AUTHORIZATION_DENIED/);
  await assert.rejects(authorizer.authorize('forged-access-token'), /AUTHORIZATION_DENIED/);
  assert.equal(grantReads, 1);
  assert.deepEqual(await authorized.authorization.currentScopes(), ['store:read']);
  console.log('PASS: host introspection profile, full binding, refresh/forged token rejection');
  const badRefresh = await token({
    grant_type: 'refresh_token',
    refresh_token: first.refresh_token,
    resource: 'https://other.example/mcp',
  });
  assert.equal(badRefresh.data.error, 'invalid_target');
  console.log('PASS: JWT/JWKS identity, audience and refresh resource binding');

  const hostRevoke = await fetch(metadata.revocation_endpoint, {
    method: 'POST',
    body: new URLSearchParams({
      client_id: client,
      token: first.refresh_token,
      token_type_hint: 'refresh_token',
    }),
  });
  assert.equal(hostRevoke.status, 200);
  await hostRevoke.text();
  await assert.rejects(authorized.authorization.currentScopes(), /AUTHORIZATION_DENIED/);
  assert.equal(grantReads, 2); // Revoked upstream token cannot reach even an active local grant.
  console.log('PASS: existing host context rejects upstream revocation without cached authorization');

  // Independent sessions: an invalid request may consume a rotating token.
  const second = await issue();
  const secondClaims = claims(second.access_token);
  assert.notEqual(secondClaims.sid, firstClaims.sid);
  const rotated = await token({ grant_type: 'refresh_token', refresh_token: second.refresh_token });
  assert.equal(rotated.status, 200);
  assert.notEqual(rotated.data.refresh_token, second.refresh_token);
  assert.equal(claims(rotated.data.access_token).sid, secondClaims.sid);
  const replay = await token({ grant_type: 'refresh_token', refresh_token: second.refresh_token });
  assert.equal(replay.data.error, 'invalid_grant');
  const successor = await token({ grant_type: 'refresh_token', refresh_token: rotated.data.refresh_token });
  assert.equal(successor.data.error, 'invalid_grant');
  console.log('PASS: rotation, stable session and replay family rejection');

  const third = await issue();
  claims(third.access_token);
  const revoke = await fetch(metadata.revocation_endpoint, {
    method: 'POST',
    body: new URLSearchParams({
      client_id: client,
      token: third.refresh_token,
      token_type_hint: 'refresh_token',
    }),
  });
  assert.equal(revoke.status, 200);
  await revoke.text();
  assert.equal((await introspect(third.access_token)).active, false);
  assert.equal(
    (await token({ grant_type: 'refresh_token', refresh_token: third.refresh_token })).data.error,
    'invalid_grant',
  );
  claims(third.access_token); // Signature survives revocation; online state matters.
  console.log('PASS: RFC7009 disables introspection and refresh, not JWT signature');

  const fourth = await issue();
  const expanded = await token({
    grant_type: 'refresh_token',
    refresh_token: fourth.refresh_token,
    scope: 'openid store:read store:write',
  });
  assert.equal(expanded.status, 200);
  claims(expanded.data.access_token); // Extra scope is intersected away, not granted.
  console.log('PASS: refresh cannot expand business scope');

  const browserA: FixtureBrowser = { username: 'fixture-admin', cookies: new Map() };
  const browserB: FixtureBrowser = { username: 'fixture-admin-b', cookies: new Map() };
  const aa = await issue(client, browserA);
  const ab = await issue(secondClient, browserA, 'openid store:read store:write');
  const ba = await issue(client, browserB);
  const bb = await issue(secondClient, browserB);
  const aaClaims = claims(aa.access_token);
  const abClaims = claims(ab.access_token, secondClient, true);
  const baClaims = claims(ba.access_token);
  const bbClaims = claims(bb.access_token, secondClient);
  assert.equal(aaClaims.sub, abClaims.sub);
  assert.equal(aaClaims.sid, abClaims.sid, 'Two clients share the same user SSO session');
  assert.equal(baClaims.sub, bbClaims.sub);
  assert.equal(baClaims.sid, bbClaims.sid);
  assert.notEqual(aaClaims.sub, baClaims.sub);
  assert.notEqual(aaClaims.sid, baClaims.sid);
  for (const issued of [aa, ab, ba, bb]) assert.equal((await introspect(issued.access_token)).active, true);

  const foreignRefresh = await token({
    client_id: secondClient,
    grant_type: 'refresh_token',
    refresh_token: aa.refresh_token,
  });
  assert.equal(foreignRefresh.status, 400);
  assert.equal(foreignRefresh.data.error, 'invalid_grant');
  const foreignRevoke = await fetch(metadata.revocation_endpoint, {
    method: 'POST',
    body: new URLSearchParams({
      client_id: secondClient,
      token: aa.refresh_token,
      token_type_hint: 'refresh_token',
    }),
  });
  assert.equal(foreignRevoke.status, 400);
  await foreignRevoke.text();
  for (const issued of [aa, ab, ba, bb]) assert.equal((await introspect(issued.access_token)).active, true);
  const ownerRefresh = await token({
    client_id: client,
    grant_type: 'refresh_token',
    refresh_token: aa.refresh_token,
  });
  assert.equal(ownerRefresh.status, 200, 'Wrong-client attempts must not consume the owner refresh token');
  assert.equal(claims(ownerRefresh.data.access_token).sid, aaClaims.sid);

  const ownerRevoke = await fetch(metadata.revocation_endpoint, {
    method: 'POST',
    body: new URLSearchParams({
      client_id: client,
      token: ownerRefresh.data.refresh_token,
      token_type_hint: 'refresh_token',
    }),
  });
  assert.equal(ownerRevoke.status, 200);
  await ownerRevoke.text();
  assert.equal((await introspect(aa.access_token)).active, false);
  assert.equal((await introspect(ownerRefresh.data.access_token)).active, false);
  for (const [issued, clientId, writes] of [
    [ab, secondClient, true],
    [ba, client, false],
    [bb, secondClient, false],
  ] as const) {
    assert.equal((await introspect(issued.access_token)).active, true);
    const refreshed = await token({
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: issued.refresh_token,
    });
    assert.equal(refreshed.status, 200);
    const original = claims(issued.access_token, clientId, writes);
    const current = claims(refreshed.data.access_token, clientId, writes);
    assert.equal(current.sub, original.sub);
    assert.equal(current.sid, original.sid);
  }
  console.log('PASS: two-user/two-client scope isolation, shared SSO sid and targeted revocation');
  if (local) {
    const { verifyLocalAuthorization } = await import('../tests/support/mcp-authorization-integration');
    const a: FixtureBrowser = { username: 'fixture-admin', cookies: new Map() };
    const b: FixtureBrowser = { username: 'fixture-admin-b', cookies: new Map() };
    const issued = [
      await issue(client, a),
      await issue(secondClient, a, 'openid store:read store:write'),
      await issue(client, b),
      await issue(secondClient, b),
    ] as const;
    await verifyLocalAuthorization(
      local,
      {
        issuer,
        introspectionEndpoint: metadata.introspection_endpoint,
        introspectionClientId: resource,
        introspectionClientSecret: secret,
        resource,
      },
      [issued[0].access_token, issued[1].access_token, issued[2].access_token, issued[3].access_token],
      async () => {
        const response = await fetch(metadata!.revocation_endpoint, {
          method: 'POST',
          body: new URLSearchParams({
            client_id: secondClient,
            token: issued[1].refresh_token,
            token_type_hint: 'refresh_token',
          }),
        });
        assert.equal(response.status, 200);
        await response.text();
      },
    );
  }
} finally {
  try {
    docker('rm', '--force', name);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
