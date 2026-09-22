import type postgres from 'postgres';
import * as z from 'zod/v4';
import { createOidcAdapter } from './oidc-adapter';
import { createOidcApprovalJournal } from './oidc-journal';

const receipt = z.union([
  z.strictObject({
    id: z.uuid(),
    user_id: z.uuid(),
    scopes: z.array(z.string()),
    state: z.literal('revoked'),
    version: z.literal(2),
  }),
  z.strictObject({
    id: z.null(),
    user_id: z.null(),
    scopes: z.array(z.never()).length(0),
    state: z.literal('revoked'),
    version: z.literal(2),
  }),
]);

// Internal startup primitive, not a tool/HTTP endpoint.
// Caller must exclude live approvals and hold issuer ownership for the entire run.
// Never resume issuance: uncertain attempts are revoked on both sides. A failed run
// may have committed either revocation; restart from the beginning, not a saved cursor.
export async function recoverOidcApprovals(
  database: postgres.Sql,
  config: { issuer: string; resource: string; project: string; supabaseUrl: string; serviceRoleKey: string },
  request: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<number> {
  try {
    const c = { ...config };
    const origin = new URL(c.supabaseUrl);
    if (
      origin.pathname !== '/' ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      (origin.protocol !== 'https:' &&
        !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) ||
      !c.serviceRoleKey.trim() ||
      !c.project.trim() ||
      !c.issuer ||
      !c.resource
    )
      throw new Error('Invalid recovery configuration');
    const journal = createOidcApprovalJournal(database);
    const Adapter = createOidcAdapter(database);
    const grants = new Adapter('Grant');
    let after = '',
      recovered = 0;
    for (;;) {
      const entries = await journal.pending(after);
      if (!entries.length) return recovered;
      for (const entry of entries) {
        const binding = entry.binding;
        // Never send another deployment's identity to this downstream backend.
        if (binding.issuer !== c.issuer || binding.resource !== c.resource || binding.project !== c.project)
          throw new Error('Recovery binding mismatch');
        // destroy persists a tombstone even for absent/expired upstream Grants.
        await grants.destroy(binding.session_id);
        const response = await request(`${origin.origin}/rest/v1/rpc/mcp_grant_command`, {
          method: 'POST',
          headers: {
            apikey: c.serviceRoleKey,
            Authorization: `Bearer ${c.serviceRoleKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ p_action: 'revoke_binding', p_binding: binding }),
          redirect: 'error',
          cache: 'no-store',
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error('Unconfirmed revocation');
        const revoked = receipt.parse(await response.json());
        if (revoked.user_id !== null && revoked.user_id !== binding.subject)
          throw new Error('Recovery identity mismatch');
        await journal.finish(entry.interactionId, 'revoked');
        recovered++;
        after = entry.interactionId;
      }
    }
  } catch {
    // No tokens, identity bindings, SQL or backend response text in errors.
    throw new Error('OIDC_RECOVERY_UNCONFIRMED');
  }
}
