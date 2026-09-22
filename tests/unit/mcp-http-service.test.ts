import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpsRequest } from 'node:https';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startAdminHttpService } from '../../mcp/src/http-service';
import { createCredentialCipher } from '../../mcp/src/credentials';

test('real Bun TLS service enforces private configuration and serves an authenticated SDK client', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tera-http-'));
  let service: Awaited<ReturnType<typeof startAdminHttpService>> | undefined;
  let backend: ReturnType<typeof Bun.serve> | undefined;
  const client = new Client({ name: 'network-test', version: '1' });
  try {
    const generated = Bun.spawnSync(
      [
        'openssl',
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:P-256',
        '-nodes',
        '-keyout',
        join(directory, 'key.pem'),
        '-out',
        join(directory, 'cert.pem'),
        '-days',
        '1',
        '-subj',
        '/CN=127.0.0.1',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
      ],
      { stdout: 'ignore', stderr: 'ignore' },
    );
    expect(generated.exitCode).toBe(0);
    const cert = await Bun.file(join(directory, 'cert.pem')).text();
    const key = await Bun.file(join(directory, 'key.pem')).text();
    const material = crypto.getRandomValues(new Uint8Array(32));
    const cipher = await createCredentialCipher(new Map([['test', material]]), 'test');
    const userId = crypto.randomUUID(),
      grantId = crypto.randomUUID();
    const resource = 'https://127.0.0.1/mcp';
    const envelope = await cipher.seal(
      { project: 'test', userId, grantId, revision: 1 },
      {
        accessToken: 'downstream',
        refreshToken: 'refresh',
        expiresAt: Math.floor(Date.now() / 1000) + 300,
      },
    );
    let active = true;
    let credentialReads = 0;
    let grantReads = 0;
    let hold = false;
    let slowBody = false;
    const slowArrived = Promise.withResolvers<void>();
    const arrived = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let stalled:
      | {
          arrived: ReturnType<typeof Promise.withResolvers<void>>;
          aborted: ReturnType<typeof Promise.withResolvers<void>>;
          release: ReturnType<typeof Promise.withResolvers<void>>;
          calls: number;
        }
      | undefined;
    backend = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === '/introspect') {
          if (stalled) {
            const current = stalled;
            current.calls++;
            const aborted = () => current.aborted.resolve();
            req.signal.addEventListener('abort', aborted, { once: true });
            current.arrived.resolve();
            try {
              await current.release.promise;
            } finally {
              req.signal.removeEventListener('abort', aborted);
            }
          }
          if (slowBody) slowArrived.resolve();
          if (hold) {
            arrived.resolve();
            await release.promise;
          }
          return Response.json({
            active,
            token_type: 'Bearer',
            token_kind: 'AccessToken',
            iss: backend!.url.origin,
            aud: resource,
            sub: userId,
            client_id: 'agent',
            grant_id: grantId,
            exp: Math.floor(Date.now() / 1000) + 300,
            scope: 'store:read',
          });
        }
        if (path.endsWith('/mcp_grant_command')) {
          grantReads++;
          return Response.json({
            id: grantId,
            user_id: userId,
            scopes: ['store:read'],
            state: 'active',
            version: 1,
          });
        }
        if (path.endsWith('/mcp_credential_command')) {
          credentialReads++;
          return Response.json({ revision: 1, envelope });
        }
        return new Response(null, { status: 404 });
      },
    });
    const config = {
      authorization: {
        issuer: backend.url.origin,
        resource,
        introspectionEndpoint: `${backend.url.origin}/introspect`,
        introspectionClientId: 'resource',
        introspectionClientSecret: 'secret',
        project: 'test',
        supabaseUrl: backend.url.origin,
        serviceRoleKey: 'service',
        anonKey: 'public',
        scopes: ['store:read'],
        allowWrites: false,
      },
      credentialKeys: { test: Buffer.from(material).toString('base64url') },
      activeCredentialKey: 'test',
      tls: { key, cert },
      listen: { host: '127.0.0.1', port: 0 },
    };
    const path = join(directory, 'config.json');
    const save = (value: unknown) => writeFile(path, JSON.stringify(value), { mode: 0o600 });
    await save(config);
    await chmod(path, 0o644);
    await expect(startAdminHttpService(path)).rejects.toThrow('MCP_HTTP_START_FAILED');
    await chmod(path, 0o600);
    for (const invalid of [
      { ...config, activeCredentialKey: 'missing' },
      { ...config, authorization: { ...config.authorization, resource: 'https://wrong.example/mcp' } },
      { ...config, unexpected: true },
    ]) {
      await save(invalid);
      await expect(startAdminHttpService(path)).rejects.toThrow(/^MCP_HTTP_START_FAILED$/);
    }
    await save(config);
    service = await startAdminHttpService(path);
    const local = (route: string, init: RequestInit = {}) =>
      fetch(`https://127.0.0.1:${service!.port}${route}`, {
        ...init,
        tls: { ca: cert },
        signal: init.signal ?? AbortSignal.timeout(5000),
        headers: { host: '127.0.0.1', ...Object.fromEntries(new Headers(init.headers)) },
      });
    const metadata = await local('/.well-known/oauth-protected-resource/mcp');
    expect(metadata.status).toBe(200);
    expect((await metadata.json()).resource).toBe(resource);
    const missing = await local('/mcp');
    expect(missing.status).toBe(401);
    await missing.body?.cancel();
    for (const headers of [
      new Headers({ host: 'evil.example' }),
      new Headers({ 'x-forwarded-host': '127.0.0.1' }),
      new Headers({ origin: 'https://evil.example' }),
    ]) {
      const rejected = await local('/mcp', { headers });
      expect(rejected.status).toBe(403);
      await rejected.body?.cancel();
    }
    await client.connect(
      new StreamableHTTPClientTransport(new URL(resource), {
        requestInit: { headers: { authorization: 'Bearer opaque' } },
        fetch: (input, init) => local(new URL(input instanceof Request ? input.url : input).pathname, init),
      }),
    );
    expect((await client.listTools()).tools.some((tool) => tool.name === 'get_admin_shop_settings')).toBe(
      true,
    );
    active = false;
    const denied = await local('/mcp', { headers: { authorization: 'Bearer opaque' } });
    expect(denied.status).toBe(401);
    await denied.body?.cancel();
    await client.close();
    active = true;
    // A live TCP connection must be cancelled, not just abandoned locally.
    // The per-introspection deadline is shorter than the service deadline.
    for (const mode of ['deadline', 'disconnect'] as const) {
      const barrier = {
        arrived: Promise.withResolvers<void>(),
        aborted: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
        calls: 0,
      };
      stalled = barrier;
      const reads = credentialReads;
      const grants = grantReads;
      const started = performance.now();
      const controller = new AbortController();
      const request = local('/mcp', {
        method: 'POST',
        headers: { authorization: 'Bearer opaque' },
        body: '{}',
        signal: controller.signal,
      });
      void request.catch(() => {});
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (async () => {
            await barrier.arrived.promise;
            if (mode === 'disconnect') {
              controller.abort();
              await expect(request).rejects.toThrow();
            } else {
              const denied = await request;
              expect(denied.status).toBe(401);
              expect(denied.headers.get('cache-control')).toBe('no-store');
              expect(await denied.json()).toEqual({ error: 'unauthorized' });
              expect(performance.now() - started).toBeGreaterThan(9000);
            }
            await barrier.aborted.promise;
            await service!.close();
            expect(barrier.calls).toBe(1);
            expect(grantReads).toBe(grants);
            expect(credentialReads).toBe(reads);
          })(),
          new Promise<never>((_, reject) => {
            watchdog = setTimeout(
              () => reject(new Error(`Stalled ${mode}`)),
              mode === 'disconnect' ? 3000 : 14_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(watchdog);
        controller.abort();
        barrier.release.resolve();
        stalled = undefined;
      }
      service = await startAdminHttpService(path);
    }
    // Keep the socket active but never finish the chunked body. The total
    // request deadline, not the idle timer, must terminate this request.
    const readsBefore = credentialReads;
    const started = performance.now();
    slowBody = true;
    const slow = httpsRequest({
      hostname: '127.0.0.1',
      port: service.port,
      path: '/mcp',
      method: 'POST',
      ca: cert,
      agent: false,
      headers: {
        host: '127.0.0.1',
        authorization: 'Bearer opaque',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
    });
    const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
      slow.on('error', reject);
      slow.on('response', (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode!, body }));
      });
    });
    slow.write('{');
    const trickle = setInterval(() => slow.write(' '), 500);
    const watchdog = setTimeout(() => slow.destroy(new Error('Deadline not enforced')), 38_000);
    try {
      await Promise.race([
        slowArrived.promise,
        response.then(() => {
          throw new Error('Missing slow-request barrier');
        }),
      ]);
      let stopped = false;
      const stopping = service.close().then(() => {
        stopped = true;
      });
      await expect(local('/mcp', { headers: { connection: 'close' } })).rejects.toThrow();
      expect(stopped).toBe(false);
      const timedOut = await response;
      expect(timedOut.status).toBe(504);
      expect(JSON.parse(timedOut.body)).toEqual({ error: 'request_timeout' });
      expect(performance.now() - started).toBeGreaterThan(28_000);
      expect(credentialReads).toBe(readsBefore);
      await stopping;
    } finally {
      clearInterval(trickle);
      clearTimeout(watchdog);
      slow.destroy();
    }
    slowBody = false;
    service = await startAdminHttpService(path);
    hold = true;
    const pending = local('/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer opaque',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }),
    });
    const result = pending.then(async (response) => ({
      status: response.status,
      body: await response.json(),
    }));
    void result.catch(() => {});
    await Promise.race([
      arrived.promise,
      result.then(() => {
        throw new Error('Missing drain barrier');
      }),
    ]);
    let closed = false;
    const closing = service.close().then(() => {
      closed = true;
    });
    try {
      await expect(local('/mcp', { headers: { connection: 'close' } })).rejects.toThrow();
      expect(closed).toBe(false);
    } finally {
      release.resolve();
    }
    expect((await result).body.result.tools.length).toBeGreaterThan(0);
    await Promise.all([closing, service.close()]);
    await expect(local('/mcp')).rejects.toThrow();
    // Real CLI, not only a same-process service object.
    const child = Bun.spawn([process.execPath, 'mcp/src/remote.ts', path], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      const reader = child.stdout.getReader();
      try {
        expect(new TextDecoder().decode((await reader.read()).value)).toBe('MCP_HTTP_READY\n');
      } finally {
        reader.releaseLock();
      }
      child.kill('SIGTERM');
      expect(await child.exited).toBe(0);
      expect(await new Response(child.stderr).text()).toBe('');
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill('SIGKILL');
      await child.exited;
    }
  } finally {
    await client.close();
    await service?.close();
    await backend?.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);
