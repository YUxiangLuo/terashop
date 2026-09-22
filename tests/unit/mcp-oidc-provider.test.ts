import { expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import type { AdapterPayload } from 'oidc-provider';
import { createOidcProvider } from '../../mcp/src/oidc-provider';

// Deliberately offers an old dynamic client; the production factory must ignore it.
class Adapter {
  async find(id: string): Promise<AdapterPayload> {
    return { client_id: id, redirect_uris: ['https://old.example/cb'], token_endpoint_auth_method: 'none' };
  }
  async findByUid() {}
  async findByUserCode() {}
  async upsert() {}
  async consume() {}
  async destroy() {}
  async revokeByGrantId() {}
}
function config() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    issuer: 'https://auth.example/',
    resource: 'https://shop.example/mcp',
    scopes: ['store:read'],
    signingKey: { ...privateKey.export({ format: 'jwk' }), kid: 'stable', alg: 'ES256', use: 'sig' },
    cookieKeys: [randomBytes(32).toString('base64url')],
    clients: [{ id: 'agent', applicationType: 'web', redirectUris: ['https://client.example/cb'] }],
    introspectionClient: { id: 'resource', secret: randomBytes(32).toString('base64url') },
  };
}

test('configuration fails closed without logging secret values or silently generating keys', () => {
  const c = config();
  const wrongKey = config().signingKey;
  for (const [index, input] of [
    {},
    { ...c, signingKey: undefined },
    { ...c, cookieKeys: [] },
    { ...c, cookieKeys: ['short-secret'] },
    { ...c, cookieKeys: [c.cookieKeys[0], c.cookieKeys[0]] },
    { ...c, signingKey: { ...c.signingKey, x: wrongKey.x, y: wrongKey.y } },
    { ...c, signingKey: { ...c.signingKey, d: undefined } },
    { ...c, issuer: 'http://auth.example' },
    { ...c, issuer: 'https://auth.example/issuer' },
    { ...c, resource: 'https://shop.example/mcp#fragment' },
    { ...c, resource: 'https://shop.example/mcp ' },
    { ...c, clients: [c.clients[0], c.clients[0]] },
    { ...c, introspectionClient: { ...c.introspectionClient, id: 'agent' } },
    { ...c, scopes: ['store:read', 'store:read'] },
    { ...c, scopes: ['openid'] },
    { ...c, proxy: true },
  ].entries())
    expect(() => createOidcProvider(input, Adapter), `invalid case ${index}`).toThrow(
      /^INVALID_OIDC_PROVIDER_CONFIGURATION$/,
    );
  for (const [applicationType, redirect] of [
    ['web', 'http://client.example/cb'],
    ['web', 'https://client.example/cb#fragment'],
    ['native', 'http://localhost:3000/cb'],
    ['native', 'http://192.168.0.1/cb'],
    ['native', 'javascript:alert(1)'],
  ])
    expect(() =>
      createOidcProvider(
        { ...c, clients: [{ id: 'agent', applicationType, redirectUris: [redirect] }] },
        Adapter,
      ),
    ).toThrow(/^INVALID_OIDC_PROVIDER_CONFIGURATION$/);
});

test('pre-registered clients are snapshotted; old database clients and implicit grant defaults cannot enter', async () => {
  const c = config();
  c.clients.push({ id: 'native', applicationType: 'native', redirectUris: ['http://127.0.0.1:49199/cb'] });
  const provider = createOidcProvider(c, Adapter);
  expect(provider.proxy).toBe(false);
  expect(provider.issuer).toBe('https://auth.example');
  c.clients[0].redirectUris[0] = 'https://evil.example/cb';
  const client = await provider.Client.find('agent');
  expect(client?.redirectUris).toEqual(['https://client.example/cb']);
  expect(client?.grantTypeAllowed('authorization_code')).toBe(true);
  expect(client?.grantTypeAllowed('refresh_token')).toBe(true);
  expect(client?.grantTypeAllowed('client_credentials')).toBe(false);
  expect(await provider.Client.find('old-dynamic-client')).toBeUndefined();
  expect((await provider.Client.find('native'))?.applicationType).toBe('native');
  const rs = await provider.Client.find('resource');
  expect(rs?.grantTypes).toEqual([]);
  expect(rs?.responseTypes).toEqual([]);
  expect(rs?.redirectUris).toEqual([]);
});

test('discovery disables extra protocols and JWKS remains stable without exposing private material', async () => {
  const c = config();
  for (let instance = 0; instance < 2; instance++) {
    const provider = createOidcProvider(c, Adapter);
    provider.proxy = true; // Loopback fixture emulates the configured TLS authority.
    const server = createServer(provider.callback());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing test listener');
      const origin = `http://127.0.0.1:${address.port}`;
      const metadata = await (
        await fetch(`${origin}/.well-known/openid-configuration`, {
          headers: { host: 'auth.example', 'x-forwarded-proto': 'https' },
        })
      ).json();
      expect(metadata.issuer).toBe('https://auth.example');
      expect(metadata.response_types_supported).toEqual(['code']);
      expect(metadata.code_challenge_methods_supported).toEqual(['S256']);
      expect(metadata.userinfo_endpoint).toBeUndefined();
      expect(metadata.registration_endpoint).toBeUndefined();
      expect(metadata.introspection_endpoint).toBe('https://auth.example/token/introspection');
      const jwks = await (await fetch(`${origin}/jwks`)).json();
      expect(jwks.keys).toEqual([
        {
          kty: 'EC',
          crv: 'P-256',
          x: c.signingKey.x,
          y: c.signingKey.y,
          kid: 'stable',
          alg: 'ES256',
          use: 'sig',
        },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
});
