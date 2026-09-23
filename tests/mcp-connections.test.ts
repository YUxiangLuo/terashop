import { afterAll, beforeAll, expect, test } from 'bun:test';
import { api, checked, rpc, signup, makeAdmin, type TestUser } from './helpers';
import { testDatabase, heldTransactionRace } from './database-concurrency';
import { cleanupOidcConnections } from '../mcp/src/oidc-connection-cleanup';

const db = testDatabase();
const project = `connections-${crypto.randomUUID()}`;
const scope = {
  p_issuer: 'https://auth.example',
  p_resource: 'https://shop.example/mcp',
  p_project: project,
};
let user: TestUser, other: TestUser;
beforeAll(async () => {
  user = await signup();
  other = await signup();
  await makeAdmin(user.userId);
  await makeAdmin(other.userId);
});
afterAll(async () => {
  await db`delete from private.mcp_grants where binding->>'project'=${project}`;
  await db`delete from private.mcp_grant_fences where binding->>'project'=${project}`;
  await db.close();
});
async function create(who = user, resource = scope.p_resource) {
  const binding = {
    issuer: scope.p_issuer,
    resource,
    project,
    subject: who.userId,
    client_id: 'fixture-agent',
    session_id: crypto.randomUUID(),
  };
  const result = await checked<{ id: string }>(
    rpc(
      'mcp_grant_command',
      {
        p_action: 'create',
        p_binding: binding,
        p_user_id: who.userId,
        p_scopes: ['store:read'],
      },
      undefined,
      true,
    ),
  );
  return { id: result.id, binding };
}
const revoke = (grant_ids: string[], token = user.token) =>
  rpc('revoke_my_mcp_connections', { grant_ids }, token);
const cleanup = (action = 'list', id?: string, extra = {}) =>
  rpc(
    'mcp_connection_cleanup_command',
    {
      ...scope,
      p_action: action,
      ...(id ? { p_grant_id: id } : {}),
      ...extra,
    },
    undefined,
    true,
  );

test('personal listing is redacted and paginated; mixed ownership revocation is atomic, including after demotion', async () => {
  const a = await create(),
    b = await create(),
    foreign = await create(other);
  await db`insert into private.mcp_credentials(grant_id,revision,envelope)
    values (${a.id}::uuid,1,'{"secret":"must-not-leak"}'::jsonb)`;
  expect((await rpc('list_my_mcp_connections', {})).status).toBe(401);
  expect((await revoke([a.id, foreign.id])).data).toMatchObject({
    code: 'PT404',
  });
  expect(
    (await db`select state from private.mcp_grants where id=${a.id}::uuid`)[0]
      .state,
  ).toBe('active');
  expect(
    await db`select 1 from private.mcp_credentials where grant_id=${a.id}::uuid`,
  ).toHaveLength(1);
  const first = await checked<any>(
    rpc('list_my_mcp_connections', { page_size: 1 }, user.token),
  );
  const second = await checked<any>(
    rpc(
      'list_my_mcp_connections',
      { page_size: 1, after_id: first.next_cursor },
      user.token,
    ),
  );
  expect([first.items[0].id, second.items[0].id]).toEqual([a.id, b.id].sort());
  expect(second.next_cursor).toBeNull();
  expect(Object.keys(first.items[0]).sort()).toEqual(
    [
      'id',
      'client_id',
      'resource',
      'scopes',
      'state',
      'created_at',
      'revoked_at',
      'cleanup',
    ].sort(),
  );
  expect(JSON.stringify(first)).not.toContain('secret');
  await checked(
    api(`/rest/v1/profiles?id=eq.${user.userId}`, {
      method: 'PATCH',
      service: true,
      body: { role: 'customer' },
    }),
  );
  try {
    expect(
      (await checked<any>(rpc('list_my_mcp_connections', {}, user.token)))
        .items,
    ).toHaveLength(2);
    const receipt = await checked<{ ids: string[]; state: string }>(
      revoke([b.id, a.id, a.id]),
    );
    expect(receipt).toEqual({ ids: [a.id, b.id].sort(), state: 'revoked' });
    expect(
      await checked<{ ids: string[]; state: string }>(revoke([a.id, b.id])),
    ).toEqual(receipt);
    expect(
      await db`select 1 from private.mcp_credentials where grant_id=${a.id}::uuid`,
    ).toHaveLength(0);
    expect(
      (
        await db`select state from private.mcp_grants where id=${foreign.id}::uuid`
      )[0].state,
    ).toBe('active');
    expect((await cleanup()).data).toHaveLength(2);
  } finally {
    await makeAdmin(user.userId);
  }
  for (const id of [a.id, b.id]) await checked(cleanup('complete', id));
});

test('snapshot retries exclude later grants; cleanup is deployment-scoped and acknowledgement loss is retryable', async () => {
  const a = await create(),
    foreignDeployment = await create(user, 'https://other.example/mcp');
  await checked(revoke([a.id, foreignDeployment.id]));
  const later = await create();
  await checked(revoke([a.id, foreignDeployment.id]));
  expect(
    (
      await db`select state from private.mcp_grants where id=${later.id}::uuid`
    )[0].state,
  ).toBe('active');
  expect((await cleanup('complete', foreignDeployment.id)).data).toMatchObject({
    code: 'PT404',
  });
  const config = {
    issuer: scope.p_issuer,
    resource: scope.p_resource,
    project,
    supabaseUrl: 'http://localhost',
    serviceRoleKey: 'fixture',
  };
  let lost = true;
  const destroyed: string[] = [];
  const request = async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const response = await rpc(
      'mcp_connection_cleanup_command',
      body,
      undefined,
      true,
    );
    if (body.p_action === 'complete' && lost) {
      lost = false;
      throw Error('Lost receipt');
    }
    return Response.json(response.data, { status: response.status });
  };
  await expect(
    cleanupOidcConnections(
      config,
      async (id) => {
        destroyed.push(id);
      },
      request,
    ),
  ).rejects.toThrow('OIDC_CONNECTION_CLEANUP_UNCONFIRMED');
  expect(destroyed).toEqual([a.binding.session_id]);
  expect(
    await cleanupOidcConnections(
      config,
      async (id) => {
        destroyed.push(id);
      },
      request,
    ),
  ).toBe(0);
  expect((await cleanup('complete', a.id)).data).toEqual({
    id: a.id,
    cleanup: 'completed',
  });
  const listed = await checked<any>(
    rpc('list_my_mcp_connections', {}, user.token),
  );
  expect(listed.items.find((x: any) => x.id === a.id).cleanup).toBe(
    'completed',
  );
  expect(
    listed.items.find((x: any) => x.id === foreignDeployment.id).cleanup,
  ).toBe('pending');
});

test('personal revocation waits for in-flight credential writes then removes them; cleanup stays private', async () => {
  const a = await create();
  const result = await heldTransactionRace(
    db,
    async (tx) => {
      await tx`select id from private.mcp_grants where id=${a.id}::uuid for update`;
      await tx`insert into private.mcp_credentials(grant_id,revision,envelope)
      values (${a.id}::uuid,1,'{"fixture":true}'::jsonb)`;
    },
    () => revoke([a.id]),
  );
  expect(result.status).toBe(200);
  expect(
    await db`select 1 from private.mcp_credentials where grant_id=${a.id}::uuid`,
  ).toHaveLength(0);
  expect(
    (
      await rpc(
        'mcp_grant_command',
        { p_action: 'resolve', p_binding: a.binding },
        undefined,
        true,
      )
    ).data,
  ).toMatchObject({ code: '42501' });
  for (const token of [undefined, user.token, other.token]) {
    expect(
      (
        await rpc(
          'mcp_connection_cleanup_command',
          { ...scope, p_action: 'list' },
          token,
        )
      ).status,
    ).toBeGreaterThanOrEqual(400);
  }
  for (const grant_ids of [[], null, [null], Array(101).fill(a.id)]) {
    expect(
      (await rpc('revoke_my_mcp_connections', { grant_ids }, user.token)).data,
    ).toMatchObject({ code: '22023' });
  }
  for (const role of ['anon', 'authenticated', 'service_role']) {
    expect(
      (
        await db`select has_table_privilege(${role},'private.mcp_connection_revocations','SELECT,INSERT,UPDATE,DELETE') as allowed`
      )[0].allowed,
    ).toBe(false);
  }
});

test('queue failure rolls back local revocation and credential erasure; batches stop at 20 without losing the remainder', async () => {
  const a = await create();
  await db`insert into private.mcp_credentials(grant_id,revision,envelope)
    values (${a.id}::uuid,1,'{"fixture":true}'::jsonb)`;
  // A fixture-specific constraint fails the LAST write, not the initial authorization.
  await db.unsafe(`alter table private.mcp_connection_revocations add constraint test_connection_queue_failure
    check (grant_id <> '${a.id}'::uuid) not valid`);
  try {
    expect((await revoke([a.id])).data).toMatchObject({ code: '23514' });
    expect((await db`select state from private.mcp_grants where id=${a.id}::uuid`)[0].state).toBe('active');
    expect(await db`select 1 from private.mcp_credentials where grant_id=${a.id}::uuid`).toHaveLength(1);
    expect(await db`select 1 from private.mcp_connection_revocations where grant_id=${a.id}::uuid`).toHaveLength(0);
  } finally {
    await db`alter table private.mcp_connection_revocations drop constraint test_connection_queue_failure`;
  }
  const resource = 'https://batch.example/mcp';
  const entries = [];
  for (let i = 0; i < 21; i++) entries.push(await create(user, resource));
  await checked(revoke(entries.map(entry => entry.id)));
  const page = await checked<Array<{ id: string; upstream_grant_id: string }>>(
    cleanup('list', undefined, { p_resource: resource }),
  );
  const sorted = entries.map(entry => entry.id).sort();
  expect(page.map(entry => entry.id)).toEqual(sorted.slice(0,20));
  for (const entry of page) await checked(cleanup('complete', entry.id, { p_resource: resource }));
  expect((await checked<Array<{ id: string }>>(cleanup('list', undefined, { p_resource: resource }))).map(entry => entry.id))
    .toEqual(sorted.slice(20));
});

test('anonymous authenticated sessions and service-role cannot use personal management endpoints', async () => {
  const guest = await checked<{ access_token: string; user: { id: string } }>(
    api('/auth/v1/signup', { method: 'POST', body: {} }),
  );
  try {
    for (const [token, service] of [[guest.access_token, false], [undefined, true]] as const) {
      expect((await rpc('list_my_mcp_connections', {}, token, service)).data).toMatchObject({ code: '42501' });
      expect((await rpc('revoke_my_mcp_connections', { grant_ids: [crypto.randomUUID()] }, token, service)).data)
        .toMatchObject({ code: '42501' });
    }
  } finally {
    await checked(api(`/auth/v1/admin/users/${guest.user.id}`, { method: 'DELETE', service: true }));
  }
});
