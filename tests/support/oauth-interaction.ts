import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import Provider, { errors, type AdapterConstructor } from 'oidc-provider';
import { createOidcInteractionHandler } from '../../mcp/src/oidc-interaction';
import { createCredentialCipher, type CredentialEnvelope } from '../../mcp/src/credentials';

// Real provider HTTP/cookies/code/token, synthetic Supabase HTTP responses.
// The loopback fixture impersonates a trusted TLS proxy; NOT a deployment entrypoint.
export async function verifyOAuthInteraction(adapter?: AdapterConstructor) {
  const origin = 'https://auth.example';
  const resource = 'https://shop.example/mcp';
  const redirect = 'https://client.example/callback';
  const credentialExpiry = Math.floor(Date.now() / 1000) + 3600;
  const cipher = await createCredentialCipher(new Map([['test', randomBytes(32)]]), 'test');
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const identities = new Map<string, { userId: string; sessionId: string; callback: string }>();
  const grants = new Map<
    string,
    {
      id: string;
      user_id: string;
      scopes: string[];
      state: string;
      version: number;
      envelope?: CredentialEnvelope;
    }
  >();
  let onWrite = async () => {};
  const provider = new Provider(origin, {
    adapter,
    jwks: { keys: [{ ...privateKey.export({ format: 'jwk' }), kid: 'test', alg: 'ES256', use: 'sig' }] },
    cookies: { keys: [randomBytes(32).toString('hex')] },
    clients: [
      {
        client_id: 'agent',
        redirect_uris: [redirect],
        token_endpoint_auth_method: 'none',
        id_token_signed_response_alg: 'ES256',
        response_types: ['code'],
        grant_types: ['authorization_code', 'refresh_token'],
      },
    ],
    scopes: ['openid', 'offline_access'],
    features: {
      devInteractions: { enabled: false },
      resourceIndicators: {
        enabled: true,
        getResourceServerInfo(_ctx, target) {
          if (target !== resource) throw new errors.InvalidTarget();
          return { scope: 'store:read store:write', audience: resource, accessTokenFormat: 'opaque' };
        },
      },
    },
    pkce: { required: () => true },
    findAccount: async (_ctx, id) => ({ accountId: id, claims: async () => ({ sub: id }) }),
    renderError: (ctx, output) => {
      ctx.body = output;
    },
  });
  provider.proxy = true; // Loopback-only fixture with a fixed, synthetic TLS authority.
  let failCompletion = false;
  let completions = 0;
  const originalResult = provider.interactionResult.bind(provider);
  provider.interactionResult = async (...args) => {
    completions++;
    const location = await originalResult(...args);
    if (failCompletion) throw new Error('lost secret completion receipt');
    return location;
  };
  const buildHandler = () =>
    createOidcInteractionHandler(
      provider,
      {
        publicOrigin: origin,
        callbackUrl: `${origin}/callback`,
        resource,
        project: 'project',
        scopes: ['store:read', 'store:write'],
        supabaseUrl: 'https://db.example',
        anonKey: 'public',
        serviceRoleKey: 'service-secret',
      },
      cipher,
      async (url, init) => {
        assert.equal(new URL(url).origin, 'https://db.example');
        const body = init.body ? JSON.parse(init.body as string) : {};
        const name = new URL(url).pathname.split('/').at(-1)!;
        if (name === 'otp') {
          const code = crypto.randomUUID();
          const callback = new URL(new URL(url).searchParams.get('redirect_to')!);
          callback.searchParams.set('code', code);
          identities.set(code, {
            userId: crypto.randomUUID(),
            sessionId: crypto.randomUUID(),
            callback: callback.href,
          });
          return Response.json({});
        }
        if (name === 'token') {
          const identity = identities.get(body.auth_code)!;
          return Response.json({
            access_token: `access-${body.auth_code}`,
            refresh_token: `refresh-${body.auth_code}`,
            token_type: 'bearer',
            expires_at: credentialExpiry,
            user: { id: identity.userId, is_anonymous: false },
          });
        }
        if (!name.startsWith('mcp_')) {
          const bearer = new Headers(init.headers).get('authorization')!;
          const identity = identities.get(bearer.replace('Bearer access-', ''))!;
          assert(identity);
          if (name === 'user')
            return Response.json({ id: identity.userId, role: 'authenticated', is_anonymous: false });
          if (name === 'is_admin') return Response.json(true);
          if (name === 'get_mcp_downstream_session')
            return Response.json({ user_id: identity.userId, session_id: identity.sessionId });
        }
        assert.equal(new Headers(init.headers).get('authorization'), 'Bearer service-secret');
        const upstream = body.p_binding.session_id;
        if (name === 'mcp_grant_command') {
          if (body.p_action === 'create') {
            assert(!grants.has(upstream));
            grants.set(upstream, {
              id: crypto.randomUUID(),
              user_id: body.p_user_id,
              scopes: body.p_scopes,
              state: 'active',
              version: 1,
            });
          }
          const grant = grants.get(upstream)!;
          if (body.p_action === 'revoke') {
            grant.state = 'revoked';
            grant.version = 2;
            delete grant.envelope;
          }
          return Response.json(grant);
        }
        if (name === 'mcp_bind_downstream_session')
          return Response.json({ grant_id: body.p_grant_id, session_id: body.p_session_id });
        if (name === 'mcp_credential_command') {
          assert.equal(body.p_action, 'write');
          assert.equal(body.p_expected_revision, 0);
          grants.get(upstream)!.envelope = body.p_envelope;
          await onWrite();
          return Response.json({ revision: 1, envelope: body.p_envelope });
        }
        throw new Error('Unexpected fixture call');
      },
    );
  let handler = buildHandler();
  const server = createServer((req, res) => {
    void handler(req, res)
      .then((handled) => {
        if (!handled) return provider.callback()(req, res);
      })
      .catch(() => {
        res.statusCode = 500;
        res.end('Fixture failed');
      });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}`;
  // Node fetch ignores a custom Host header. Use native HTTP to exercise the
  // fixed authority contract; do not weaken the handler to fit a test client.
  function exchange(url: string, init: { method: string; headers: Record<string, string>; body?: string }) {
    return new Promise<Response>((resolve, reject) => {
      const req = httpRequest(url, init, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const headers = new Headers();
          for (let i = 0; i < res.rawHeaders.length; i += 2)
            headers.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
          resolve(new Response(Buffer.concat(chunks), { status: res.statusCode!, headers }));
        });
      });
      req.on('error', reject);
      req.setTimeout(10_000, () => req.destroy(new Error('Fixture HTTP timeout')));
      req.end(init.body);
    });
  }
  function browser() {
    const cookies = new Map<string, { pair: string; path: string }>();
    let csrf = '';
    const cookieHeader = (path: string) =>
      [...cookies.values()]
        .filter((c) => path === c.path || path.startsWith(c.path.endsWith('/') ? c.path : `${c.path}/`))
        .map((c) => c.pair)
        .join('; ');
    async function call(
      path: string,
      action?: string,
      body?: string,
      overrides: Record<string, string> = {},
    ) {
      const url = new URL(path, origin);
      assert.equal(url.origin, origin);
      const response = await exchange(`${endpoint}${url.pathname}${url.search}`, {
        method: action ? 'POST' : 'GET',
        body,
        headers: {
          host: 'auth.example',
          'x-forwarded-proto': 'https',
          cookie: cookieHeader(url.pathname),
          ...(action
            ? { origin, 'x-csrf-token': csrf, 'x-tera-login': 'start', 'x-tera-consent': action }
            : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...overrides,
        },
      });
      for (const raw of response.headers.getSetCookie()) {
        const pair = raw.split(';')[0];
        const path = /;\s*path=([^;]+)/i.exec(raw)?.[1] ?? '/';
        cookies.set(`${pair.split('=')[0]}:${path}`, { pair, path });
      }
      const text = await response.text();
      assert(!text.includes('secret'));
      assert(!text.includes('access-'));
      assert(!text.includes('refresh-'));
      return { status: response.status, headers: response.headers, text };
    }
    return {
      call,
      cookieHeader,
      async start(path: string) {
        const result = await call(`${path}/start`, 'start');
        assert.equal(result.status, 201, result.text);
        csrf = JSON.parse(result.text).csrfToken;
      },
      async login() {
        assert.equal(
          (await call('/login/email', 'email', JSON.stringify({ email: 'admin@example.com' }))).status,
          202,
        );
        const entry = [...identities.entries()].at(-1)!;
        const result = await call(entry[1].callback);
        assert.equal(result.status, 303, result.text);
        assert.equal(result.headers.get('location'), `${origin}/login/status`);
        assert.equal(JSON.parse((await call('/login/status')).text).status, 'authenticated');
        return entry;
      },
    };
  }
  const verifier = randomBytes(32).toString('base64url');
  async function begin(scope = 'store:read') {
    const b = browser();
    const params = new URLSearchParams({
      client_id: 'agent',
      redirect_uri: redirect,
      response_type: 'code',
      scope: `openid offline_access ${scope}`,
      resource,
      state: 'client-state',
      prompt: 'consent',
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    });
    const result = await b.call(`/auth?${params}`);
    assert.equal(result.status, 303, result.text);
    const path = new URL(result.headers.get('location')!, origin).pathname;
    assert(path.startsWith('/interaction/'));
    return { b, path };
  }
  async function resume(b: ReturnType<typeof browser>, location: string) {
    const result = await b.call(location);
    assert.equal(result.status, 303, result.text);
    const callback = new URL(result.headers.get('location')!, origin);
    assert.equal(`${callback.origin}${callback.pathname}`, redirect);
    assert.equal(callback.searchParams.get('state'), 'client-state');
    return callback.searchParams;
  }
  try {
    const a = await begin(),
      b = await begin('store:write');
    const description = await a.b.call(a.path);
    assert.equal(description.status, 200, description.text);
    assert.equal(description.headers.get('cache-control'), 'no-store');
    assert.deepEqual(JSON.parse(description.text), {
      clientId: 'agent',
      redirectUri: redirect,
      resource,
      scopes: ['store:read'],
      offlineAccess: true,
    });
    assert.equal(
      (await a.b.call(b.path, undefined, undefined, { cookie: a.b.cookieHeader(a.path) })).status,
      403,
    );
    assert.equal((await a.b.call(a.path, undefined, undefined, { cookie: '' })).status, 403);
    assert.equal((await a.b.call(a.path, undefined, undefined, { host: 'evil.example' })).status, 403);
    assert.equal(
      (await a.b.call(`${a.path}/start`, 'start', undefined, { origin: 'https://evil.example' })).status,
      403,
    );
    await a.b.start(a.path);
    await b.b.start(b.path);
    assert.equal((await a.b.call(`${a.path}/start`, 'start')).status, 409);
    for (const path of ['/login/session', '/login/approve', '/login/cancel'])
      assert.equal((await a.b.call(path, 'start')).status, 404);
    assert.equal((await a.b.call(`${a.path}/approve`, 'approve')).status, 403); // Still unauthenticated.
    const [code, identity] = await a.b.login();
    assert.equal(
      (await a.b.call(`${a.path}/approve`, 'approve', undefined, { 'x-csrf-token': 'wrong' })).status,
      403,
    );
    assert.equal((await a.b.call(`${a.path}/approve`, 'deny')).status, 403);
    assert.equal((await a.b.call(`${a.path}/approve`, 'approve', '{}')).status, 403);
    // Native provider cookie of A + login cookie of B must not approve either request.
    const mixed = `${a.b
      .cookieHeader(a.path)
      .split('; ')
      .filter((c) => !c.startsWith('__Host-'))
      .join('; ')}; ${b.b.cookieHeader('/login/status')}`;
    assert.equal((await b.b.call(`${a.path}/approve`, 'approve', undefined, { cookie: mixed })).status, 403);
    assert.equal(grants.size, 0);
    const reached = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    onWrite = async () => {
      reached.resolve();
      await release.promise;
    };
    const timer = setTimeout(() => {
      reached.reject(new Error('Write barrier timed out'));
      release.resolve();
    }, 5000);
    let result: Awaited<ReturnType<typeof a.b.call>>;
    const pending = a.b.call(`${a.path}/approve`, 'approve');
    try {
      await reached.promise;
      assert.equal(completions, 0); // No code before persistence acknowledges success.
      assert.equal((await a.b.call(`${a.path}/cancel`, 'deny')).status, 409);
      assert.equal((await a.b.call(`${a.path}/approve`, 'approve')).status, 409);
    } finally {
      release.resolve();
      clearTimeout(timer);
      result = await pending;
      onWrite = async () => {};
    }
    assert.equal(result.status, 303, result.text);
    assert.equal(completions, 1);
    const authorization = await resume(a.b, result.headers.get('location')!);
    assert(!authorization.has('error'), authorization.toString());
    const token = await exchange(`${endpoint}/token`, {
      method: 'POST',
      headers: {
        host: 'auth.example',
        'x-forwarded-proto': 'https',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: 'agent',
        grant_type: 'authorization_code',
        code: authorization.get('code')!,
        code_verifier: verifier,
        redirect_uri: redirect,
        resource,
      }).toString(),
    });
    const tokens = await token.json();
    assert.equal(token.status, 200, JSON.stringify({ error: tokens.error }));
    assert.equal(typeof tokens.refresh_token, 'string');
    const access = await provider.AccessToken.find(tokens.access_token);
    assert.equal(access?.accountId, identity.userId);
    assert.equal(access?.scope, 'store:read');
    assert.equal(access?.aud, resource);
    const saved = grants.get(access!.grantId!)!;
    assert.deepEqual(
      await cipher.open(
        { project: 'project', grantId: saved.id, userId: identity.userId, revision: 1 },
        saved.envelope!,
      ),
      {
        accessToken: `access-${code}`,
        refreshToken: `refresh-${code}`,
        expiresAt: credentialExpiry,
      },
    );
    assert.equal(saved.state, 'active');
    const denied = await b.b.call(`${b.path}/cancel`, 'deny');
    assert.equal(denied.status, 303, denied.text);
    assert.equal((await resume(b.b, denied.headers.get('location')!)).get('error'), 'access_denied');
    assert.equal(grants.size, 1);
    const changed = await begin();
    await changed.b.start(changed.path);
    await changed.b.login();
    const interaction = await provider.Interaction.find(changed.path.split('/').at(-1)!);
    assert(interaction);
    interaction.params.scope = 'openid offline_access store:write';
    await interaction.save(300);
    assert.equal((await changed.b.call(`${changed.path}/approve`, 'approve')).status, 403);
    assert.equal(grants.size, 1); // Cannot replace the scope shown at bootstrap.
    const failed = await begin('store:write');
    await failed.b.start(failed.path);
    await failed.b.login();
    failCompletion = true;
    const failure = await failed.b.call(`${failed.path}/approve`, 'approve');
    assert.equal(failure.status, 403, failure.text);
    const [upstream, revoked] = [...grants.entries()].at(-1)!;
    assert.equal(revoked.state, 'revoked');
    assert.equal(revoked.envelope, undefined);
    assert.equal(await provider.Grant.find(upstream), undefined);
    assert.equal((await failed.b.call(`${failed.path}/approve`, 'approve')).status, 403);
    assert.equal(grants.size, 2);
    // Persisted provider results reject even when the host's transient store is lost.
    handler = buildHandler();
    assert.equal((await failed.b.call(`${failed.path}/start`, 'start')).status, 403);
    failCompletion = false;
    const originalNow = Date.now;
    const start = originalNow();
    Date.now = () => start;
    try {
      const expired = await begin();
      await expired.b.start(expired.path);
      await expired.b.login();
      Date.now = () => start + 300_000;
      assert.equal((await expired.b.call(`${expired.path}/approve`, 'approve')).status, 403);
      assert.equal(grants.size, 2);
    } finally {
      Date.now = originalNow;
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
