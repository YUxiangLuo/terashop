import { afterAll, expect, test } from 'bun:test';
import { checked, rpc, signup, makeAdmin, API, SERVICE_KEY } from './helpers';
import { testDatabase } from './database-concurrency';
import { createToolAudit } from '../mcp/src/tool-audit';

const db = testDatabase();
const extraIds = new Set<string>();
const binding = {
  issuer: 'https://auth.example',
  resource: 'https://shop.example/mcp',
  project: 'audit-test',
  subject: crypto.randomUUID(),
  session_id: crypto.randomUUID(),
  client_id: 'verified-agent',
};
afterAll(async () => {
  try {
    await db`delete from private.mcp_tool_audit where project=${binding.project} and grant_id in (select id from private.mcp_grants where binding=${JSON.stringify(binding)}::text::jsonb)`;
    await db`delete from private.mcp_tool_audit where id=${auditId}::uuid`;
    for (const id of extraIds) await db`delete from private.mcp_tool_audit where id=${id}::uuid`;
    await db`delete from private.mcp_grants where binding=${JSON.stringify(binding)}::text::jsonb`;
    await db`delete from private.mcp_grant_fences where binding=${JSON.stringify(binding)}::text::jsonb`;
  } finally {
    await db.close();
  }
});
const auditId = crypto.randomUUID();

test('audit admission binds trusted identity; terminal observations survive grant removal and cannot be rewritten', async () => {
  const user = await signup();
  await makeAdmin(user.userId);
  const grant = await checked<{ id: string }>(
    rpc(
      'mcp_grant_command',
      {
        p_action: 'create',
        p_binding: binding,
        p_user_id: user.userId,
        p_scopes: ['store:read'],
      },
      undefined,
      true,
    ),
  );
  const args = {
    p_id: auditId,
    p_grant_id: grant.id,
    p_user_id: user.userId,
    p_issuer: binding.issuer,
    p_resource: binding.resource,
    p_project: binding.project,
  };
  const begin = { ...args, p_action: 'begin', p_tool_name: 'get_admin_product', p_mutation: false };
  for (const token of [undefined, user.token])
    expect((await rpc('mcp_tool_audit_command', begin, token)).data).toMatchObject({ code: '42501' });
  for (const role of ['anon', 'authenticated', 'service_role']) {
    const [row] =
      await db`select has_table_privilege(${role},'private.mcp_tool_audit','SELECT,INSERT,UPDATE,DELETE') as allowed`;
    expect(row.allowed).toBe(false);
  }
  for (const invalid of [{ p_user_id: crypto.randomUUID() }, { p_resource: 'https://other.example/mcp' }])
    expect(
      (await rpc('mcp_tool_audit_command', { ...begin, ...invalid }, undefined, true)).data,
    ).toMatchObject({ code: '42501' });
  expect(
    await checked<{ id: string; outcome: string }>(rpc('mcp_tool_audit_command', begin, undefined, true)),
  ).toEqual({
    id: auditId,
    outcome: 'pending',
  });
  expect((await rpc('mcp_tool_audit_command', begin, undefined, true)).data).toMatchObject({ code: '23505' });
  const [pending] = await db`select * from private.mcp_tool_audit where id=${auditId}::uuid`;
  expect(pending).toMatchObject({
    user_id: user.userId,
    grant_id: grant.id,
    client_id: 'verified-agent',
    tool_name: 'get_admin_product',
    mutation: false,
    outcome: 'pending',
    finished_at: null,
  });
  // Drop real committed RPC receipts, not simulated database responses.
  for (const lost of ['begin', 'finish']) {
    let writtenId = '';
    let calls = 0;
    const audit = createToolAudit(
      {
        ...binding,
        supabaseUrl: API,
        serviceRoleKey: SERVICE_KEY,
        scopes: ['store:read'],
        introspectionEndpoint: `${binding.issuer}/introspect`,
        introspectionClientId: 'test',
        introspectionClientSecret: 'unused',
      },
      { grantId: grant.id, expectedUserId: user.userId },
      async (url, init) => {
        const body = JSON.parse(String(init.body));
        writtenId = body.p_id;
        extraIds.add(writtenId);
        calls++;
        const response = await fetch(url, init);
        expect(response.status).toBe(200);
        if (body.p_action === lost) {
          await response.arrayBuffer();
          throw Error('receipt discarded after commit');
        }
        return response;
      },
    );
    if (lost === 'begin')
      await expect(audit('get_admin_product', false)).rejects.toThrow('receipt discarded');
    else {
      const finish = await audit('get_admin_product', false);
      await expect(finish('returned')).rejects.toThrow('receipt discarded');
    }
    expect(calls).toBe(lost === 'begin' ? 1 : 2);
    const [row] = await db`select outcome from private.mcp_tool_audit where id=${writtenId}::uuid`;
    expect(row.outcome).toBe(lost === 'begin' ? 'pending' : 'returned');
  }
  await checked(
    rpc(
      'mcp_grant_command',
      { p_action: 'revoke', p_binding: binding, p_grant_id: grant.id },
      undefined,
      true,
    ),
  );
  expect(
    (await rpc('mcp_tool_audit_command', { ...begin, p_id: crypto.randomUUID() }, undefined, true)).data,
  ).toMatchObject({ code: '42501' });
  await db`delete from private.mcp_grants where id=${grant.id}::uuid`;
  const finish = { ...args, p_action: 'finish', p_outcome: 'returned' };
  expect(
    (await rpc('mcp_tool_audit_command', { ...finish, p_user_id: crypto.randomUUID() }, undefined, true))
      .data,
  ).toMatchObject({ code: 'PT404' });
  expect(
    await checked<{ id: string; outcome: string }>(rpc('mcp_tool_audit_command', finish, undefined, true)),
  ).toEqual({
    id: auditId,
    outcome: 'returned',
  });
  const [first] = await db`select finished_at::text from private.mcp_tool_audit where id=${auditId}::uuid`;
  await checked(rpc('mcp_tool_audit_command', finish, undefined, true));
  expect(
    (await rpc('mcp_tool_audit_command', { ...finish, p_outcome: 'rejected' }, undefined, true)).data,
  ).toMatchObject({ code: 'PT409' });
  const [last] =
    await db`select finished_at::text,outcome from private.mcp_tool_audit where id=${auditId}::uuid`;
  expect(last).toEqual({ ...first, outcome: 'returned' });
});
