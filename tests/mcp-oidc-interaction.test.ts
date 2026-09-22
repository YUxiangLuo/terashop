import { expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { createOidcProvider } from '../mcp/src/oidc-provider';
import { createOidcAdapter } from '../mcp/src/oidc-adapter';
import { createOidcInteractionHandler } from '../mcp/src/oidc-interaction';
import { createCredentialCipher } from '../mcp/src/credentials';
import { GrantAuthorizer } from '../mcp/src/authorization';
import { AdminBackend } from '../mcp/src/backend';
import { API, ANON_KEY, SERVICE_KEY, api, checked, signup, makeAdmin } from './helpers';
import { authMail, authMessages } from './support/mail';
import { testDatabase } from './database-concurrency';
import { mcpSession, toolData } from './support/mcp';
import { nodeOidcService } from './support/oidc-node-service';

// Real local Auth/SMTP/shop database plus a separate issuer DB. Bun mode injects
// completion failure through a fixture proxy; Node mode uses the real TLS entry.
for (const runtime of ['bun', 'node'] as const)
  test(`${runtime}: durable provider + real email consent isolates administrators`, async () => {
    const db = testDatabase();
    const name = `oidc_login_${crypto.randomUUID().replaceAll('-', '')}`;
    const project = `interaction-${crypto.randomUUID()}`;
    const origin = 'https://127.0.0.1:3000';
    const resource = 'https://shop.example/mcp';
    const redirect = 'https://client.example/callback';
    const secret = randomBytes(32).toString('base64url');
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const encryptionKey = randomBytes(32);
    const cipher = await createCredentialCipher(new Map([['test', encryptionKey]]), 'test');
    let store: postgres.Sql | undefined;
    let created = false;
    let roleCreated = false;
    let node: Awaited<ReturnType<typeof nodeOidcService>> | undefined;
    let server: ReturnType<typeof createServer> | undefined;
    let provider: ReturnType<typeof createOidcProvider> | undefined;
    const sessions: Awaited<ReturnType<typeof mcpSession>>[] = [];
    const users: Awaited<ReturnType<typeof signup>>[] = [];
    try {
      await db.unsafe(`create database ${name}`);
      created = true;
      const databaseUrl = new URL(process.env.DB_URL!);
      databaseUrl.pathname = `/${name}`;
      store = postgres(databaseUrl.href, { max: 3 });
      await store.unsafe(await Bun.file('mcp/auth/storage.sql').text());
      const providerConfig = {
        issuer: origin,
        resource,
        scopes: ['store:read', 'store:write'],
        signingKey: { ...privateKey.export({ format: 'jwk' }), kid: 'test', alg: 'ES256', use: 'sig' },
        cookieKeys: [randomBytes(32).toString('base64url')],
        clients: [{ id: 'agent', applicationType: 'web', redirectUris: [redirect] }],
        introspectionClient: { id: 'resource', secret },
      };
      let failCompletion = false;
      if (runtime === 'node') {
        const password = randomBytes(32).toString('hex');
        await db.unsafe(`create role ${name} login password '${password}'`);
        roleCreated = true;
        await store.unsafe(`grant usage on schema oidc to ${name};
        grant select,insert,update,delete on all tables in schema oidc to ${name}`);
        databaseUrl.username = name;
        databaseUrl.password = password;
        node = await nodeOidcService({
          provider: providerConfig,
          databaseUrl: databaseUrl.href,
          downstream: {
            project,
            supabaseUrl: API,
            anonKey: ANON_KEY,
            serviceRoleKey: SERVICE_KEY,
            callbackUrl: `${origin}/`,
          },
          credentialKeys: { test: encryptionKey.toString('base64url') },
          activeCredentialKey: 'test',
        });
      } else {
        provider = createOidcProvider(providerConfig, createOidcAdapter(store));
        provider.proxy = true; // Isolated Bun fixture only, never the Node service.
        const complete = provider.interactionResult.bind(provider);
        provider.interactionResult = async (...args) => {
          const location = await complete(...args);
          if (failCompletion) throw new Error('Lost completion receipt');
          return location;
        };
        const handler = createOidcInteractionHandler(
          provider,
          {
            publicOrigin: origin,
            callbackUrl: `${origin}/`,
            resource,
            project,
            scopes: ['store:read', 'store:write'],
            supabaseUrl: API,
            anonKey: ANON_KEY,
            serviceRoleKey: SERVICE_KEY,
          },
          cipher,
        );
        const callback = provider.callback();
        server = createServer((req, res) => {
          void handler(req, res)
            .then((handled) => {
              if (!handled) return callback(req, res);
            })
            .catch(() => {
              res.statusCode = 500;
              res.end('Fixture failed');
            });
        });
        await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      }
      const address = server?.address();
      const endpoint = address && typeof address !== 'string' ? `http://127.0.0.1:${address.port}` : '';
      const local =
        node?.request ??
        ((path: string, init: RequestInit = {}) =>
          fetch(`${endpoint}${path}`, {
            ...init,
            redirect: 'manual',
            signal: AbortSignal.timeout(10_000),
            headers: {
              ...Object.fromEntries(new Headers(init.headers)),
              host: '127.0.0.1:3000',
              'x-forwarded-proto': 'https',
            },
          }));
      const authorizer = new GrantAuthorizer(
        {
          tokenProfile: 'oidc-provider',
          issuer: origin,
          introspectionEndpoint: `${origin}/token/introspection`,
          introspectionClientId: 'resource',
          introspectionClientSecret: secret,
          resource,
          project,
          supabaseUrl: API,
          serviceRoleKey: SERVICE_KEY,
          scopes: ['store:read', 'store:write'],
        },
        (url, init) =>
          url === `${origin}/token/introspection` ? local('/token/introspection', init) : fetch(url, init),
      );
      const tokens: string[] = [];
      const refreshTokens: string[] = [];
      for (let index = 0; index < 3; index++) {
        const user = await signup();
        users.push(user);
        await makeAdmin(user.userId);
        const previous = (await authMessages(user.email)).map((m) => m.ID);
        const cookies = new Map<string, { pair: string; path: string }>();
        let csrf = '';
        const call = async (input: string, action?: string, body?: string, signal?: AbortSignal) => {
          const url = new URL(input, origin);
          expect(url.origin).toBe(origin);
          const cookie = [...cookies.values()]
            .filter(
              (c) =>
                url.pathname === c.path ||
                url.pathname.startsWith(c.path.endsWith('/') ? c.path : `${c.path}/`),
            )
            .map((c) => c.pair)
            .join('; ');
          const response = await local(`${url.pathname}${url.search}`, {
            method: action ? 'POST' : 'GET',
            body,
            signal,
            headers: {
              cookie,
              ...(action
                ? { origin, 'x-csrf-token': csrf, 'x-tera-login': 'start', 'x-tera-consent': action }
                : {}),
              ...(body ? { 'content-type': 'application/json' } : {}),
            },
          });
          for (const raw of response.headers.getSetCookie()) {
            const pair = raw.split(';')[0],
              path = /;\s*path=([^;]+)/i.exec(raw)?.[1] ?? '/';
            cookies.set(`${pair.split('=')[0]}:${path}`, { pair, path });
          }
          return response;
        };
        const verifier = randomBytes(32).toString('base64url');
        const scopes = index === 1 ? (['store:read', 'store:write'] as const) : (['store:read'] as const);
        const auth = await call(
          `/auth?${new URLSearchParams({
            client_id: 'agent',
            redirect_uri: redirect,
            response_type: 'code',
            scope: `openid offline_access ${scopes.join(' ')}`,
            resource,
            prompt: 'consent',
            state: 'test',
            code_challenge_method: 'S256',
            code_challenge: createHash('sha256').update(verifier).digest('base64url'),
          })}`,
        );
        expect(auth.status).toBe(303);
        const path = auth.headers.get('location')!;
        await auth.body?.cancel();
        const start = await call(`${path}/start`, 'start');
        expect(start.status).toBe(201);
        csrf = (await start.json()).csrfToken;
        const email = await call('/login/email', 'email', JSON.stringify({ email: user.email }));
        expect(email.status).toBe(202);
        await email.body?.cancel();
        const mail = await authMail(user.email, 'magiclink', previous);
        const verified = await fetch(mail, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
        expect(verified.status).toBe(303);
        const callback = await call(verified.headers.get('location')!);
        await verified.body?.cancel();
        expect(callback.status).toBe(303);
        await callback.body?.cancel();
        failCompletion = runtime === 'bun' && index === 2;
        const disconnect = runtime === 'node' && index === 2;
        let approved: Response | undefined;
        if (node && (index === 0 || disconnect)) {
          // Hold the issuer write lock, then observe the real approval blocked
          // on it before sending SIGTERM. Do not infer ordering from a sleep.
          const lock = await store.reserve();
          let pending: Promise<Response> | undefined;
          try {
            await lock`select pg_advisory_lock(1952805473, 1869177955)`;
            const [owner] = await lock`select pg_backend_pid() as pid`;
            const abort = new AbortController();
            pending = call(`${path}/approve`, 'approve', undefined, abort.signal);
            void pending.catch(() => {}); // Joined below, including failure paths.
            const deadline = Date.now() + 2000;
            for (;;) {
              const [waiter] = await store`select exists(select 1 from pg_stat_activity
                where datname=current_database() and ${owner.pid}::integer=any(pg_blocking_pids(pid))) as blocked`;
              if (waiter.blocked) break;
              if (Date.now() >= deadline) throw new Error('Approval did not reach issuer write barrier');
              await Bun.sleep(10);
            }
            if (disconnect) {
              abort.abort();
              await expect(pending).rejects.toThrow();
            }
            await node.restart(async () => {
              const deadline = Date.now() + 2000;
              for (;;) {
                try {
                  const probe = await local('/jwks', { headers: { connection: 'close' } });
                  await probe.body?.cancel();
                } catch {
                  break; // Listener has stopped accepting, while approval is blocked.
                }
                if (Date.now() >= deadline) throw new Error('Shutdown did not stop accepting requests');
                await Bun.sleep(10);
              }
              const [waiter] = await store!`select exists(select 1 from pg_stat_activity
                where datname=current_database() and ${owner.pid}::integer=any(pg_blocking_pids(pid))) as blocked`;
              expect(waiter.blocked).toBe(true);
              await lock`select pg_advisory_unlock(1952805473, 1869177955)`;
            });
            if (!disconnect) approved = await pending;
          } finally {
            try {
              await lock`select pg_advisory_unlock_all()`;
            } finally {
              lock.release();
              await pending?.then(
                (response) => response.body?.cancel(),
                () => {},
              );
            }
          }
        } else {
          approved = await call(`${path}/approve`, 'approve');
        }
        const [grant] = await db`select id,binding,state,downstream_session_id from private.mcp_grants
        where binding->>'project'=${project} and user_id=${user.userId}::uuid`;
        expect(grant).toBeDefined();
        if (disconnect) {
          expect(grant.state).toBe('revoked');
          expect(await db`select 1 from private.mcp_credentials where grant_id=${grant.id}`).toHaveLength(0);
          expect(
            await store`select 1 from oidc.revoked_grants where id=${grant.binding.session_id}`,
          ).toHaveLength(1);
          continue;
        }
        if (!approved) throw new Error('Missing approval response');
        if (failCompletion) {
          expect(approved.status).toBe(403);
          expect(grant.state).toBe('revoked');
          expect(await provider!.Grant.find(grant.binding.session_id)).toBeUndefined();
          expect(await db`select 1 from private.mcp_credentials where grant_id=${grant.id}`).toHaveLength(0);
          await approved.body?.cancel();
          continue;
        }
        expect(approved.status).toBe(303);
        const resumed = await call(approved.headers.get('location')!);
        await approved.body?.cancel();
        expect(resumed.status).toBe(303);
        const result = new URL(resumed.headers.get('location')!);
        await resumed.body?.cancel();
        expect(`${result.origin}${result.pathname}`).toBe(redirect);
        expect(result.searchParams.get('state')).toBe('test');
        expect(result.searchParams.has('error')).toBe(false);
        const response = await local('/token', {
          method: 'POST',
          body: new URLSearchParams({
            client_id: 'agent',
            grant_type: 'authorization_code',
            code: result.searchParams.get('code')!,
            code_verifier: verifier,
            redirect_uri: redirect,
            resource,
          }),
        });
        expect(response.status).toBe(200);
        const issued = await response.json();
        const token = issued.access_token;
        expect(typeof issued.refresh_token).toBe('string');
        refreshTokens.push(issued.refresh_token);
        tokens.push(token);
        const context = await authorizer.authorize(token);
        expect(context.expectedUserId).toBe(user.userId);
        expect(context.grantId).toBe(grant.id);
        expect(context.authorization.scopes).toEqual(scopes);
        const stored = await authorizer.readCredentials(token, cipher);
        expect(stored.expectedUserId).toBe(user.userId);
        expect(stored.revision).toBe(1);
        expect(stored.credentials).not.toBeNull();
        const backend = new AdminBackend({
          url: API,
          anonKey: ANON_KEY,
          accessToken: stored.credentials!.accessToken,
          expectedUserId: context.expectedUserId,
        });
        expect(await backend.rpc('get_mcp_downstream_session', {}, false)).toEqual({
          user_id: user.userId,
          session_id: grant.downstream_session_id,
        });
        const mcp = await mcpSession(backend, true, context.authorization);
        sessions.push(mcp);
        const settings = await toolData<{ currency: string }>(mcp.client, 'get_admin_shop_settings');
        expect(settings.currency).toBe('USD');
        const tools = await mcp.client.listTools();
        expect(tools.tools.some((t) => t.name === 'update_shop_settings')).toBe(index === 1);
      }
      // Revoking A cannot break B or let the old A context keep using its token.
      const [first] =
        await db`select id,binding from private.mcp_grants where binding->>'project'=${project} and user_id=${users[0].userId}::uuid`;
      await checked(
        api('/rest/v1/rpc/mcp_grant_command', {
          method: 'POST',
          service: true,
          body: { p_action: 'revoke', p_binding: first.binding, p_grant_id: first.id },
        }),
      );
      await expect(authorizer.authorize(tokens[0])).rejects.toThrow('AUTHORIZATION_DENIED');
      expect(
        (await sessions[0].client.callTool({ name: 'get_admin_shop_settings', arguments: {} })).isError,
      ).toBe(true);
      expect(
        (await toolData<{ currency: string }>(sessions[1].client, 'get_admin_shop_settings')).currency,
      ).toBe('USD');
      if (node) {
        const refresh = async (token: string) => {
          const response = await local('/token', {
            method: 'POST',
            body: new URLSearchParams({
              client_id: 'agent',
              grant_type: 'refresh_token',
              refresh_token: token,
              resource,
            }),
          });
          return { status: response.status, data: await response.json() };
        };
        // Consume B's original refresh token before shutdown. The replacement
        // must survive; the consumed token must never become usable again.
        const rotated = await refresh(refreshTokens[1]);
        expect(rotated.status).toBe(200);
        expect(typeof rotated.data.refresh_token).toBe('string');
        expect(rotated.data.refresh_token).not.toBe(refreshTokens[1]);
        const before = await authorizer.authorize(rotated.data.access_token);
        await node.restart();
        await expect(authorizer.authorize(tokens[0])).rejects.toThrow('AUTHORIZATION_DENIED');
        expect((await authorizer.authorize(tokens[1])).expectedUserId).toBe(users[1].userId);
        const restored = await authorizer.readCredentials(rotated.data.access_token, cipher);
        expect(restored.expectedUserId).toBe(users[1].userId);
        expect(restored.revision).toBe(1);
        expect(restored.credentials).not.toBeNull();
        expect((await authorizer.authorize(rotated.data.access_token)).grantId).toBe(before.grantId);
        expect(
          (await toolData<{ currency: string }>(sessions[1].client, 'get_admin_shop_settings')).currency,
        ).toBe('USD');
        const next = await refresh(rotated.data.refresh_token);
        expect(next.status).toBe(200);
        expect(next.data.refresh_token).not.toBe(rotated.data.refresh_token);
        expect((await authorizer.authorize(next.data.access_token)).authorization.scopes).toEqual([
          'store:read',
          'store:write',
        ]);
        const replay = await refresh(refreshTokens[1]);
        expect(replay.status).toBe(400);
        expect(replay.data.error).toBe('invalid_grant');
        await expect(authorizer.authorize(next.data.access_token)).rejects.toThrow('AUTHORIZATION_DENIED');
        // The grant-wide replay revocation must also survive a second process.
        await node.restart();
        await expect(authorizer.authorize(rotated.data.access_token)).rejects.toThrow('AUTHORIZATION_DENIED');
        await expect(authorizer.authorize(next.data.access_token)).rejects.toThrow('AUTHORIZATION_DENIED');
        const revoked = await refresh(next.data.refresh_token);
        expect(revoked.status).toBe(400);
        expect(revoked.data.error).toBe('invalid_grant');
        expect(
          (await sessions[1].client.callTool({ name: 'get_admin_shop_settings', arguments: {} })).isError,
        ).toBe(true);
      }
    } finally {
      try {
        try {
          for (const session of sessions) await session.close();
        } finally {
          await node?.close();
          if (server)
            await new Promise<void>((resolve, reject) =>
              server!.close((error) => (error ? reject(error) : resolve())),
            );
        }
      } finally {
        try {
          await db`delete from private.mcp_grants where binding->>'project'=${project}`;
          for (const user of users)
            await checked(api(`/auth/v1/admin/users/${user.userId}`, { method: 'DELETE', service: true }));
        } finally {
          try {
            await store?.end();
            if (created) await db.unsafe(`drop database ${name}`);
            if (roleCreated) await db.unsafe(`drop role ${name}`);
          } finally {
            await db.close();
          }
        }
      }
    }
  }, 30_000);
