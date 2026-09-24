import * as z from 'zod/v4';
import { randomBytes } from 'node:crypto';
import type Provider from 'oidc-provider';
import { AdminBackend } from './backend';
import type { createCredentialCipher } from './credentials';
import type { createDownstreamLogin } from './login';
import type { AdminScope } from './permissions';
import type { createOidcApprovalJournal } from './oidc-journal';
import { readBackendJson } from './backend-response';
import { adminScopes } from '../../shared/admin-contracts';

type Identity = Awaited<ReturnType<Awaited<ReturnType<typeof createDownstreamLogin>>['exchange']>>;
type Cipher = Awaited<ReturnType<typeof createCredentialCipher>>;
const scopesSchema = z.array(z.enum(adminScopes)).min(1).max(5);

// Internal, one-shot approval for ONE verified provider interaction. No HTTP/tool entrypoint.
// The host must bind client/scopes to that interaction, show consent, and obtain identity
// only from login.takeIdentity(original browser POST). Never accept these from a tool/body.
// Call interactionFinished only after approve succeeds; failure means no code may be issued.
export function createOidcApproval(
  provider: Provider,
  config: {
    resource: string;
    project: string;
    clientId: string;
    scopes: readonly AdminScope[];
    supabaseUrl: string;
    anonKey: string;
    serviceRoleKey: string;
  },
  cipher: Cipher,
  request: (url: string, init: RequestInit) => Promise<Response> = fetch,
  journal?: { interactionId: string; store: ReturnType<typeof createOidcApprovalJournal> },
) {
  const c = { ...config, scopes: [...new Set(scopesSchema.parse(config.scopes))].sort() };
  for (const value of [c.project, c.clientId, c.anonKey, c.serviceRoleKey])
    if (!value.trim()) throw new Error('INVALID_APPROVAL_CONFIGURATION');
  for (const value of [provider.issuer, c.resource, c.supabaseUrl]) {
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    )
      throw new Error('INVALID_APPROVAL_CONFIGURATION');
  }
  const origin = new URL(c.supabaseUrl).origin;
  if (new URL(c.supabaseUrl).pathname !== '/') throw new Error('INVALID_APPROVAL_CONFIGURATION');
  async function rpc(name: string, body: Record<string, unknown>) {
    const response = await request(`${origin}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        apikey: c.serviceRoleKey,
        Authorization: `Bearer ${c.serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error('Approval persistence failed');
    return z.record(z.string(), z.unknown()).parse(await readBackendJson(response));
  }
  let used = false;
  let completedCleanup: (() => Promise<void>) | undefined;
  return {
    // Host completion can fail after persistence succeeds. Never retry completion
    // or reuse the identity; revoke both grants before reporting a failed attempt.
    async revoke(): Promise<void> {
      if (!completedCleanup) throw new Error('APPROVAL_NOT_COMPLETED');
      await completedCleanup();
    },
    async approve(input: Identity): Promise<{ providerGrantId: string; grantId: string }> {
      if (used) throw new Error('APPROVAL_ALREADY_ATTEMPTED');
      used = true; // Includes failed/unknown attempts; never reuse a login credential pair.
      let upstream: InstanceType<Provider['Grant']> | undefined;
      let binding: Record<string, string> | undefined;
      let grantId: string | undefined;
      let localCreateAttempted = false;
      let journalAttempted = false;
      let journalStarted = false;
      async function cleanup() {
        let failed = false;
        try {
          await upstream?.destroy();
        } catch {
          failed = true;
        }
        if (binding && localCreateAttempted) {
          try {
            const revoked = await rpc('mcp_grant_command', {
              p_action: grantId ? 'revoke' : 'revoke_binding',
              p_binding: binding,
              ...(grantId ? { p_grant_id: grantId } : {}),
            });
            const fencedAbsent =
              !grantId &&
              revoked.id === null &&
              revoked.user_id === null &&
              Array.isArray(revoked.scopes) &&
              revoked.scopes.length === 0;
            if (
              (!fencedAbsent &&
                (!z.uuid().safeParse(revoked.id).success ||
                  (grantId && revoked.id !== grantId) ||
                  revoked.user_id !== input.userId)) ||
              revoked.state !== 'revoked' ||
              revoked.version !== 2
            )
              throw new Error('Invalid revocation receipt');
          } catch {
            failed = true;
          }
        }
        if (!failed && journalAttempted) {
          try {
            if (!journalStarted) throw new Error('Unconfirmed journal creation');
            await journal!.store.finish(journal!.interactionId, 'revoked');
          } catch {
            failed = true;
          }
        }
        if (failed) throw new Error('APPROVAL_CLEANUP_UNCONFIRMED');
      }
      try {
        const userId = z.uuid().parse(input.userId),
          sessionId = z.uuid().parse(input.sessionId);
        const credentials = { ...input.credentials };
        const assertFresh = () => {
          if (
            !Number.isSafeInteger(credentials.expiresAt) ||
            credentials.expiresAt <= Math.floor(Date.now() / 1000)
          )
            throw new Error('Expired login');
        };
        assertFresh();
        const backend = new AdminBackend(
          { url: origin, anonKey: c.anonKey, accessToken: credentials.accessToken, expectedUserId: userId },
          request,
        );
        const session = z
          .strictObject({ user_id: z.uuid(), session_id: z.uuid() })
          .parse(await backend.rpc('get_mcp_downstream_session', {}, false));
        if (session.user_id !== userId || session.session_id !== sessionId)
          throw new Error('Changed login session');
        assertFresh();
        upstream = new provider.Grant({ accountId: userId, clientId: c.clientId });
        // v9.12.2 normally allocates jti in save(). Preallocate a host-only ID so
        // durable recovery metadata precedes the first provider persistence.
        const providerGrantId = randomBytes(32).toString('base64url');
        upstream.jti = providerGrantId;
        upstream.addResourceScope(c.resource, c.scopes.join(' '));
        // OIDC protocol scopes are not store permissions. This flow supports offline refresh.
        upstream.addOIDCScope('openid offline_access');
        const approvedBinding = {
          issuer: provider.issuer,
          subject: userId,
          client_id: c.clientId,
          resource: c.resource,
          project: c.project,
          session_id: providerGrantId,
        };
        binding = approvedBinding;
        if (journal) {
          journalAttempted = true;
          await journal.store.begin({ interactionId: journal.interactionId, binding: approvedBinding });
          journalStarted = true;
        }
        if ((await upstream.save()) !== providerGrantId) throw new Error('Changed provider grant identity');
        localCreateAttempted = true;
        const approved = z
          .object({
            id: z.uuid(),
            user_id: z.uuid(),
            scopes: scopesSchema,
            state: z.literal('active'),
            version: z.literal(1),
          })
          .parse(
            await rpc('mcp_grant_command', {
              p_action: 'create',
              p_binding: binding,
              p_user_id: userId,
              p_scopes: c.scopes,
            }),
          );
        grantId = approved.id;
        if (
          approved.user_id !== userId ||
          JSON.stringify([...approved.scopes].sort()) !== JSON.stringify(c.scopes)
        )
          throw new Error('Changed approval');
        const args = { p_binding: binding, p_grant_id: grantId, p_user_id: userId };
        const bound = z
          .strictObject({ grant_id: z.uuid(), session_id: z.uuid() })
          .parse(await rpc('mcp_bind_downstream_session', { ...args, p_session_id: sessionId }));
        if (bound.grant_id !== grantId || bound.session_id !== sessionId) throw new Error('Changed binding');
        assertFresh();
        const envelope = await cipher.seal({ project: c.project, grantId, userId, revision: 1 }, credentials);
        const stored = z
          .strictObject({ revision: z.literal(1), envelope: z.record(z.string(), z.unknown()) })
          .parse(
            await rpc('mcp_credential_command', {
              ...args,
              p_action: 'write',
              p_expected_revision: 0,
              p_envelope: envelope,
            }),
          );
        if (
          Object.keys(stored.envelope).length !== 4 ||
          Object.entries(envelope).some(([k, v]) => stored.envelope[k] !== v)
        )
          throw new Error('Changed credential receipt');
        assertFresh();
        // Recheck current administrator/grant after persistence, before allowing host completion.
        const current = await rpc('mcp_grant_command', { p_action: 'resolve', p_binding: binding });
        if (
          current.id !== grantId ||
          current.user_id !== userId ||
          current.state !== 'active' ||
          current.version !== 1
        )
          throw new Error('Approval revoked');
        assertFresh();
        if (!(await provider.Grant.find(providerGrantId))) throw new Error('Provider approval revoked');
        assertFresh();
        completedCleanup = cleanup;
        return { providerGrantId, grantId };
      } catch {
        // No token/code has been issued by this module. Revoke upstream even when
        // local create committed but its ID was lost. Cleanup is best-effort, not rollback.
        await cleanup();
        throw new Error('APPROVAL_UNCONFIRMED');
      }
    },
  };
}
