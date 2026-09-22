import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { request, createServer } from 'node:https';
import { spawn } from 'node:child_process';
import postgres from 'postgres';
import { startOidcService } from '../../mcp/src/oidc-service';

// Supported-runtime service smoke test. No real downstream accounts or public ports.
export async function verifyOidcService(databaseUrl: string, tls: { key: string; cert: string }) {
  const directory = await mkdtemp(join(tmpdir(), 'tera-service-'));
  const path = join(directory, 'config.json');
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const config = {
    provider: {
      issuer: 'https://auth.example',
      resource: 'https://shop.example/mcp',
      scopes: ['store:read'],
      signingKey: { ...privateKey.export({ format: 'jwk' }), kid: 'stable', alg: 'ES256', use: 'sig' },
      cookieKeys: [randomBytes(32).toString('base64url')],
      clients: [{ id: 'agent', applicationType: 'web', redirectUris: ['https://client.example/cb'] }],
      introspectionClient: { id: 'resource', secret: randomBytes(32).toString('base64url') },
    },
    databaseUrl,
    downstream: {
      project: 'service-fixture',
      supabaseUrl: 'https://db.example',
      anonKey: 'fixture',
      serviceRoleKey: 'fixture-secret',
      callbackUrl: 'https://auth.example/callback',
    },
    credentialKeys: { test: randomBytes(32).toString('base64url') },
    activeCredentialKey: 'test',
    tls,
    listen: { host: '127.0.0.1', port: 0 },
  };
  const save = (value: unknown) => writeFile(path, JSON.stringify(value), { mode: 0o600 });
  let service: Awaited<ReturnType<typeof startOidcService>> | undefined;
  const observer = postgres(databaseUrl, { max: 1, connect_timeout: 5 });
  const get = (port: number, route: string, host = 'auth.example') =>
    new Promise<{ status: number; data: any }>((resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port,
          path: route,
          servername: 'auth.example',
          ca: tls.cert,
          headers: { host },
          agent: false,
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (part) => {
            body += part;
          });
          res.on('error', reject);
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode!, data: JSON.parse(body) });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.on('error', reject);
      req.setTimeout(5000, () => req.destroy(new Error('Fixture timeout')));
      req.end();
    });
  try {
    const readonly = new URL(databaseUrl);
    readonly.username = 'oidc_readonly';
    const legacy = new URL(databaseUrl);
    legacy.username = 'oidc_legacy';
    for (const invalid of [
      { ...config, activeCredentialKey: 'missing' },
      { ...config, databaseUrl: readonly.href },
      { ...config, databaseUrl: legacy.href }, // Old two-table role cannot bypass journaling.
      { ...config, provider: { ...config.provider, issuer: 'https://wrong.example' } },
    ]) {
      await save(invalid);
      await assert.rejects(startOidcService(path), /^Error: OIDC_SERVICE_START_FAILED$/);
    }
    await save(config);
    service = await startOidcService(path);
    assert(service.address && typeof service.address !== 'string');
    const port = service.address.port;
    const metadata = await get(port, '/.well-known/openid-configuration');
    assert.equal(metadata.status, 200);
    assert.equal(metadata.data.issuer, config.provider.issuer);
    assert.equal(metadata.data.token_endpoint, 'https://auth.example/token');
    assert.equal((await get(port, '/.well-known/openid-configuration', 'evil.example')).status, 403);
    const jwks = (await get(port, '/jwks')).data;
    assert.equal(jwks.keys[0].kid, 'stable');
    assert.equal(jwks.keys[0].d, undefined);
    // Still port 0: rejection must be database ownership, not a TCP bind conflict.
    await assert.rejects(startOidcService(path), /^Error: OIDC_SERVICE_START_FAILED$/);
    assert.equal((await get(port, '/jwks')).status, 200);
    config.listen.port = port;
    await save(config);
    await assert.rejects(startOidcService(path), /^Error: OIDC_SERVICE_START_FAILED$/);
    assert.equal((await get(port, '/jwks')).status, 200); // Failed start cannot close the existing service.
    await Promise.all([service.close(), service.close()]);
    service = undefined;
    await assert.rejects(get(port, '/jwks'));

    // Acquisition succeeds but listen fails: startup must release its new lock.
    const occupied = createServer(tls);
    await new Promise<void>((resolve) => occupied.listen(port, '127.0.0.1', resolve));
    try {
      await assert.rejects(startOidcService(path), /^Error: OIDC_SERVICE_START_FAILED$/);
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }

    // Separate real processes: graceful release, then physical lock-session loss.
    for (const shutdown of ['signal', 'ownership'] as const) {
      const child = spawn(process.execPath, ['/check/auth.mjs', path], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (part) => {
        stderr += part;
      });
      const exited = new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
      });
      const ready = new Promise<void>((resolve, reject) => {
        child.stdout.once('data', (part) =>
          part.toString() === 'OIDC_SERVICE_READY\n' ? resolve() : reject(new Error('Unexpected readiness')),
        );
        void exited.then(() => reject(new Error('Exited before readiness')), reject);
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
      try {
        await ready;
        assert.deepEqual((await get(port, '/jwks')).data, jwks);
        await save({ ...config, listen: { ...config.listen, port: 0 } });
        await assert.rejects(startOidcService(path), /^Error: OIDC_SERVICE_START_FAILED$/);
        await save(config);
        if (shutdown === 'signal') child.kill('SIGTERM');
        else {
          const rows = await observer`select pg_terminate_backend(pid) as terminated from pg_locks
          where locktype='advisory' and granted and classid=1952805473 and objid=1869177956
            and database=(select oid from pg_database where datname=current_database())`;
          assert.equal(rows.length, 1);
          assert.equal(rows[0].terminated, true);
        }
        assert.equal(await exited, shutdown === 'signal' ? 0 : 1);
        assert.equal(stderr, shutdown === 'signal' ? '' : 'OIDC_SERVICE_OWNERSHIP_LOST\n');
        await assert.rejects(get(port, '/jwks'));
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exited;
      }
    }
    service = await startOidcService(path); // Lost owner never reacquires; a new process may start.
    assert.equal((await get(port, '/jwks')).status, 200);
  } finally {
    await service?.close();
    await observer.end({ timeout: 5 });
    await rm(directory, { recursive: true, force: true });
  }
}
