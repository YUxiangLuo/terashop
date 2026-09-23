import * as z from 'zod/v4';
import { readBackendJson } from './backend-response';

// One bounded batch. A lost acknowledgement leaves durable work for the next
// poll/restart. Revocation is monotonic; never clear tasks before the tombstone.
export async function cleanupOidcConnections(
  config: {
    issuer: string;
    resource: string;
    project: string;
    supabaseUrl: string;
    serviceRoleKey: string;
  },
  revoke: (upstreamGrantId: string) => Promise<void>,
  request: (url: string, init: RequestInit) => Promise<Response> = fetch,
  active: () => boolean = () => true,
): Promise<number> {
  try {
    const origin = new URL(config.supabaseUrl);
    if (
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash ||
      origin.username ||
      origin.password ||
      (origin.protocol !== 'https:' &&
        !(
          origin.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
        ))
    )
      throw new Error('Invalid backend');
    const rpc = async (action: 'list' | 'complete', id?: string) => {
      if (!active()) throw new Error('Service closing');
      const response = await request(
        `${origin.origin}/rest/v1/rpc/mcp_connection_cleanup_command`,
        {
          method: 'POST',
          headers: {
            apikey: config.serviceRoleKey,
            Authorization: `Bearer ${config.serviceRoleKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            p_action: action,
            p_issuer: config.issuer,
            p_resource: config.resource,
            p_project: config.project,
            ...(id ? { p_grant_id: id } : {}),
          }),
          redirect: 'error',
          cache: 'no-store',
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) throw new Error('Unconfirmed cleanup');
      return readBackendJson(response);
    };
    const entries = z
      .array(
        z.strictObject({
          id: z.uuid(),
          upstream_grant_id: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),
        }),
      )
      .max(20)
      .parse(await rpc('list'));
    for (const entry of entries) {
      if (!active()) throw new Error('Service closing');
      await revoke(entry.upstream_grant_id);
      const receipt = z
        .strictObject({ id: z.uuid(), cleanup: z.literal('completed') })
        .parse(await rpc('complete', entry.id));
      if (receipt.id !== entry.id) throw new Error('Changed receipt');
    }
    return entries.length;
  } catch {
    throw new Error('OIDC_CONNECTION_CLEANUP_UNCONFIRMED');
  }
}
