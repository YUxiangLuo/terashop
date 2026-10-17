import type { AuthorizationConfig } from './authorization';
import { BackendError } from './backend';
import * as z from 'zod/v4';
import { readBackendJson } from './backend-response';

const HIGH_RISK = new Set([
  'refund_paypal',
  'commit_manual_refund',
  'anonymize_customer',
]);

export class ApprovalRequired extends Error {
  constructor(readonly approvalId: string) {
    super('HUMAN_APPROVAL_REQUIRED');
  }
}

export function createActionApprovalHost(
  config: AuthorizationConfig,
  identity: { grantId: string; expectedUserId: string },
  request: (url: string, init: RequestInit) => Promise<Response> = fetch,
) {
  const command = async (body: Record<string, unknown>) => {
    let response: Response;
    try {
      response = await request(
        `${new URL(config.supabaseUrl).origin}/rest/v1/rpc/mcp_action_approval_command`,
        {
          method: 'POST',
          signal: AbortSignal.timeout(15_000),
          redirect: 'error',
          cache: 'no-store',
          headers: {
            apikey: config.serviceRoleKey,
            Authorization: `Bearer ${config.serviceRoleKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            ...body,
            p_grant_id: identity.grantId,
            p_user_id: identity.expectedUserId,
            p_issuer: config.issuer,
            p_resource: config.resource,
            p_project: config.project,
          }),
        },
      );
    } catch {
      throw new BackendError('APPROVAL_OUTCOME_UNKNOWN', true);
    }
    if (!response.ok)
      throw new BackendError(
        response.status >= 500 ? 'APPROVAL_OUTCOME_UNKNOWN' : 'APPROVAL_REJECTED',
        response.status >= 500,
      );
    try {
      const receipt = z
        .strictObject({
          id: z.uuid(),
          state: z.enum(['pending', 'consuming', 'consumed']),
          result: z.json().optional(),
        })
        .parse(await readBackendJson(response));
      const expected =
        body.p_action === 'stage'
          ? 'pending'
          : body.p_action === 'finish' ||
              body.p_tool_name === 'anonymize_customer'
            ? 'consumed'
            : 'consuming';
      if (receipt.id !== body.p_approval_id || receipt.state !== expected) throw Error('Invalid receipt');
      return receipt;
    } catch {
      throw new BackendError('APPROVAL_OUTCOME_UNKNOWN', true);
    }
  };
  return async (tool: string, raw: Record<string, unknown>) => {
    if (!HIGH_RISK.has(tool)) return { args: raw };
    const { approval_id, ...args } = raw;
    if (approval_id === undefined) {
      const staged = await command({
        p_action: 'stage',
        p_approval_id: crypto.randomUUID(),
        p_tool_name: tool,
        p_arguments: args,
      });
      throw new ApprovalRequired(staged.id);
    }
    const consumed = await command({
      p_action: 'consume',
      p_approval_id: approval_id,
      p_tool_name: tool,
      p_arguments: args,
    });
    const executed = tool === 'anonymize_customer';
    return {
      args,
      result: consumed.result,
      executed,
      finalize: executed
        ? undefined
        : async () => {
            try {
              await command({
                p_action: 'finish',
                p_approval_id: approval_id,
                p_tool_name: tool,
                p_arguments: args,
              });
            } catch {
              throw new BackendError('APPROVAL_COMPLETION_UNCONFIRMED', true);
            }
          },
    };
  };
}
export type ActionApprovalHost = ReturnType<typeof createActionApprovalHost>;
