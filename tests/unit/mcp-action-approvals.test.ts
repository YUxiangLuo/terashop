import { expect, test } from 'bun:test';
import { createActionApprovalHost, ApprovalRequired } from '../../mcp/src/action-approvals';
import { actionApprovals, approvalResource } from '../../admin/src/lib/mcp-action-approvals';
import { AdminBackend } from '../../mcp/src/backend';
import { mcpSession } from '../support/mcp';

const config = {
  issuer: 'https://auth.example',
  resource: 'https://mcp.example/mcp',
  project: 'shop',
  supabaseUrl: 'https://db.example/',
  serviceRoleKey: 'secret',
  scopes: [],
  introspectionEndpoint: 'https://auth.example/introspect',
  introspectionClientId: 'test',
  introspectionClientSecret: 'unused',
};
const identity = { grantId: crypto.randomUUID(), expectedUserId: crypto.randomUUID() };
test('remote sensitive SDK tool stages before execution and uses atomic approved result, not legacy RPC', async () => {
  const userId = crypto.randomUUID();
  let stages = 0, consumes = 0, ordinaryDispatches = 0;
  const profile = { id: userId, email: 'synthetic@example.test', role: 'admin', created_at: '2026-09-24T00:00:00Z', updated_at: '2026-09-24T00:00:00Z' };
  const host = createActionApprovalHost(config, identity, async (_url, init) => {
    const body = JSON.parse(String(init.body));
    if (body.p_action === 'stage') stages++; else consumes++;
    expect(body.p_arguments).toEqual({ user_id: userId, role: 'admin' });
    return Response.json({ id: body.p_approval_id, state: body.p_action === 'stage' ? 'pending' : 'consumed', ...(body.p_action === 'consume' ? { result: profile } : {}) });
  });
  const backend = new AdminBackend({ url: config.supabaseUrl, anonKey: 'public', accessToken: 'user' }, async (url) => {
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: identity.expectedUserId, role: 'authenticated', is_anonymous: false });
    if (url.endsWith('/is_admin')) return Response.json(true);
    ordinaryDispatches++; return Response.json(profile);
  });
  const session = await mcpSession(backend, true, undefined, undefined, undefined, host);
  try {
    const first = await session.client.callTool({ name: 'set_user_role', arguments: { user_id: userId, role: 'admin' } });
    expect(first.isError).toBe(true);
    const receipt = JSON.parse((first.content[0] as { text: string }).text);
    expect(receipt.code).toBe('HUMAN_APPROVAL_REQUIRED');
    expect(ordinaryDispatches).toBe(0);
    const second = await session.client.callTool({ name: 'set_user_role', arguments: { user_id: userId, role: 'admin', approval_id: receipt.approval_id } });
    expect(second.isError).not.toBe(true);
    expect(second.structuredContent).toEqual({ data: profile });
    expect([stages, consumes, ordinaryDispatches]).toEqual([1, 1, 0]);
    expect((await session.client.listTools()).tools.some((tool) => tool.name.includes('decide'))).toBe(false);
  } finally { await session.close(); }
});
test('approval staging has no mutation, strips approval ID, validates bound receipt, never retries', async () => {
  const calls: any[] = [];
  let bad = false;
  const host = createActionApprovalHost(config, identity, async (url, init) => {
    expect(url).toBe('https://db.example/rest/v1/rpc/mcp_action_approval_command');
    expect(init.redirect).toBe('error');
    expect(init.cache).toBe('no-store');
    const body = JSON.parse(String(init.body));
    calls.push(body);
    return Response.json({
      id: bad ? crypto.randomUUID() : body.p_approval_id,
      state: body.p_action === 'stage' ? 'pending' : 'consumed',
      ...(body.p_action === 'consume' ? { result: { role: 'admin' } } : {}),
    });
  });
  const args = { user_id: crypto.randomUUID(), role: 'admin' };
  await expect(host('set_user_role', args)).rejects.toBeInstanceOf(ApprovalRequired);
  expect(calls).toHaveLength(1);
  const result = await host('set_user_role', { ...args, approval_id: calls[0].p_approval_id });
  expect(result).toMatchObject({ args, executed: true, result: { role: 'admin' } });
  expect(calls[1].p_arguments).toEqual(args);
  bad = true;
  await expect(host('set_user_role', { ...args, approval_id: calls[0].p_approval_id })).rejects.toMatchObject(
    { outcomeUnknown: true },
  );
  expect(calls).toHaveLength(3);
  expect(await host('get_admin_product', { product_id: args.user_id })).toEqual({
    args: { product_id: args.user_id },
  });
  expect(calls).toHaveLength(3);
});
test('human approval list validates receipts and links only recognized business IDs', () => {
  const id = crypto.randomUUID();
  const row = {
    id,
    tool_name: 'refund_paypal',
    arguments: { order_id: id },
    client_id: 'untrusted <script>',
    resource: 'https://mcp.example/mcp',
    state: 'pending',
    created_at: '2026-09-24T00:00:00Z',
    expires_at: '2026-09-24T00:15:00Z',
  };
  expect(approvalResource(actionApprovals([row])[0])).toBe(`/orders/${id}`);
  for (const bad of [null, [null], [{ ...row, state: 'done' }], [{ ...row, expires_at: 'bad' }]])
    expect(() => actionApprovals(bad)).toThrow();
  expect(approvalResource({ ...row, arguments: { order_id: '../settings?execute=yes' } })).toBeNull();
});
