import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import Provider, { errors, type AdapterConstructor, type ClientMetadata } from 'oidc-provider';
import * as z from 'zod/v4';

const text = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.trim() === value);
const material = z
  .string()
  .length(43)
  .refine((value) => {
    const bytes = Buffer.from(value, 'base64url');
    return bytes.length === 32 && bytes.toString('base64url') === value;
  });
// z.url() trims surrounding whitespace; reject it before URL validation so a
// configured resource/redirect cannot silently acquire a different identity.
const url = z
  .string()
  .refine((value) => value.trim() === value)
  .pipe(z.url());
const https = url.refine((value) => {
  const url = new URL(value);
  return (
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    (url.href === value || value === url.origin)
  );
});
const configuration = z.strictObject({
  issuer: https
    .refine((value) => new URL(value).pathname === '/')
    .transform((value) => new URL(value).origin),
  resource: https,
  scopes: z
    .array(z.enum(['store:read', 'store:write', 'store:payments', 'store:access', 'store:privacy']))
    .min(1)
    .max(5),
  signingKey: z.strictObject({
    kty: z.literal('EC'),
    crv: z.literal('P-256'),
    alg: z.literal('ES256'),
    use: z.literal('sig'),
    kid: text,
    x: material,
    y: material,
    d: material,
  }),
  cookieKeys: z.array(material).min(1).max(3),
  clients: z
    .array(
      z
        .strictObject({
          id: text,
          applicationType: z.enum(['web', 'native']),
          redirectUris: z.array(url).min(1).max(10),
        })
        .refine((client) =>
          client.redirectUris.every((value) => {
            const url = new URL(value);
            return (
              url.href === value &&
              !url.username &&
              !url.password &&
              !url.hash &&
              !url.search &&
              (client.applicationType === 'web'
                ? url.protocol === 'https:'
                : url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))
            );
          }),
        ),
    )
    .min(1)
    .max(100),
  introspectionClient: z.strictObject({ id: text, secret: material }),
});

// Fixed issuer policy, not a listener. Secrets are explicitly provisioned by the
// host; no generated/default keys, environment reads, dynamic clients or proxy trust.
// The host owns a dedicated persistent adapter and its connection lifecycle.
export function createOidcProvider(input: unknown, Adapter: AdapterConstructor): Provider {
  try {
    const c = configuration.parse(input);
    const ids = c.clients.map((client) => client.id);
    if (
      new Set([...ids, c.introspectionClient.id]).size !== ids.length + 1 ||
      new Set(c.cookieKeys).size !== c.cookieKeys.length ||
      new Set(c.scopes).size !== c.scopes.length ||
      c.clients.some((client) => new Set(client.redirectUris).size !== client.redirectUris.length)
    )
      throw new Error('Duplicate configuration');
    const key = createPrivateKey({ key: c.signingKey, format: 'jwk' });
    // Parsing a JWK alone does not prove its public coordinates match its scalar.
    const probe = Buffer.from('tera-oidc-signing-key-validation');
    if (!verify('sha256', probe, createPublicKey(key), sign('sha256', probe, key)))
      throw new Error('Mismatched signing key');
    class RegisteredAdapter extends Adapter {
      constructor(private readonly model: string) {
        super(model);
      }
      async find(id: string) {
        // Static clients resolve in provider before adapter lookup. Ignore stale
        // Client artifacts left in an issuer database by a different deployment.
        return this.model === 'Client' ? undefined : super.find(id);
      }
    }
    return new Provider(c.issuer, {
      adapter: RegisteredAdapter,
      jwks: { keys: [c.signingKey] },
      cookies: {
        keys: c.cookieKeys,
        long: { secure: true, httpOnly: true, sameSite: 'lax' },
        short: { secure: true, httpOnly: true, sameSite: 'lax' },
      },
      clients: [
        ...c.clients.map<ClientMetadata>((client) => ({
          client_id: client.id,
          application_type: client.applicationType,
          redirect_uris: client.redirectUris,
          token_endpoint_auth_method: 'none' as const,
          id_token_signed_response_alg: 'ES256',
          response_types: ['code'],
          grant_types: ['authorization_code', 'refresh_token'],
        })),
        {
          client_id: c.introspectionClient.id,
          client_secret: c.introspectionClient.secret,
          token_endpoint_auth_method: 'client_secret_post',
          id_token_signed_response_alg: 'ES256',
          redirect_uris: [],
          response_types: [],
          grant_types: [],
        },
      ],
      responseTypes: ['code'],
      scopes: ['openid', 'offline_access'],
      features: {
        devInteractions: { enabled: false },
        userinfo: { enabled: false },
        registration: { enabled: false },
        registrationManagement: { enabled: false },
        introspection: {
          enabled: true,
          allowedPolicy: (_ctx, client, token) =>
            client.clientId === c.introspectionClient.id &&
            token.kind === 'AccessToken' &&
            (token.aud === c.resource ||
              (Array.isArray(token.aud) && token.aud.length === 1 && token.aud[0] === c.resource)),
        },
        revocation: {
          enabled: true,
          allowedPolicy: (_ctx, client, token) =>
            ids.includes(client.clientId) && token.clientId === client.clientId,
        },
        resourceIndicators: {
          enabled: true,
          getResourceServerInfo(_ctx, target, client) {
            if (target !== c.resource || !ids.includes(client.clientId)) throw new errors.InvalidTarget();
            return {
              scope: c.scopes.join(' '),
              audience: c.resource,
              accessTokenFormat: 'opaque',
              accessTokenTTL: 300,
            };
          },
        },
      },
      pkce: { required: () => true },
      rotateRefreshToken: true,
      revokeGrantPolicy: () => true,
      issueRefreshToken: (_ctx, client, token) =>
        client.grantTypeAllowed('refresh_token') && token.scopes.has('offline_access'),
      interactions: { url: (_ctx, interaction) => `/interaction/${interaction.uid}` },
      ttl: {
        Interaction: 300,
        Session: 28800,
        Grant: 2592000,
        AuthorizationCode: 60,
        AccessToken: 300,
        RefreshToken: 2592000,
        IdToken: 300,
      },
      extraTokenClaims: (_ctx, token) =>
        token.kind === 'AccessToken' ? { grant_id: token.grantId, token_kind: 'AccessToken' } : {},
      findAccount: async (_ctx, id) =>
        z.uuid().safeParse(id).success ? { accountId: id, claims: async () => ({ sub: id }) } : undefined,
      renderError: (ctx, output) => {
        ctx.set('Cache-Control', 'no-store');
        ctx.set('Referrer-Policy', 'no-referrer');
        ctx.body = { error: output.error };
      },
    });
  } catch {
    // Schema/provider errors may contain key material or confidential metadata.
    throw new Error('INVALID_OIDC_PROVIDER_CONFIGURATION');
  }
}
