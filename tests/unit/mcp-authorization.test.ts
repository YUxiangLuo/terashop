import { expect, spyOn, test } from 'bun:test';
import { KeycloakGrantAuthorizer, type AuthorizationConfig } from '../../mcp/src/authorization';

function fixture() {
  const config: AuthorizationConfig = {
    issuer: 'https://auth.example/realm',
    introspectionEndpoint: 'https://auth.example/realm/introspect',
    introspectionClientId: 'resource-client',
    introspectionClientSecret: 'introspection-secret',
    resource: 'https://shop.example/mcp',
    project: 'project-a',
    supabaseUrl: 'https://db.example',
    serviceRoleKey: 'service-secret',
    scopes: ['store:read', 'store:write', 'store:payments'],
  };
  const claims: Record<string, unknown> = {
    active: true,
    typ: 'Bearer',
    iss: config.issuer,
    aud: config.resource,
    sub: 'subject-a',
    client_id: 'agent-a',
    sid: 'session-a',
    exp: Math.floor(Date.now() / 1000) + 300,
    scope: 'openid store:read store:write store:privacy',
  };
  const grant = {
    id: crypto.randomUUID(),
    user_id: crypto.randomUUID(),
    scopes: ['store:read', 'store:privacy', 'store:payments'],
    state: 'active',
    version: 1,
  };
  const calls: { url: string; init: RequestInit }[] = [];
  const request = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Response.json(url === config.introspectionEndpoint ? claims : grant);
  };
  return { config, claims, grant, calls, request, authorizer: new KeycloakGrantAuthorizer(config, request) };
}

test('verified identity determines full binding; scopes intersect token, grant and deployment', async () => {
  const f = fixture();
  f.claims.sub = ' subject-a '; // Opaque identifiers must not be normalized.
  f.claims.aud = ['another-resource', f.config.resource];
  const result = await f.authorizer.authorize('opaque-access-token');
  expect(result.expectedUserId).toBe(f.grant.user_id);
  expect(result.grantId).toBe(f.grant.id);
  expect(result.authorization.scopes).toEqual(['store:read']);
  expect(JSON.parse(f.calls[1].init.body as string)).toEqual({
    p_action: 'resolve',
    p_binding: {
      issuer: f.config.issuer,
      subject: ' subject-a ',
      client_id: 'agent-a',
      resource: f.config.resource,
      project: 'project-a',
      session_id: 'session-a',
    },
  });
  expect(f.calls[0].init.body).toBeInstanceOf(URLSearchParams);
  expect((f.calls[0].init.body as URLSearchParams).get('token')).toBe('opaque-access-token');
  expect(JSON.stringify(f.calls[0].init)).not.toContain('service-secret');
  expect(JSON.stringify(f.calls[1])).not.toContain('opaque-access-token');
  for (const { init } of f.calls) {
    expect(init.redirect).toBe('error');
    expect(init.cache).toBe('no-store');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  }
  f.grant.scopes.push('store:write');
  expect(await result.authorization.currentScopes()).toEqual(['store:read']); // No session upgrade.
  f.claims.scope = 'store:write';
  expect(await result.authorization.currentScopes()).toEqual([]);
  f.claims.active = false;
  await expect(result.authorization.currentScopes()).rejects.toThrow('AUTHORIZATION_DENIED');
  expect(f.calls.length).toBe(7); // No grant lookup after inactive response.
});

test('invalid, expired, wrong-audience and non-access tokens never reach grant storage', async () => {
  for (const change of [
    { active: false },
    { active: 'true' },
    { typ: 'Refresh' },
    { typ: 'ID' },
    { typ: undefined },
    { iss: 'https://other.example/realm' },
    { iss: ' https://auth.example/realm' },
    { aud: ['https://elsewhere.example/mcp'] },
    { aud: [] },
    { exp: Math.floor(Date.now() / 1000) },
    { exp: undefined },
    { nbf: Math.floor(Date.now() / 1000) + 300 },
    { sub: '' },
    { client_id: undefined },
    { sid: undefined },
    { scope: null },
  ]) {
    const f = fixture();
    Object.assign(f.claims, change);
    await expect(f.authorizer.authorize('token')).rejects.toThrow('AUTHORIZATION_DENIED');
    expect(f.calls.length).toBe(1);
  }
});

test('each call rechecks grant state and pinned user and grant IDs', async () => {
  for (const change of [
    { state: 'revoked' },
    { user_id: crypto.randomUUID() },
    { id: crypto.randomUUID() },
    { version: 2 },
    { scopes: ['store:root'] },
  ]) {
    const f = fixture();
    const session = await f.authorizer.authorize('token');
    Object.assign(f.grant, change);
    await expect(session.authorization.currentScopes()).rejects.toThrow('AUTHORIZATION_DENIED');
    expect(f.calls.length).toBe(4);
  }
});

test('transport failures and malformed responses fail closed without disclosing secrets', async () => {
  for (const failedRequest of [
    async () => {
      throw new Error('introspection-secret token service-secret');
    },
    async () => new Response('token service-secret', { status: 500 }),
    async () => new Response('not json'),
  ]) {
    const f = fixture();
    for (const failureAt of [0, 1]) {
      let count = 0;
      const authorizer = new KeycloakGrantAuthorizer(f.config, async (url, init) =>
        count++ === failureAt ? failedRequest() : f.request(url, init),
      );
      await expect(authorizer.authorize('token')).rejects.toThrow(/^AUTHORIZATION_DENIED$/);
    }
  }
});

test('configuration is snapshotted and unsafe destinations are rejected', async () => {
  const f = fixture();
  f.config.scopes = ['store:privacy'];
  f.config.project = 'other-project';
  const result = await f.authorizer.authorize('token');
  expect(result.authorization.scopes).toEqual(['store:read']);
  expect(JSON.parse(f.calls[1].init.body as string).p_binding.project).toBe('project-a');
  for (const change of [
    { introspectionEndpoint: 'https://evil.example/introspect' },
    { introspectionEndpoint: 'http://auth.example/introspect' },
    { supabaseUrl: 'https://db.example/path' },
    { issuer: 'https://user:password@auth.example/realm' },
  ])
    expect(() => new KeycloakGrantAuthorizer({ ...f.config, ...change })).toThrow();
});

test('expiry is enforced again after lookup; nbf at the current second is allowed', async () => {
  const clock = spyOn(Date, 'now').mockReturnValue(2_000_000_000_000);
  try {
    const f = fixture();
    f.claims.nbf = 2_000_000_000;
    f.claims.exp = 2_000_000_001;
    expect((await f.authorizer.authorize('token')).authorization.scopes).toEqual(['store:read']);
    const authorizer = new KeycloakGrantAuthorizer(f.config, async (url, init) => {
      if (url.endsWith('/mcp_grant_command')) clock.mockReturnValue(2_000_000_001_000);
      return f.request(url, init);
    });
    await expect(authorizer.authorize('token')).rejects.toThrow('AUTHORIZATION_DENIED');
    expect(f.calls.length).toBe(4);
  } finally {
    clock.mockRestore();
  }
});
