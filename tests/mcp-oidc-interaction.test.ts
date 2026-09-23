import { expect, test } from 'bun:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createAdminHttpHandler } from '../mcp/src/http';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { createOidcProvider } from '../mcp/src/oidc-provider';
import { createOidcAdapter } from '../mcp/src/oidc-adapter';
import { createOidcApprovalJournal } from '../mcp/src/oidc-journal';
import { createOidcInteractionHandler } from '../mcp/src/oidc-interaction';
import { createCredentialCipher } from '../mcp/src/credentials';
import { GrantAuthorizer } from '../mcp/src/authorization';
import { AdminBackend } from '../mcp/src/backend';
import { API, ANON_KEY, SERVICE_KEY, api, checked, signup, makeAdmin } from './helpers';
import { authMail, authMessages } from './support/mail';
import { heldTransactionRace, testDatabase } from './database-concurrency';
import { mcpSession, toolData } from './support/mcp';
import { nodeOidcService } from './support/oidc-node-service';
import { verifyOidcBrowser } from './support/oidc-browser';

const browserEnabled = process.env.MCP_BROWSER === '1';
const timeout = browserEnabled ? (process.env.MCP_BROWSER_EXPIRY === '1' ? 540_000 : 180_000) : 45_000;

// Real local Auth/SMTP/shop database plus a separate issuer DB. Bun mode injects
// completion failure through a fixture proxy; Node mode uses the real TLS entry.
for (const runtime of ['bun', 'node'] as const)
  test(`${runtime}: durable provider + real email consent isolates administrators`, async () => {
    const db = testDatabase();
    const name = `oidc_login_${crypto.randomUUID().replaceAll('-', '')}`;
    const project = `interaction-${crypto.randomUUID()}`;
    let origin = 'https://127.0.0.1:3000';
    let resource = 'https://shop.example/mcp';
    const redirect = 'https://client.example/callback';
    let browserRedirect: string | undefined;
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
    let mcpDirectory: string | undefined;
    let mcpProcess: ReturnType<typeof Bun.spawn> | undefined;
    let startMcp: (() => Promise<void>) | undefined;
    const sessions: Awaited<ReturnType<typeof mcpSession>>[] = [];
    const users: Awaited<ReturnType<typeof signup>>[] = [];
    try {
      if (runtime === 'node') {
        // Use actual authorities end to end, without Host rewriting or proxies.
        const ports: number[] = [];
        const reservations = [createServer(), createServer()];
        if (browserEnabled) reservations.push(createServer());
        try {
          for (const reservation of reservations) {
            await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
            const address = reservation.address();
            if (!address || typeof address === 'string') throw new Error('Missing fixture port');
            ports.push(address.port);
          }
        } finally {
          for (const reservation of reservations)
            if (reservation.listening)
              await new Promise<void>((resolve, reject) =>
                reservation.close((error) => (error ? reject(error) : resolve())),
              );
        }
        origin = `https://127.0.0.1:${ports[0]}`;
        resource = `https://127.0.0.1:${ports[1]}/mcp`;
        if (ports[2]) browserRedirect = `https://127.0.0.1:${ports[2]}/callback`;
      }
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
      if (browserRedirect) providerConfig.clients[0].redirectUris.push(browserRedirect);
      let failCompletion = false;
      if (runtime === 'node') {
        const password = randomBytes(32).toString('hex');
        await db.unsafe(`create role ${name} login password '${password}'`);
        roleCreated = true;
        await store.unsafe(`grant usage on schema oidc to ${name};
        grant select,insert,update,delete on all tables in schema oidc to ${name}`);
        databaseUrl.username = name;
        databaseUrl.password = password;
        const interrupted = {
          interactionId: 'startup-interrupted',
          binding: {
            issuer: origin,
            resource,
            project,
            client_id: 'agent',
            subject: crypto.randomUUID(),
            session_id: crypto.randomUUID(),
          },
        };
        await createOidcApprovalJournal(store).begin(interrupted);
        const Stored = createOidcAdapter(store);
        await new Stored('Grant').upsert(interrupted.binding.session_id, {}, 300);
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
        expect(await createOidcApprovalJournal(store).pending()).toEqual([]);
        expect(await new Stored('Grant').find(interrupted.binding.session_id)).toBeUndefined();
        const [fence] = await db`select revoked from private.mcp_grant_fences
          where binding=${JSON.stringify(interrupted.binding)}::text::jsonb`;
        expect(fence.revoked).toBe(true);
        // Remove this synthetic journal fixture before the three real-user assertions.
        await store`delete from oidc.approval_attempts where interaction_id=${interrupted.interactionId}`;
        mcpDirectory = await mkdtemp(join(tmpdir(), 'tera-mcp-network-'));
        const configPath = join(mcpDirectory, 'config.json');
        await writeFile(
          configPath,
          JSON.stringify({
            authorization: {
              issuer: origin,
              resource,
              project,
              introspectionEndpoint: `${origin}/token/introspection`,
              introspectionClientId: 'resource',
              introspectionClientSecret: secret,
              supabaseUrl: API,
              serviceRoleKey: SERVICE_KEY,
              anonKey: ANON_KEY,
              scopes: ['store:read', 'store:write'],
              allowWrites: true,
            },
            credentialKeys: { test: encryptionKey.toString('base64url') },
            activeCredentialKey: 'test',
            tls: node.tls,
            listen: { host: '127.0.0.1', port: Number(new URL(resource).port) },
          }),
          { mode: 0o600 },
        );
        startMcp = async () => {
          const child = Bun.spawn([process.execPath, 'mcp/src/remote.ts', configPath], {
            env: { ...process.env, NODE_EXTRA_CA_CERTS: node!.caPath },
            stdout: 'pipe',
            stderr: 'pipe',
          });
          mcpProcess = child;
          const watchdog = setTimeout(() => child.kill('SIGKILL'), 10_000);
          try {
            const reader = child.stdout.getReader();
            try {
              expect(new TextDecoder().decode((await reader.read()).value)).toBe('MCP_HTTP_READY\n');
            } finally {
              reader.releaseLock();
            }
          } finally {
            clearTimeout(watchdog);
          }
        };
        await startMcp();
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
      for (let index = 0; index < (node ? 4 : 3); index++) {
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
        const crash = runtime === 'node' && index === 3;
        let approved: Response | undefined;
        if (node && crash) {
          // Block the real credential RPC after local grant creation has committed.
          // Killing Node must not be mistaken for cancellation of its HTTP/DB write.
          const blocker = postgres(process.env.DB_URL!, { max: 1 });
          let pending: Promise<Response> | undefined;
          let transaction = false;
          try {
            await blocker`begin`;
            transaction = true;
            await blocker`set local statement_timeout='15s'`;
            await blocker`lock table private.mcp_credentials in access exclusive mode`;
            const [owner] = await blocker`select pg_backend_pid() as pid`;
            pending = call(`${path}/approve`, 'approve');
            void pending.catch(() => {});
            const deadline = Date.now() + 3000;
            for (;;) {
              const [waiter] = await db`select exists(select 1 from pg_stat_activity
                where ${owner.pid}::integer=any(pg_blocking_pids(pid))) as blocked`;
              if (waiter.blocked) break;
              if (Date.now() >= deadline) throw new Error('Credential RPC did not reach database barrier');
              await Bun.sleep(10);
            }
            await node.crashRestart(async () => {
              await expect(pending!).rejects.toThrow();
              const [before] = await db`select id,state from private.mcp_grants
                where binding->>'project'=${project} and user_id=${user.userId}::uuid`;
              expect(before.state).toBe('active');
              const [attempt] = await store!`select state from oidc.approval_attempts
                where binding->>'subject'=${user.userId}`;
              expect(attempt.state).toBe('pending');
              // Release the in-flight Supabase transaction only after Node is dead.
              await blocker`commit`;
              transaction = false;
              const deadline = Date.now() + 3000;
              for (;;) {
                const rows =
                  await db`select revision from private.mcp_credentials where grant_id=${before.id}::uuid`;
                if (rows.length) {
                  expect(Number(rows[0].revision)).toBe(1);
                  break;
                }
                if (Date.now() >= deadline)
                  throw new Error('In-flight credential write did not commit after crash');
                await Bun.sleep(10);
              }
            });
          } finally {
            if (transaction) await blocker`rollback`;
            await blocker.end();
            await pending?.then(
              (response) => response.body?.cancel(),
              () => {},
            );
          }
        } else if (node && (index === 0 || disconnect)) {
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
        if (disconnect || crash) {
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
        const http = createAdminHttpHandler(
          {
            tokenProfile: 'oidc-provider',
            issuer: origin,
            resource,
            project,
            introspectionEndpoint: `${origin}/token/introspection`,
            introspectionClientId: 'resource',
            introspectionClientSecret: secret,
            supabaseUrl: API,
            serviceRoleKey: SERVICE_KEY,
            anonKey: ANON_KEY,
            scopes: ['store:read', 'store:write'],
            allowWrites: true,
          },
          cipher,
          (url, init) =>
            url === `${origin}/token/introspection` ? local('/token/introspection', init) : fetch(url, init),
        );
        const remote = new Client({ name: 'http-integration', version: '1' });
        try {
          await remote.connect(
            new StreamableHTTPClientTransport(new URL(resource), {
              requestInit: { headers: { authorization: `Bearer ${token}` } },
              fetch: (input, init) =>
                node
                  ? fetch(input, { ...init, tls: { ca: node.tls.cert }, signal: AbortSignal.timeout(10_000) })
                  : http(new Request(input, init)),
            }),
          );
          expect((await toolData<{ currency: string }>(remote, 'get_admin_shop_settings')).currency).toBe(
            'USD',
          );
          expect((await remote.listTools()).tools.some((t) => t.name === 'update_shop_settings')).toBe(
            index === 1,
          );
          if (node) {
            type Settings = { name: string; timezone: string; currency: string; revision: number };
            const before = await toolData<Settings>(remote, 'get_admin_shop_settings');
            const changedName = `HTTPS ${crypto.randomUUID()}`;
            const args = { expected_revision: before.revision, changes: { name: changedName } };
            try {
              if (index === 0) {
                // Try the hidden write tool directly: discovery alone is not authorization.
                await expect(
                  remote.callTool({ name: 'update_shop_settings', arguments: args }),
                ).rejects.toMatchObject({ code: -32602, message: 'Tool update_shop_settings not found' });
                expect(await toolData<Settings>(remote, 'get_admin_shop_settings')).toEqual(before);
              } else {
                const changed = await toolData<Settings>(remote, 'update_shop_settings', args);
                expect(changed).toMatchObject({
                  name: changedName,
                  timezone: before.timezone,
                  currency: before.currency,
                  revision: before.revision + 1,
                });
                expect(await toolData<Settings>(remote, 'get_admin_shop_settings')).toEqual(changed);
                expect(
                  (await remote.callTool({ name: 'update_shop_settings', arguments: args })).isError,
                ).toBe(true);
                expect(await toolData<Settings>(remote, 'get_admin_shop_settings')).toEqual(changed);
                await checked(
                  api(`/rest/v1/profiles?id=eq.${user.userId}`, {
                    service: true,
                    method: 'PATCH',
                    body: { role: 'customer' },
                  }),
                );
                for (const name of ['get_admin_shop_settings', 'update_shop_settings']) {
                  const denied = await fetch(resource, {
                    method: 'POST',
                    tls: { ca: node.tls.cert },
                    signal: AbortSignal.timeout(10_000),
                    headers: {
                      authorization: `Bearer ${token}`,
                      'content-type': 'application/json',
                      accept: 'application/json, text/event-stream',
                    },
                    body: JSON.stringify({
                      jsonrpc: '2.0',
                      id: 9,
                      method: 'tools/call',
                      params: {
                        name,
                        arguments:
                          name === 'update_shop_settings'
                            ? { expected_revision: changed.revision, changes: { name: 'Forbidden' } }
                            : {},
                      },
                    }),
                  });
                  expect(denied.status).toBe(401);
                  expect(await denied.json()).toEqual({ error: 'unauthorized' });
                }
                // A different administrator's existing token remains usable.
                const other = await authorizer.authorize(tokens[0]);
                expect(other.expectedUserId).toBe(users[0].userId);
              }
            } finally {
              if (index === 1) {
                await makeAdmin(user.userId);
                const current = await toolData<Settings>(remote, 'get_admin_shop_settings');
                await toolData(remote, 'update_shop_settings', {
                  expected_revision: current.revision,
                  changes: { name: before.name },
                });
                expect(current.name).toBe(changedName);
                expect(current.revision).toBe(before.revision + 1);
              }
            }
            if (index === 1) {
              const initial = await toolData<Settings>(remote, 'get_admin_shop_settings');
              const lostName = `Disconnected ${crypto.randomUUID()}`;
              const write = { expected_revision: initial.revision, changes: { name: lostName } };
              const abort = new AbortController();
              try {
                const outcome = await heldTransactionRace(
                  db,
                  (tx) => tx`lock table private.shop_settings in share mode`,
                  () =>
                    fetch(resource, {
                      method: 'POST',
                      tls: { ca: node!.tls.cert },
                      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]),
                      headers: {
                        authorization: `Bearer ${token}`,
                        'content-type': 'application/json',
                        accept: 'application/json, text/event-stream',
                      },
                      body: JSON.stringify({
                        jsonrpc: '2.0',
                        id: 10,
                        method: 'tools/call',
                        params: { name: 'update_shop_settings', arguments: write },
                      }),
                    }).then(
                      async (response) => {
                        await response.body?.cancel();
                        return 'responded';
                      },
                      () => 'disconnected',
                    ),
                  async () => {
                    // The real RPC is waiting on our table lock. Disconnect and
                    // drain MCP before releasing it; do not assume DB rollback.
                    abort.abort();
                    const child = mcpProcess!;
                    child.kill('SIGTERM');
                    const watchdog = setTimeout(() => child.kill('SIGKILL'), 5000);
                    try {
                      expect(await child.exited).toBe(0);
                    } finally {
                      clearTimeout(watchdog);
                    }
                  },
                );
                expect(outcome).toBe('disconnected');
                // Prove the dispatched RPC can commit after MCP has exited.
                const deadline = Date.now() + 3000;
                for (;;) {
                  const [row] = await db`select name,revision from private.shop_settings where singleton`;
                  if (row.name === lostName) {
                    expect(row.revision).toBe(initial.revision + 1);
                    break;
                  }
                  if (Date.now() >= deadline) throw new Error('In-flight shop write did not commit');
                  await Bun.sleep(10);
                }
                await startMcp!();
                const recovered = await toolData<Settings>(remote, 'get_admin_shop_settings');
                expect(recovered).toMatchObject({
                  name: lostName,
                  revision: initial.revision + 1,
                  timezone: initial.timezone,
                  currency: initial.currency,
                });
                // Explicit stale-version probe, not an automatic write retry.
                expect(
                  (await remote.callTool({ name: 'update_shop_settings', arguments: write })).isError,
                ).toBe(true);
                expect(await toolData<Settings>(remote, 'get_admin_shop_settings')).toEqual(recovered);
              } finally {
                if (mcpProcess!.exitCode !== null) await startMcp!();
                const current = await toolData<Settings>(remote, 'get_admin_shop_settings');
                await toolData(remote, 'update_shop_settings', {
                  expected_revision: current.revision,
                  changes: { name: initial.name },
                });
              }
            }
          }
        } finally {
          await remote.close();
        }
        const tools = await mcp.client.listTools();
        expect(tools.tools.some((t) => t.name === 'update_shop_settings')).toBe(index === 1);
      }
      if (node) {
        // The crash scenario above restarted the process, so all preceding
        // terminal writes must have completed and survived that restart.
        const attempts = await store`select binding->>'subject' as subject,state
          from oidc.approval_attempts where binding->>'project'=${project} order by binding->>'subject'`;
        expect([...attempts]).toEqual(
          users
            .map((user, index) => ({
              subject: user.userId,
              state: index >= 2 ? 'revoked' : 'completed',
            }))
            .sort((a, b) => a.subject.localeCompare(b.subject)),
        );
        for (const session of sessions) {
          const settings = await toolData<{ currency: string }>(session.client, 'get_admin_shop_settings');
          expect(settings.currency).toBe('USD');
        }
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
        const networkCall = async (token: string, signal?: AbortSignal) => {
          const response = await fetch(resource, {
            method: 'POST',
            tls: { ca: node!.tls.cert },
            signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]),
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: { name: 'get_admin_shop_settings', arguments: {} },
            }),
          });
          return { status: response.status, body: await response.json() };
        };
        expect((await networkCall(tokens[0])).status).toBe(401);
        const allowed = await networkCall(tokens[1]);
        expect(allowed.status).toBe(200);
        expect(allowed.body.result.structuredContent.data.currency).toBe('USD');
        // Advance only encrypted expiry metadata to exercise the near-expiry
        // branch without waiting an hour. Auth tokens and rotation stay real.
        const original = await authorizer.readCredentials(tokens[1], cipher);
        const [binding] = await db`select downstream_session_id from private.mcp_grants
          where id=${original.grantId}::uuid`;
        const [issuedBefore] = await db`select count(*)::integer as count from auth.refresh_tokens
          where session_id=${binding.downstream_session_id}::uuid`;
        await authorizer.writeCredentials(tokens[1], cipher, {
          expectedRevision: original.revision,
          credentials: { ...original.credentials!, expiresAt: Math.floor(Date.now() / 1000) + 20 },
          anonKey: ANON_KEY,
        });
        const refreshed = await heldTransactionRace(
          db,
          async (tx) => {
            await tx`lock table auth.refresh_tokens in share mode`;
            const rows = await tx`select id from auth.refresh_tokens
              where token=${original.credentials!.refreshToken}`;
            expect(rows).toHaveLength(1);
          },
          () => networkCall(tokens[1]),
          async () => {
            // The first real Auth refresh has reached the held table. A second
            // HTTPS request must fail closed while its durable claim is pending.
            const [pending] = await db`select revision,refresh_id from private.mcp_credentials
              where grant_id=${original.grantId}::uuid`;
            expect(Number(pending.revision)).toBe(2);
            expect(pending.refresh_id).not.toBeNull();
            const competing = await networkCall(tokens[1]);
            expect(competing).toEqual({ status: 503, body: { error: 'authorization_unavailable' } });
            const [stillPending] = await db`select revision,refresh_id from private.mcp_credentials
              where grant_id=${original.grantId}::uuid`;
            expect(stillPending).toEqual(pending);
          },
        );
        expect(refreshed.status).toBe(200);
        expect(refreshed.body.result.structuredContent.data.currency).toBe('USD');
        let renewed = await authorizer.readCredentials(tokens[1], cipher);
        expect(renewed.revision).toBe(3);
        expect(renewed.expectedUserId).toBe(users[1].userId);
        expect(renewed.credentials!.refreshToken).not.toBe(original.credentials!.refreshToken);
        expect(renewed.credentials!.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000) + 30);
        const [settled] = await db`select c.refresh_id,g.downstream_session_id
          from private.mcp_credentials c join private.mcp_grants g on g.id=c.grant_id
          where g.id=${original.grantId}::uuid`;
        expect(settled).toEqual({ refresh_id: null, downstream_session_id: binding.downstream_session_id });
        const [issuedAfter] = await db`select count(*)::integer as count from auth.refresh_tokens
          where session_id=${binding.downstream_session_id}::uuid`;
        expect(issuedAfter.count).toBe(issuedBefore.count + 1);
        expect((await networkCall(tokens[1])).status).toBe(200);
        expect((await authorizer.readCredentials(tokens[1], cipher)).revision).toBe(3);
        // Hold two real read receipts, not the DB locks, so both handlers see
        // the same expired revision before either can claim the refresh.
        await authorizer.writeCredentials(tokens[1], cipher, {
          expectedRevision: 3,
          credentials: { ...renewed.credentials!, expiresAt: Math.floor(Date.now() / 1000) + 20 },
          anonKey: ANON_KEY,
        });
        const releaseReads = Promise.withResolvers<void>();
        let readsHeld = 0;
        let claims = 0;
        let refreshRequests = 0;
        let loseCompletion = false;
        let lostCompletions = 0;
        let shopReads = 0;
        const proxy = Bun.serve({
          hostname: '127.0.0.1',
          port: 0,
          async fetch(req) {
            const url = new URL(req.url);
            const body = req.method === 'GET' ? undefined : await req.arrayBuffer();
            const headers = new Headers(req.headers);
            headers.delete('host');
            if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token')
              refreshRequests++;
            if (url.pathname === '/rest/v1/rpc/get_admin_shop_settings') shopReads++;
            const response = await fetch(`${API}${url.pathname}${url.search}`, {
              method: req.method,
              headers,
              body,
              signal: req.signal,
              redirect: 'manual',
            });
            if (url.pathname.endsWith('/mcp_credential_command') && body) {
              const args = JSON.parse(new TextDecoder().decode(body));
              if (args.p_action === 'claim_refresh' && args.p_grant_id === original.grantId) claims++;
              if (
                loseCompletion &&
                args.p_action === 'complete_refresh' &&
                args.p_grant_id === original.grantId
              ) {
                // Consume the real committed success before withholding its
                // receipt. This is an injected gateway failure, not a DB mock.
                expect(response.status).toBe(200);
                const receipt = await response.json();
                expect(receipt.revision).toBe(7);
                lostCompletions++;
                loseCompletion = false;
                return new Response(null, { status: 502 });
              }
              if (args.p_action === 'read' && args.p_grant_id === original.grantId && readsHeld < 2) {
                const receipt = await response.clone().json();
                expect(receipt.revision).toBe(4);
                readsHeld++;
                if (readsHeld === 2) releaseReads.resolve();
                await releaseReads.promise;
              }
            }
            return response;
          },
        });
        const configPath = join(mcpDirectory!, 'config.json');
        const directConfig = await Bun.file(configPath).text();
        const proxyConfig = JSON.parse(directConfig);
        proxyConfig.authorization.supabaseUrl = proxy.url.origin;
        try {
          mcpProcess!.kill('SIGTERM');
          expect(await mcpProcess!.exited).toBe(0);
          await writeFile(configPath, JSON.stringify(proxyConfig), { mode: 0o600 });
          await startMcp!();
          const results = await Promise.all([networkCall(tokens[1]), networkCall(tokens[1])]);
          expect(readsHeld).toBe(2);
          expect(claims).toBe(2);
          expect(results.map((result) => result.status).sort()).toEqual([200, 503]);
          expect(results.find((result) => result.status === 503)!.body).toEqual({
            error: 'authorization_unavailable',
          });
          expect(
            results.find((result) => result.status === 200)!.body.result.structuredContent.data.currency,
          ).toBe('USD');
          expect(refreshRequests).toBe(1);
          renewed = await authorizer.readCredentials(tokens[1], cipher);
          expect(renewed.revision).toBe(5);
          expect(renewed.expectedUserId).toBe(users[1].userId);
          await authorizer.writeCredentials(tokens[1], cipher, {
            expectedRevision: 5,
            credentials: { ...renewed.credentials!, expiresAt: Math.floor(Date.now() / 1000) + 20 },
            anonKey: ANON_KEY,
          });
          const previousRefreshToken = renewed.credentials!.refreshToken;
          const readsBeforeLoss = shopReads;
          loseCompletion = true;
          expect(await networkCall(tokens[1])).toEqual({
            status: 503,
            body: { error: 'authorization_unavailable' },
          });
          expect(lostCompletions).toBe(1);
          expect(refreshRequests).toBe(2);
          expect(claims).toBe(3);
          expect(shopReads).toBe(readsBeforeLoss);
          // A failed acknowledgement is not proof of a pending transaction.
          renewed = await authorizer.readCredentials(tokens[1], cipher);
          expect(renewed.revision).toBe(7);
          expect(renewed.credentials!.refreshToken).not.toBe(previousRefreshToken);
          expect(renewed.expectedUserId).toBe(users[1].userId);
          const [completed] = await db`select c.refresh_id,g.downstream_session_id
            from private.mcp_credentials c join private.mcp_grants g on g.id=c.grant_id
            where g.id=${original.grantId}::uuid`;
          expect(completed).toEqual({
            refresh_id: null,
            downstream_session_id: binding.downstream_session_id,
          });
          const recovered = await networkCall(tokens[1]);
          expect(recovered.status).toBe(200);
          expect(recovered.body.result.structuredContent.data.currency).toBe('USD');
          expect(shopReads).toBe(readsBeforeLoss + 1);
          expect(refreshRequests).toBe(2);
          expect(claims).toBe(3);
        } finally {
          releaseReads.resolve();
          if (mcpProcess!.exitCode === null) {
            mcpProcess!.kill('SIGTERM');
            await mcpProcess!.exited;
          }
          await proxy.stop(true);
          await writeFile(configPath, directConfig, { mode: 0o600 });
          await startMcp!();
        }
        expect((await networkCall(tokens[1])).status).toBe(200);
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
        expect(restored.revision).toBe(7);
        expect(restored.credentials).not.toBeNull();
        expect((await authorizer.authorize(rotated.data.access_token)).grantId).toBe(before.grantId);
        expect(
          (await networkCall(rotated.data.access_token)).body.result.structuredContent.data.currency,
        ).toBe('USD');
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
        // Abort after real Auth refresh starts, before it can complete. A lost
        // result must leave a durable pending claim, not permission to retry.
        await authorizer.writeCredentials(next.data.access_token, cipher, {
          expectedRevision: renewed.revision,
          credentials: { ...renewed.credentials!, expiresAt: Math.floor(Date.now() / 1000) + 20 },
          anonKey: ANON_KEY,
        });
        const abort = new AbortController();
        let pendingRefreshId: string | undefined;
        const disconnected = await heldTransactionRace(
          db,
          (tx) => tx`lock table auth.refresh_tokens in share mode`,
          () =>
            networkCall(next.data.access_token, abort.signal).then(
              () => 'responded',
              () => 'disconnected',
            ),
          async () => {
            const [pending] = await db`select revision,refresh_id from private.mcp_credentials
              where grant_id=${original.grantId}::uuid`;
            expect(Number(pending.revision)).toBe(8);
            expect(pending.refresh_id).not.toBeNull();
            pendingRefreshId = pending.refresh_id;
            abort.abort();
            // Stop before releasing Auth's DB barrier. Successful drain proves
            // the local refresh wait ended; it does not prove Auth rolled back.
            const child = mcpProcess!;
            child.kill('SIGTERM');
            const watchdog = setTimeout(() => child.kill('SIGKILL'), 5000);
            try {
              expect(await child.exited).toBe(0);
            } finally {
              clearTimeout(watchdog);
            }
          },
        );
        expect(disconnected).toBe('disconnected');
        await startMcp!();
        for (let attempt = 0; attempt < 2; attempt++) {
          expect(await networkCall(next.data.access_token)).toEqual({
            status: 503,
            body: { error: 'authorization_unavailable' },
          });
          const [pending] = await db`select revision,refresh_id from private.mcp_credentials
            where grant_id=${original.grantId}::uuid`;
          expect(Number(pending.revision)).toBe(8);
          expect(pending.refresh_id).toBe(pendingRefreshId);
        }
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
        expect((await networkCall(next.data.access_token)).status).toBe(401);
        if (browserRedirect) {
          const user = await signup();
          users.push(user);
          await makeAdmin(user.userId);
          const interrupted = await signup();
          users.push(interrupted);
          await makeAdmin(interrupted.userId);
          const offline = await signup();
          users.push(offline);
          await makeAdmin(offline.userId);
          const lostResponse = await signup();
          users.push(lostResponse);
          await makeAdmin(lostResponse.userId);
          const discardedReceipt = await signup();
          users.push(discardedReceipt);
          await makeAdmin(discardedReceipt.userId);
          await verifyOidcBrowser({
            node, origin, resource, redirect: browserRedirect,
            email: user.email, interruptedEmail: interrupted.email, offlineEmail: offline.email,
            lostResponseEmail: lostResponse.email,
            discardedReceiptEmail: discardedReceipt.email,
            interruptApproval: async (submit, disconnect) => {
              const blocker = postgres(process.env.DB_URL!, { max: 1 });
              try {
                await blocker`begin`;
                await blocker`set local statement_timeout='30s'`;
                await blocker`lock table private.mcp_credentials in access exclusive mode`;
                const [owner] = await blocker`select pg_backend_pid() as pid`;
                await submit();
                const deadline = Date.now() + 5000;
                for (;;) {
                  const [waiter] = await db`select exists(select 1 from pg_stat_activity
                    where ${owner.pid}::integer=any(pg_blocking_pids(pid))) as blocked`;
                  if (waiter.blocked) break;
                  if (Date.now() >= deadline) throw new Error('Browser approval did not reach credential barrier');
                  await Bun.sleep(10);
                }
                const [before] = await db`select state from private.mcp_grants
                  where binding->>'project'=${project} and user_id=${lostResponse.userId}::uuid`;
                expect(before.state).toBe('active');
                await disconnect();
              } finally {
                await blocker`rollback`;
                await blocker.end();
              }
              const deadline = Date.now() + 10_000;
              for (;;) {
                const [grant] = await db`select id,state,binding from private.mcp_grants
                  where binding->>'project'=${project} and user_id=${lostResponse.userId}::uuid`;
                const [attempt] = await store!`select state from oidc.approval_attempts
                  where binding->>'subject'=${lostResponse.userId}`;
                if (attempt?.state === 'revoked' || attempt?.state === 'completed') {
                  const credentials = await db`select revision from private.mcp_credentials where grant_id=${grant.id}`;
                  const upstream = await new (createOidcAdapter(store!))('Grant').find(grant.binding.session_id);
                  if (attempt.state === 'revoked') {
                    expect(grant.state).toBe('revoked');
                    expect(credentials).toHaveLength(0);
                    expect(upstream).toBeUndefined();
                  } else {
                    // A successful server send is not proof the browser received
                    // it. This legitimate outcome must not be called rollback.
                    expect(grant.state).toBe('active');
                    expect(credentials).toHaveLength(1);
                    expect(Number(credentials[0].revision)).toBe(1);
                    expect(upstream?.accountId).toBe(lostResponse.userId);
                  }
                  expect(await store!`select 1 from oidc.artifacts
                    where grant_id=${grant.binding.session_id} and not destroyed
                    and model in ('AuthorizationCode','AccessToken','RefreshToken')`).toHaveLength(0);
                  console.log(`Browser lost-response terminal journal: ${attempt.state}`);
                  break;
                }
                if (Date.now() >= deadline) throw new Error(
                  `Disconnected approval terminal state: grant=${grant?.state}, journal=${attempt?.state}`,
                );
                await Bun.sleep(20);
              }
            },
          });
          expect(await db`select id from private.mcp_grants
            where binding->>'project'=${project} and user_id=${interrupted.userId}::uuid`).toHaveLength(0);
          expect(await db`select id from private.mcp_grants
            where binding->>'project'=${project} and user_id=${offline.userId}::uuid`).toHaveLength(0);
          expect(await db`select id from private.mcp_grants
            where binding->>'project'=${project} and user_id=${lostResponse.userId}::uuid`).toHaveLength(1);
          const completedGrants = await db`select id,state,binding from private.mcp_grants
            where binding->>'project'=${project} and user_id=${discardedReceipt.userId}::uuid`;
          expect(completedGrants).toHaveLength(1);
          const completed = completedGrants[0];
          expect(completed.state).toBe('active');
          const [attempt] = await store!`select state from oidc.approval_attempts
            where binding->>'subject'=${discardedReceipt.userId}`;
          expect(attempt.state).toBe('completed');
          const credentials = await db`select revision from private.mcp_credentials where grant_id=${completed.id}`;
          expect(credentials).toHaveLength(1);
          expect(Number(credentials[0].revision)).toBe(1);
          const upstream = await new (createOidcAdapter(store!))('Grant').find(completed.binding.session_id);
          expect(upstream?.accountId).toBe(discardedReceipt.userId);
          expect(await store!`select 1 from oidc.artifacts
            where grant_id=${completed.binding.session_id} and not destroyed
            and model in ('AuthorizationCode','AccessToken','RefreshToken')`).toHaveLength(0);
          const approvedGrants = await db`select state from private.mcp_grants
            where binding->>'project'=${project} and user_id=${user.userId}::uuid`;
          expect(approvedGrants).toHaveLength(1);
          expect(approvedGrants[0].state).toBe('active');
        }
        mcpProcess!.kill('SIGTERM');
        expect(await mcpProcess!.exited).toBe(0);
      }
    } finally {
      try {
        try {
          for (const session of sessions) await session.close();
        } finally {
          if (mcpProcess && mcpProcess.exitCode === null) {
            mcpProcess.kill('SIGKILL');
            await mcpProcess.exited;
          }
          if (mcpDirectory) await rm(mcpDirectory, { recursive: true, force: true });
          await node?.close();
          if (server)
            await new Promise<void>((resolve, reject) =>
              server!.close((error) => (error ? reject(error) : resolve())),
            );
        }
      } finally {
        try {
          await db`delete from private.mcp_grants where binding->>'project'=${project}`;
          await db`delete from private.mcp_grant_fences where binding->>'project'=${project}`;
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
  }, timeout);
