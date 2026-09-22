import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, chmod, symlink, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request } from 'node:https';
import { createServer as createHttpServer } from 'node:http';
import type Provider from 'oidc-provider';
import { createOidcTlsHandler, readOidcProviderConfiguration } from '../../mcp/src/oidc-host';

test('provider secrets require a bounded private regular JSON file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tera-oidc-file-'));
  const path = join(dir, 'config.json');
  try {
    await writeFile(path, '{"secret":"fixture"}', { mode: 0o600 });
    expect(await readOidcProviderConfiguration(path)).toEqual({ secret: 'fixture' });
    await symlink(path, join(dir, 'link'));
    for (const name of [dir, join(dir, 'link'), join(dir, 'missing'), 'relative.json'])
      await expect(readOidcProviderConfiguration(name)).rejects.toThrow(/^OIDC_CONFIGURATION_READ_FAILED$/);
    await chmod(path, 0o640);
    await expect(readOidcProviderConfiguration(path)).rejects.toThrow(/^OIDC_CONFIGURATION_READ_FAILED$/);
    await chmod(path, 0o600);
    for (const body of ['not json secret', '', ' '.repeat(65537), Buffer.from([0xff])]) {
      await writeFile(path, body);
      await expect(readOidcProviderConfiguration(path)).rejects.toThrow(/^OIDC_CONFIGURATION_READ_FAILED$/);
    }
    await writeFile(path, '{}'.padEnd(65536));
    expect(await readOidcProviderConfiguration(path)).toEqual({});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('TLS authority gate rejects spoofed authority and forwarding before either handler', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tera-oidc-tls-'));
  let server: ReturnType<typeof createServer> | undefined;
  try {
    const result = Bun.spawnSync(
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
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
        '-days',
        '1',
        '-subj',
        '/CN=auth.example',
        '-addext',
        'subjectAltName=DNS:auth.example',
      ],
      { stdout: 'ignore', stderr: 'ignore' },
    );
    expect(result.exitCode).toBe(0);
    const key = await readFile(join(dir, 'key.pem')),
      cert = await readFile(join(dir, 'cert.pem'));
    let interactions = 0,
      callbacks = 0;
    const provider = {
      issuer: 'https://auth.example',
      proxy: false,
      callback: () => (_req: unknown, res: any) => {
        callbacks++;
        res.end('provider');
      },
    } as unknown as Provider;
    const handler = createOidcTlsHandler(provider, async (req, res) => {
      interactions++;
      if (req.url === '/interaction/test') {
        res.end('interaction');
        return true;
      }
      if (req.url === '/failure') throw new Error('private backend detail');
      return false;
    });
    const plain = createHttpServer(handler);
    await new Promise<void>((resolve) => plain.listen(0, '127.0.0.1', resolve));
    try {
      const address = plain.address();
      if (!address || typeof address === 'string') throw new Error('Missing listener');
      const response = await fetch(`http://127.0.0.1:${address.port}/`, {
        headers: { host: 'auth.example' },
      });
      expect(response.status).toBe(403);
      await response.body?.cancel();
      expect(interactions).toBe(0);
    } finally {
      await new Promise<void>((resolve) => plain.close(() => resolve()));
    }
    server = createServer({ key, cert }, handler);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing listener');
    const call = (path: string, headers: Record<string, string> = {}) =>
      new Promise<{ status: number; body: string; cache?: string }>((resolve, reject) => {
        const req = request(
          {
            hostname: '127.0.0.1',
            port: address.port,
            path,
            servername: 'auth.example',
            ca: cert,
            headers: { host: 'auth.example', ...headers },
          },
          (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (s) => {
              body += s;
            });
            res.on('end', () =>
              resolve({ status: res.statusCode!, body, cache: res.headers['cache-control'] }),
            );
          },
        );
        req.on('error', reject);
        req.end();
      });
    for (const [name, value] of [
      ['host', 'evil.example'],
      ['forwarded', 'host=auth.example;proto=https'],
      ['x-forwarded-proto', 'https'],
    ]) {
      const result = await call('/.well-known/openid-configuration', { [name]: value });
      expect(result.status).toBe(403);
      expect(result.cache).toBe('no-store');
    }
    expect(interactions).toBe(0);
    expect(callbacks).toBe(0);
    expect((await call('/interaction/test')).body).toBe('interaction');
    expect(callbacks).toBe(0);
    expect((await call('/.well-known/openid-configuration')).body).toBe('provider');
    expect(callbacks).toBe(1);
    expect((await call('/failure')).body).toBe('{"error":"OIDC_REQUEST_FAILED"}');
    provider.proxy = true;
    expect((await call('/.well-known/openid-configuration')).status).toBe(403);
    expect(() => createOidcTlsHandler(provider, async () => false)).toThrow(
      'INVALID_OIDC_HOST_CONFIGURATION',
    );
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
