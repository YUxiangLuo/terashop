import * as z from 'zod/v4';
import type { AdminScope, ToolAuthorization } from './permissions';
import { AdminBackend } from './backend';
import type { createCredentialCipher, DownstreamCredentials } from './credentials';

type CredentialCipher = Awaited<ReturnType<typeof createCredentialCipher>>;
const storedCredentials = z.union([
  z.strictObject({ revision: z.literal(0), envelope: z.null() }),
  z.strictObject({ revision: z.number().int().positive(), envelope: z.record(z.string(), z.unknown()) }),
]);

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
const oidcClaims = claims.omit({ typ: true, sid: true }).extend({
  token_type: z.literal('Bearer'),
  token_kind: z.literal('AccessToken'),
  sub: z.uuid(), // Our authorization service uses the verified Supabase UUID as subject.
  grant_id: text,
});
const grant = z.object({
  id: z.uuid(),
  user_id: z.uuid(),
  scopes: z.array(scope),
  state: z.literal('active'),
  version: z.literal(1),
});

export interface AuthorizationConfig {
  // Explicit trusted deployment choice, never selected from token contents.
  // Omission preserves the historical Keycloak experiment only.
  tokenProfile?: 'keycloak' | 'oidc-provider';
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
// These are two fixed introspection profiles, not generic OIDC discovery.
export class GrantAuthorizer {
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
      tokenProfile: z.enum(['keycloak', 'oidc-provider']).parse(config.tokenProfile ?? 'keycloak'),
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

  private rpc(
    name: 'mcp_grant_command' | 'mcp_credential_command' | 'mcp_bind_downstream_session',
    body: Record<string, unknown>,
  ) {
    return this.json(`${this.config.supabaseUrl}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        apikey: this.config.serviceRoleKey,
        Authorization: `Bearer ${this.config.serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  private async resolve(token: string) {
    if (!token || token.length > 16384 || /\s/.test(token)) throw new Error('Invalid token');
    const c = this.config;
    const response = await this.json(c.introspectionEndpoint, {
      method: 'POST',
      body: new URLSearchParams({
        token,
        token_type_hint: 'access_token',
        client_id: c.introspectionClientId,
        client_secret: c.introspectionClientSecret,
      }),
    });
    const verified = c.tokenProfile === 'oidc-provider' ? oidcClaims.parse(response) : claims.parse(response);
    const now = Math.floor(Date.now() / 1000);
    if (
      verified.iss !== c.issuer ||
      !(Array.isArray(verified.aud) ? verified.aud : [verified.aud]).includes(c.resource) ||
      (c.tokenProfile === 'oidc-provider' && Array.isArray(verified.aud) && verified.aud.length !== 1) ||
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
      // The database field denotes an upstream authorization epoch, not necessarily SSO sid.
      session_id: 'grant_id' in verified ? verified.grant_id : verified.sid,
    };
    const approved = grant.parse(
      await this.rpc('mcp_grant_command', { p_action: 'resolve', p_binding: binding }),
    );
    if (c.tokenProfile === 'oidc-provider' && approved.user_id !== verified.sub)
      throw new Error('Changed approved account');
    // Expiry can pass while the grant lookup is in flight.
    if (verified.exp <= Math.floor(Date.now() / 1000)) throw new Error('Expired token');
    const tokenScopes = verified.scope.split(' ');
    return {
      binding,
      tokenExpiresAt: verified.exp,
      grantId: approved.id,
      expectedUserId: approved.user_id,
      scopes: c.scopes.filter((s) => approved.scopes.includes(s) && tokenScopes.includes(s)),
    };
  }

  // Trusted-host API, never an MCP tool. No credential cache or automatic retry.
  async readCredentials(token: string, cipher: CredentialCipher) {
    try {
      const current = await this.resolve(token);
      const stored = storedCredentials.parse(
        await this.rpc('mcp_credential_command', {
          p_action: 'read',
          p_binding: current.binding,
          p_grant_id: current.grantId,
          p_user_id: current.expectedUserId,
        }),
      );
      const credentials =
        stored.envelope === null
          ? null
          : await cipher.open(
              {
                project: this.config.project,
                grantId: current.grantId,
                userId: current.expectedUserId,
                revision: stored.revision,
              },
              stored.envelope,
            );
      if (current.tokenExpiresAt <= Math.floor(Date.now() / 1000)) throw new Error('Expired token');
      return {
        grantId: current.grantId,
        expectedUserId: current.expectedUserId,
        revision: stored.revision,
        credentials,
      };
    } catch {
      throw new Error('CREDENTIAL_READ_FAILED');
    }
  }

  // The future trusted linking flow must prove ownership/consent and supply a
  // matched access/refresh pair. Auth verifies the access token, not that pair.
  async writeCredentials(
    token: string,
    cipher: CredentialCipher,
    input: {
      expectedRevision: number;
      credentials: DownstreamCredentials;
      anonKey: string;
    },
  ): Promise<{ revision: number }> {
    try {
      const expected = z
        .number()
        .int()
        .min(0)
        .max(Number.MAX_SAFE_INTEGER - 1)
        .parse(input.expectedRevision);
      const credentials = { ...input.credentials };
      const anonKey = input.anonKey;
      const current = await this.resolve(token);
      const envelope = await cipher.seal(
        {
          project: this.config.project,
          grantId: current.grantId,
          userId: current.expectedUserId,
          revision: expected + 1,
        },
        credentials,
      );
      const backend = new AdminBackend(
        {
          url: this.config.supabaseUrl,
          anonKey,
          accessToken: credentials.accessToken,
          expectedUserId: current.expectedUserId,
        },
        this.request,
      );
      const session = z
        .strictObject({ user_id: z.uuid(), session_id: z.uuid() })
        .parse(await backend.rpc('get_mcp_downstream_session', {}, false));
      if (session.user_id !== current.expectedUserId) throw new Error('Invalid downstream identity');
      if (current.tokenExpiresAt <= Math.floor(Date.now() / 1000)) throw new Error('Expired token');
      const bound = z.strictObject({ grant_id: z.uuid(), session_id: z.uuid() }).parse(
        await this.rpc('mcp_bind_downstream_session', {
          p_binding: current.binding,
          p_grant_id: current.grantId,
          p_user_id: current.expectedUserId,
          p_session_id: session.session_id,
        }),
      );
      if (bound.grant_id !== current.grantId || bound.session_id !== session.session_id)
        throw new Error('Invalid session binding');
      if (current.tokenExpiresAt <= Math.floor(Date.now() / 1000)) throw new Error('Expired token');
      const stored = storedCredentials.parse(
        await this.rpc('mcp_credential_command', {
          p_action: 'write',
          p_binding: current.binding,
          p_grant_id: current.grantId,
          p_user_id: current.expectedUserId,
          p_expected_revision: expected,
          p_envelope: envelope,
        }),
      );
      if (
        stored.revision !== expected + 1 ||
        stored.envelope === null ||
        Object.keys(stored.envelope).length !== 4 ||
        Object.entries(envelope).some(([key, value]) => stored.envelope?.[key] !== value)
      )
        throw new Error('Invalid write response');
      // A timeout or invalid response may follow a committed write. Always reread
      // after failure; never blindly repeat a refresh or credential write.
      return { revision: stored.revision };
    } catch {
      throw new Error('CREDENTIAL_WRITE_UNCONFIRMED');
    }
  }

  // Explicit host operation, never an automatic retry of a business request.
  // A lost claim/refresh/completion acknowledgement may require reauthorization.
  async refreshCredentials(
    token: string,
    cipher: CredentialCipher,
    input: { expectedRevision: number; anonKey: string },
  ): Promise<{ revision: number }> {
    try {
      const expected = z
        .number()
        .int()
        .min(1)
        .max(Number.MAX_SAFE_INTEGER - 1)
        .parse(input.expectedRevision);
      const anonKey = input.anonKey;
      if (!anonKey.trim()) throw new Error('Missing public key');
      const current = await this.resolve(token);
      const args = {
        p_binding: current.binding,
        p_grant_id: current.grantId,
        p_user_id: current.expectedUserId,
        p_expected_revision: expected,
      };
      const claimed = z
        .strictObject({
          revision: z.number().int().positive(),
          envelope: z.record(z.string(), z.unknown()),
          refresh_id: z.uuid(),
        })
        .parse(await this.rpc('mcp_credential_command', { ...args, p_action: 'claim_refresh' }));
      if (claimed.revision !== expected) throw new Error('Invalid refresh receipt');
      const context = {
        project: this.config.project,
        grantId: current.grantId,
        userId: current.expectedUserId,
        revision: expected,
      };
      const previous = await cipher.open(context, claimed.envelope);
      const recheck = async () => {
        const live = await this.resolve(token);
        if (live.grantId !== current.grantId || live.expectedUserId !== current.expectedUserId)
          throw new Error('Changed refresh identity');
      };
      await recheck();
      const credentialToken = z
        .string()
        .min(1)
        .max(16384)
        .regex(/^[\x21-\x7e]+$/);
      const result = z
        .object({
          access_token: credentialToken,
          refresh_token: credentialToken,
          token_type: z.literal('bearer'),
          expires_at: z.number().int().positive(),
          user: z.object({ id: z.uuid(), is_anonymous: z.literal(false) }),
        })
        .parse(
          await this.json(`${this.config.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
            method: 'POST',
            headers: { apikey: anonKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh_token: previous.refreshToken }),
          }),
        );
      if (result.user.id !== current.expectedUserId || result.expires_at <= Math.floor(Date.now() / 1000))
        throw new Error('Invalid refreshed identity');
      await recheck();
      const backend = new AdminBackend(
        {
          url: this.config.supabaseUrl,
          anonKey,
          accessToken: result.access_token,
          expectedUserId: current.expectedUserId,
        },
        this.request,
      );
      const session = z
        .strictObject({ user_id: z.uuid(), session_id: z.uuid() })
        .parse(await backend.rpc('get_mcp_downstream_session', {}, false));
      if (session.user_id !== current.expectedUserId) throw new Error('Invalid refreshed session');
      // Rebinding is idempotent ONLY for the original immutable session. A token
      // for the same administrator but another session must not replace it.
      const bound = z.strictObject({ grant_id: z.uuid(), session_id: z.uuid() }).parse(
        await this.rpc('mcp_bind_downstream_session', {
          p_binding: current.binding,
          p_grant_id: current.grantId,
          p_user_id: current.expectedUserId,
          p_session_id: session.session_id,
        }),
      );
      if (bound.grant_id !== current.grantId || bound.session_id !== session.session_id)
        throw new Error('Invalid refreshed binding');
      const envelope = await cipher.seal(
        { ...context, revision: expected + 1 },
        {
          accessToken: result.access_token,
          refreshToken: result.refresh_token,
          expiresAt: result.expires_at,
        },
      );
      await recheck();
      if (result.expires_at <= Math.floor(Date.now() / 1000)) throw new Error('Expired refreshed token');
      const stored = storedCredentials.parse(
        await this.rpc('mcp_credential_command', {
          ...args,
          p_action: 'complete_refresh',
          p_refresh_id: claimed.refresh_id,
          p_envelope: envelope,
        }),
      );
      if (
        stored.revision !== expected + 1 ||
        stored.envelope === null ||
        Object.keys(stored.envelope).length !== 4 ||
        Object.entries(envelope).some(([key, value]) => stored.envelope?.[key] !== value)
      )
        throw new Error('Invalid refresh completion');
      // Return only a receipt. Subsequent use must reread through online authorization.
      return { revision: stored.revision };
    } catch {
      // Never clear a pending claim or replay the provider request. Reread first;
      // if still pending/unrecoverable, revoke and establish a new authorization.
      throw new Error('CREDENTIAL_REFRESH_UNCONFIRMED');
    }
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

// Preserve existing Keycloak fixtures while new hosts select the explicit OIDC profile.
export { GrantAuthorizer as KeycloakGrantAuthorizer };
