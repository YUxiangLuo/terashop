import * as z from 'zod/v4';
import type { AuthorizationConfig } from './authorization';
import { readBackendJson } from './backend-response';
import { auditResourceRef } from './audit-resource-ref';

export type AuditOutcome = 'returned' | 'rejected' | 'unknown';
export type ToolAudit = (
  tool: string,
  mutation: boolean,
  context?: unknown,
) => Promise<(outcome: AuditOutcome) => Promise<void>>;

// Config/identity come only from the verified remote host, never tool arguments.
export function createToolAudit(
  config: AuthorizationConfig,
  identity: { grantId: string; expectedUserId: string },
  request: (url: string, init: RequestInit) => Promise<Response>,
): ToolAudit {
  const endpoint = `${new URL(config.supabaseUrl).origin}/rest/v1/rpc/mcp_tool_audit_command`;
  const binding = {
    p_grant_id: identity.grantId,
    p_user_id: identity.expectedUserId,
    p_issuer: config.issuer,
    p_resource: config.resource,
    p_project: config.project,
  };
  return async (tool, mutation, context) => {
    const id = crypto.randomUUID();
    const resource = auditResourceRef(tool, context);
    const command = async (body: Record<string, unknown>, outcome: string) => {
      const response = await request(endpoint, {
        method: 'POST',
        headers: {
          apikey: config.serviceRoleKey,
          Authorization: `Bearer ${config.serviceRoleKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ...binding, p_id: id, ...body }),
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error('AUDIT_UNCONFIRMED');
      const receipt = z
        .strictObject({ id: z.uuid(), outcome: z.string() })
        .parse(await readBackendJson(response));
      if (receipt.id !== id || receipt.outcome !== outcome) throw new Error('AUDIT_UNCONFIRMED');
    };
    await command(
      {
        p_action: 'begin',
        p_tool_name: tool,
        p_mutation: mutation,
        ...(resource ? { p_resource_type: resource.resourceType, p_resource_id: resource.resourceId } : {}),
      },
      'pending',
    );
    return (outcome) => command({ p_action: 'finish', p_outcome: outcome }, outcome);
  };
}
