import assert from 'node:assert/strict';
import { SQL } from 'bun';
import { AdminBackend } from '../../mcp/src/backend';
import { KeycloakGrantAuthorizer, type AuthorizationConfig } from '../../mcp/src/authorization';
import { createCredentialCipher } from '../../mcp/src/credentials';
import { validateLocalSupabase, type LocalSupabase } from '../../scripts/lib/local-supabase';
import { createApi, type ApiOptions } from './http';
import { mcpSession, toolData } from './mcp';

// Opt-in Docker experiment, not a production account-linking implementation.
// The caller owns four freshly issued tokens: user A/client A, A/B, B/A, B/B.
export async function verifyLocalAuthorization(
  local: LocalSupabase,
  upstream: Pick<
    AuthorizationConfig,
    'issuer' | 'introspectionEndpoint' | 'introspectionClientId' | 'introspectionClientSecret' | 'resource'
  >,
  tokens: readonly [string, string, string, string],
  revokeSecond: () => Promise<void>,
) {
  validateLocalSupabase({ ...local });
  const db = new SQL(local.DB_URL);
  const api = createApi({ url: local.API_URL, anonKey: local.ANON_KEY, serviceKey: local.SERVICE_ROLE_KEY });
  const project = `joint-${crypto.randomUUID()}`;
  const users: { id: string; token: string; refreshToken: string; expiresAt: number }[] = [];
  const sessions: Awaited<ReturnType<typeof mcpSession>>[] = [];
  async function request<T>(path: string, options: ApiOptions): Promise<T> {
    const result = await api(path, options);
    // Do not include Auth responses or credentials in diagnostics.
    assert(result.status >= 200 && result.status < 300, `Fixture request failed: ${path} (${result.status})`);
    return result.data as T;
  }
  const config: AuthorizationConfig = {
    ...upstream,
    project,
    supabaseUrl: local.API_URL,
    serviceRoleKey: local.SERVICE_ROLE_KEY,
    scopes: ['store:read', 'store:write'],
  };
  const authorizer = new KeycloakGrantAuthorizer(config);
  const calls: string[][] = [];
  try {
    // Ephemeral test key and in-memory envelopes only: no credential persistence.
    const cipher = await createCredentialCipher(
      new Map([['fixture', crypto.getRandomValues(new Uint8Array(32))]]),
      'fixture',
    );
    for (let i = 0; i < 2; i++) {
      const email = `joint-${crypto.randomUUID()}@example.test`;
      const password = crypto.randomUUID();
      const user = await request<{ id: string }>('/auth/v1/admin/users', {
        service: true,
        method: 'POST',
        body: { email, password, email_confirm: true },
      });
      users.push({ id: user.id, token: '', refreshToken: '', expiresAt: 0 });
      await request(`/rest/v1/profiles?id=eq.${user.id}`, {
        service: true,
        method: 'PATCH',
        body: { role: 'admin' },
      });
      const login = await request<{ access_token: string; refresh_token: string; expires_at: number }>(
        '/auth/v1/token?grant_type=password',
        {
          method: 'POST',
          body: { email, password },
        },
      );
      users[i].token = login.access_token;
      users[i].refreshToken = login.refresh_token;
      users[i].expiresAt = login.expires_at;
    }
    const bindings: Record<string, string>[] = [];
    const grants: { id: string }[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const response = await fetch(upstream.introspectionEndpoint, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        body: new URLSearchParams({
          token: tokens[i],
          client_id: upstream.introspectionClientId,
          client_secret: upstream.introspectionClientSecret,
        }),
      });
      assert.equal(response.status, 200);
      const identity = await response.json();
      assert.equal(identity.active, true);
      assert.equal(identity.iss, upstream.issuer);
      bindings.push({
        issuer: identity.iss,
        subject: identity.sub,
        client_id: identity.client_id,
        resource: upstream.resource,
        project,
        session_id: identity.sid,
      });
      // A valid token is insufficient: no automatic grant creation, even when a
      // matching user or client already has another approved grant.
      await assert.rejects(authorizer.authorize(tokens[i]), /AUTHORIZATION_DENIED/);
      grants.push(
        await request('/rest/v1/rpc/mcp_grant_command', {
          service: true,
          method: 'POST',
          body: {
            p_action: 'create',
            p_binding: bindings[i],
            p_user_id: users[Math.floor(i / 2)].id,
            p_scopes: ['store:read', 'store:write'],
          },
        }),
      );
      const context = await authorizer.authorize(tokens[i]);
      assert.equal(context.expectedUserId, users[Math.floor(i / 2)].id);
      assert.equal(context.grantId, grants[i].id);
      assert.deepEqual(
        context.authorization.scopes,
        i === 1 ? ['store:read', 'store:write'] : ['store:read'],
      );
      const paths: string[] = [];
      calls.push(paths);
      const owner = users[Math.floor(i / 2)];
      const credentialContext = {
        project,
        grantId: context.grantId,
        userId: context.expectedUserId,
        revision: 1,
      };
      const sealed = JSON.parse(
        JSON.stringify(
          await cipher.seal(credentialContext, {
            accessToken: owner.token,
            refreshToken: owner.refreshToken,
            expiresAt: owner.expiresAt,
          }),
        ),
      );
      await assert.rejects(
        cipher.open({ ...credentialContext, userId: users[1 - Math.floor(i / 2)].id }, sealed),
        /CREDENTIAL_DECRYPTION_FAILED/,
      );
      const restored = await cipher.open(credentialContext, sealed);
      const backend = new AdminBackend(
        {
          url: local.API_URL,
          anonKey: local.ANON_KEY,
          accessToken: restored.accessToken,
          expectedUserId: context.expectedUserId,
        },
        async (url, init) => {
          paths.push(new URL(url).pathname);
          assert(
            new Headers(init.headers).get('Authorization') === `Bearer ${users[Math.floor(i / 2)].token}`,
            'Business requests must use the bound downstream user token',
          );
          return fetch(url, init);
        },
      );
      sessions.push(await mcpSession(backend, true, context.authorization));
    }
    assert.equal(new Set(grants.map((g) => g.id)).size, 4);
    assert.equal(bindings[0].session_id, bindings[1].session_id);
    assert.equal(bindings[2].session_id, bindings[3].session_id);
    assert.notEqual(bindings[0].subject, bindings[2].subject);
    async function read(index: number) {
      const id = users[Math.floor(index / 2)].id;
      const profile = await toolData<{ user_id: string; role: string }>(
        sessions[index].client,
        'get_admin_user',
        { user_id: id },
      );
      assert.equal(profile.user_id, id);
      assert.equal(profile.role, 'admin');
    }
    async function denied(index: number) {
      calls[index].length = 0;
      const result = await sessions[index].client.callTool({
        name: 'get_admin_user',
        arguments: { user_id: users[0].id },
      });
      assert.equal(result.isError, true);
      const error = JSON.parse((result.content as { text: string }[])[0].text);
      assert.equal(error.code, 'AUTHORIZATION_UNAVAILABLE');
      assert.equal(error.outcome_unknown, false);
      assert.deepEqual(calls[index], []); // No Auth/business access after authorization rejection.
    }
    for (let i = 0; i < 4; i++) {
      await read(i);
      assert.deepEqual(calls[i], ['/auth/v1/user', '/rest/v1/rpc/is_admin', '/rest/v1/rpc/get_admin_user']);
      const tools = await sessions[i].client.listTools();
      assert.equal(
        tools.tools.some((t) => t.name === 'create_customer'),
        i === 1,
      );
      if (i !== 1) {
        await assert.rejects(
          sessions[i].client.callTool({
            name: 'create_customer',
            arguments: { idempotency_key: crypto.randomUUID() },
          }),
          { code: -32602 },
        );
        assert.equal(calls[i].length, 3); // Hidden writes cannot reach the real backend.
      }
    }
    const context = await authorizer.authorize(tokens[0]);
    const wrongCalls: string[] = [];
    const wrong = await mcpSession(
      new AdminBackend(
        {
          url: local.API_URL,
          anonKey: local.ANON_KEY,
          accessToken: users[1].token,
          expectedUserId: context.expectedUserId,
        },
        async (url, init) => {
          wrongCalls.push(new URL(url).pathname);
          return fetch(url, init);
        },
      ),
      true,
      context.authorization,
    );
    sessions.push(wrong);
    const mismatch = await wrong.client.callTool({
      name: 'get_admin_user',
      arguments: { user_id: users[0].id },
    });
    assert.equal(mismatch.isError, true);
    const mismatchError = JSON.parse((mismatch.content as { text: string }[])[0].text);
    assert.equal(mismatchError.code, 'IDENTITY_MISMATCH');
    assert.equal(mismatchError.outcome_unknown, false);
    assert.deepEqual(wrongCalls, ['/auth/v1/user']);
    console.log(
      'PASS: real grant/MCP/backend identities, four isolated grants, crossed admin session rejection',
    );
    console.log(
      'PASS: bound credential envelopes restore real downstream sessions and reject another user context',
    );

    await request('/rest/v1/rpc/mcp_grant_command', {
      service: true,
      method: 'POST',
      body: { p_action: 'revoke', p_binding: bindings[0], p_grant_id: grants[0].id },
    });
    await denied(0);
    await assert.rejects(new KeycloakGrantAuthorizer(config).authorize(tokens[0]), /AUTHORIZATION_DENIED/);
    for (const i of [1, 2, 3]) await read(i);
    await db`update public.profiles set role='customer' where id=${users[0].id}::uuid`;
    await denied(1);
    for (const i of [2, 3]) await read(i);
    await db`update public.profiles set role='admin' where id=${users[0].id}::uuid`;
    await read(1);
    await revokeSecond();
    await denied(1);
    for (const i of [2, 3]) await read(i);
    console.log(
      'PASS: local grant revocation, role demotion and upstream revocation stop MCP calls without affecting user B',
    );
  } finally {
    try {
      await Promise.all(sessions.map((session) => session.close()));
    } finally {
      try {
        // Only this run's disposable fixtures; production tombstones are never deleted.
        await db.begin(async (sql) => {
          await sql`delete from private.mcp_grants where binding->>'project'=${project}`;
          for (const user of users) {
            // Match existing disposable-fixture cleanup: bypass only for this
            // customer deletion, then restore FK cascades for Auth cleanup.
            await sql`set local session_replication_role=replica`;
            await sql`delete from public.customers where auth_user_id=${user.id}::uuid`;
            await sql`set local session_replication_role=origin`;
            await sql`delete from auth.users where id=${user.id}::uuid`;
          }
        });
      } finally {
        await db.close();
      }
    }
  }
}
