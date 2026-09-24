import { afterAll, expect, test } from 'bun:test';
import { checked, rpc, signup, makeAdmin, API, SERVICE_KEY } from './helpers';
import { heldTransactionRace, testDatabase } from './database-concurrency';
import { createActionApprovalHost } from '../mcp/src/action-approvals';

const db = testDatabase();
const project = `approvals-${crypto.randomUUID()}`;
afterAll(async () => {
  await db`delete from private.mcp_action_approvals where project=${project}`;
  await db`delete from private.mcp_grants where binding->>'project'=${project}`;
  await db`delete from private.mcp_grant_fences where binding->>'project'=${project}`;
  await db.close();
});

test('human approval binds identity, exact arguments, expiry, state and single dispatch', async () => {
  const owner = await signup(),
    other = await signup(),
    target = await signup();
  await makeAdmin(owner.userId);
  await makeAdmin(other.userId);
  const binding = {
    issuer: 'https://auth.example',
    resource: 'https://mcp.example/mcp',
    project,
    subject: owner.userId,
    session_id: crypto.randomUUID(),
    client_id: 'test-agent',
  };
  const grant = await checked<{ id: string }>(
    rpc(
      'mcp_grant_command',
      {
        p_action: 'create',
        p_binding: binding,
        p_user_id: owner.userId,
        p_scopes: ['store:read', 'store:write', 'store:access', 'store:privacy', 'store:payments'],
      },
      undefined,
      true,
    ),
  );
  const base = {
    p_grant_id: grant.id,
    p_user_id: owner.userId,
    p_issuer: binding.issuer,
    p_resource: binding.resource,
    p_project: project,
    p_tool_name: 'set_user_role',
    p_arguments: { user_id: target.userId, role: 'admin' },
  };
  const invoke = (args: object) => rpc('mcp_action_approval_command', { ...base, ...args }, undefined, true);
  const stage = async (extra = {}) => {
    const id = crypto.randomUUID();
    expect(
      await checked<{ id: string; state: string }>(
        invoke({ p_action: 'stage', p_approval_id: id, ...extra }),
      ),
    ).toEqual({ id, state: 'pending' });
    return id;
  };
  const decide = (id: string, decision = 'approved', token = owner.token) =>
    rpc('decide_my_mcp_action_approval', { p_id: id, p_decision: decision }, token);
  const consume = (id: string, extra = {}) => invoke({ p_action: 'consume', p_approval_id: id, ...extra });
  const id = await stage();
  expect(
    (
      await rpc(
        'mcp_action_approval_command',
        { ...base, p_action: 'consume', p_approval_id: id },
        owner.token,
      )
    ).status,
  ).toBe(403);
  expect((await consume(id)).status).toBe(409);
  expect((await decide(id, 'approved', other.token)).status).toBe(409);
  expect(await checked<unknown[]>(rpc('list_my_mcp_action_approvals', {}, other.token))).toEqual([]);
  const rows = await checked<any[]>(rpc('list_my_mcp_action_approvals', {}, owner.token));
  expect(rows.find((row) => row.id === id)).toMatchObject({ arguments: base.p_arguments, state: 'pending' });
  expect(rows[0]).not.toHaveProperty('snapshot');
  expect(await checked<unknown[]>(rpc('list_my_mcp_action_approvals', { p_id: id }, other.token))).toEqual([]);
  expect(await checked<unknown[]>(rpc('list_my_mcp_action_approvals', { p_id: id }, owner.token))).toHaveLength(1);
  await checked(decide(id));
  expect((await consume(id, { p_arguments: { ...base.p_arguments, role: 'customer' } })).status).toBe(409);
  expect((await consume(id, { p_user_id: other.userId })).status).toBe(403);
  const concurrent = await Promise.all([consume(id), consume(id)]);
  expect(concurrent.map((r) => r.status).sort()).toEqual([200, 409]);
  expect((concurrent.find((r) => r.status === 200)!.data as any).result.role).toBe('admin');
  expect((await consume(id)).status).toBe(409);

  const rejected = await stage();
  await checked(decide(rejected, 'rejected'));
  expect((await consume(rejected)).status).toBe(409);
  const expired = await stage();
  await checked(decide(expired));
  await db`update private.mcp_action_approvals set expires_at=now()-interval '1 second' where id=${expired}::uuid`;
  expect((await consume(expired)).status).toBe(409);

  // Hold the target lock, change its profile, then release the waiting consumer.
  // A pre-lock snapshot comparison would incorrectly authorize the changed target.
  const changed = await stage();
  await checked(decide(changed));
  const raced = await heldTransactionRace(
    db,
    (tx) => tx`select id from public.profiles where id=${target.userId}::uuid for update`,
    () => consume(changed),
    (tx) => tx`update public.profiles set email='changed@example.test' where id=${target.userId}::uuid`,
  );
  expect(raced.status).toBe(409);

  // Provider scope is explicit and retains its original business idempotency key.
  const payment = {
    p_tool_name: 'refund_paypal',
    p_arguments: {
      order_id: crypto.randomUUID(),
      amount: '12.34',
      restock: false,
      idempotency_key: crypto.randomUUID(),
    },
  };
  const paymentId = await stage(payment);
  await checked(decide(paymentId));
  expect((await consume(paymentId, payment)).data).toMatchObject({ state: 'consuming' });
  expect((await consume(paymentId, payment)).status).toBe(409);
  expect((await invoke({ ...payment, p_action: 'finish', p_approval_id: paymentId })).data).toEqual({
    id: paymentId,
    state: 'consumed',
  });

  // Lost atomic dispatch response must never lead to another role mutation.
  const lost = await stage();
  await checked(decide(lost));
  const host = createActionApprovalHost(
    {
      ...binding,
      supabaseUrl: API,
      serviceRoleKey: SERVICE_KEY,
      scopes: ['store:write', 'store:access'],
      introspectionEndpoint: `${binding.issuer}/introspect`,
      introspectionClientId: 'test',
      introspectionClientSecret: 'unused',
    },
    { grantId: grant.id, expectedUserId: owner.userId },
    async (url, init) => {
      const response = await fetch(url, init);
      expect(response.ok).toBe(true);
      throw Error('lost after commit');
    },
  );
  await expect(host('set_user_role', { ...base.p_arguments, approval_id: lost })).rejects.toMatchObject({
    outcomeUnknown: true,
  });
  expect((await consume(lost)).status).toBe(409);
  const revoked = await stage();
  await checked(decide(revoked));
  await db`update private.mcp_grants set state='revoked',version=2,revoked_at=now() where id=${grant.id}::uuid`;
  expect((await consume(revoked)).status).toBe(403);
}, 60000);
