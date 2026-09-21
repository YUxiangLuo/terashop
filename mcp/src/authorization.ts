import * as z from 'zod/v4';
import type { AdminScope, ToolAuthorization } from './permissions';

const scope = z.enum(['store:read', 'store:write', 'store:payments', 'store:access', 'store:privacy']);
const text = z.string().refine((value) => value.trim().length > 0);
const claims = z.object({
  active: z.literal(true),
  typ: z.literal('Bearer'), // Keycloak access-token discriminator; rejects refresh and ID tokens.
  iss: text,
  aud: z.union([text, z.array(text).min(1)]),
  sub: text,
  client_id: text,
  sid: text,
  exp: z.number().int(),
  nbf: z.number().int().optional(),
  scope: z.string(),
});
const grant = z.object({
  id: z.uuid(),
  user_id: z.uuid(),
  scopes: z.array(scope),
  state: z.literal('active'),
  version: z.literal(1),
});

export interface AuthorizationConfig {
  issuer: string;
  introspectionEndpoint: string;
  introspectionClientId: string;
  introspectionClientSecret: string;
  resource: string;
  project: string;
  supabaseUrl: string;
  serviceRoleKey: string;
  scopes: readonly AdminScope[];
}

function endpoint(value: string): URL {
  const url = new URL(value);
  if (
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Invalid authorization endpoint');
  return url;
}

// Trusted-host only. Never passed tool arguments, and never used for business RPCs.
// This implements the Keycloak introspection profile, not generic OIDC discovery.
export class KeycloakGrantAuthorizer {
  private readonly config: AuthorizationConfig;
  constructor(
    config: AuthorizationConfig,
    private readonly request: (url: string, init: RequestInit) => Promise<Response> = fetch,
  ) {
    const issuer = endpoint(config.issuer);
    const introspection = endpoint(config.introspectionEndpoint);
    const backend = endpoint(config.supabaseUrl);
    endpoint(config.resource);
    if (issuer.origin !== introspection.origin || backend.pathname !== '/')
      throw new Error('Invalid authorization endpoint');
    for (const value of [
      config.project,
      config.introspectionClientId,
      config.introspectionClientSecret,
      config.serviceRoleKey,
    ])
      if (!value.trim()) throw new Error('Missing authorization configuration');
    this.config = {
      ...config,
      supabaseUrl: backend.origin,
      scopes: z.array(scope).parse([...config.scopes]),
    };
  }

  private async json(url: string, init: RequestInit): Promise<unknown> {
    const response = await this.request(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    });
    if (!response.ok) throw new Error('Authorization request failed');
    return response.json();
  }

  private async resolve(token: string) {
    if (!token || token.length > 16384 || /\s/.test(token)) throw new Error('Invalid token');
    const c = this.config;
    const verified = claims.parse(
      await this.json(c.introspectionEndpoint, {
        method: 'POST',
        body: new URLSearchParams({
          token,
          token_type_hint: 'access_token',
          client_id: c.introspectionClientId,
          client_secret: c.introspectionClientSecret,
        }),
      }),
    );
    const now = Math.floor(Date.now() / 1000);
    if (
      verified.iss !== c.issuer ||
      !(Array.isArray(verified.aud) ? verified.aud : [verified.aud]).includes(c.resource) ||
      verified.exp <= now ||
      (verified.nbf !== undefined && verified.nbf > now)
    )
      throw new Error('Invalid token');
    const binding = {
      issuer: verified.iss,
      subject: verified.sub,
      client_id: verified.client_id,
      resource: c.resource,
      project: c.project,
      session_id: verified.sid,
    };
    const approved = grant.parse(
      await this.json(`${c.supabaseUrl}/rest/v1/rpc/mcp_grant_command`, {
        method: 'POST',
        headers: {
          apikey: c.serviceRoleKey,
          Authorization: `Bearer ${c.serviceRoleKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ p_action: 'resolve', p_binding: binding }),
      }),
    );
    // Expiry can pass while the grant lookup is in flight.
    if (verified.exp <= Math.floor(Date.now() / 1000)) throw new Error('Expired token');
    const tokenScopes = verified.scope.split(' ');
    return {
      grantId: approved.id,
      expectedUserId: approved.user_id,
      scopes: c.scopes.filter((s) => approved.scopes.includes(s) && tokenScopes.includes(s)),
    };
  }

  async authorize(token: string): Promise<{
    grantId: string;
    expectedUserId: string;
    authorization: ToolAuthorization;
  }> {
    try {
      const initial = await this.resolve(token);
      const initialScopes = [...initial.scopes];
      return {
        grantId: initial.grantId,
        expectedUserId: initial.expectedUserId,
        authorization: {
          scopes: Object.freeze([...initialScopes]),
          currentScopes: async () => {
            try {
              const current = await this.resolve(token);
              if (current.grantId !== initial.grantId || current.expectedUserId !== initial.expectedUserId)
                throw new Error('Changed authorization identity');
              return current.scopes.filter((s) => initialScopes.includes(s));
            } catch {
              throw new Error('AUTHORIZATION_DENIED');
            }
          },
        },
      };
    } catch {
      throw new Error('AUTHORIZATION_DENIED');
    }
  }
}
