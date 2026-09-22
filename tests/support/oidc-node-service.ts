import { chmod, chown, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';

// Linux-only local integration fixture. Host networking reaches the runner's
// loopback Supabase, but the service itself binds only 127.0.0.1. No proxy or mocks.
export async function nodeOidcService(configuration: Record<string, unknown>) {
  const directory = await mkdtemp(join(tmpdir(), 'tera-node-login-'));
  const name = `tera-node-login-${crypto.randomUUID()}`;
  const root = resolve(import.meta.dir, '../..');
  const uid = process.getuid!();
  const user = uid === 0 ? '1000:1000' : `${uid}:${process.getgid!()}`;
  const close = async () => {
    const stopped = Bun.spawn(['docker', 'rm', '--force', name], { stdout: 'ignore', stderr: 'ignore' });
    await stopped.exited;
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const reserve = createServer();
    await new Promise<void>((resolve) => reserve.listen(0, '127.0.0.1', resolve));
    const address = reserve.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    await new Promise<void>((resolve, reject) => reserve.close((e) => (e ? reject(e) : resolve())));
    const certificate = Bun.spawnSync(
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
    if (certificate.exitCode !== 0) throw new Error('Fixture certificate failed');
    const cert = await Bun.file(join(directory, 'cert.pem')).text();
    const path = join(directory, 'config.json');
    await writeFile(
      path,
      JSON.stringify({
        ...configuration,
        tls: { cert, key: await Bun.file(join(directory, 'key.pem')).text() },
        listen: { host: '127.0.0.1', port: address.port },
      }),
      { mode: 0o600 },
    );
    await rm(join(directory, 'key.pem'));
    const build = await Bun.build({
      entrypoints: [join(root, 'mcp/src/auth.ts')],
      outdir: directory,
      target: 'node',
      external: ['oidc-provider', 'postgres'],
      naming: '[name].mjs',
    });
    if (!build.success) throw new Error('Fixture build failed');
    await chmod(join(directory, 'auth.mjs'), 0o644);
    await mkdir(join(directory, 'node_modules'));
    // Keep private files owned by a non-root uid even when the test runner is root.
    if (uid === 0) {
      await chown(directory, 1000, 1000);
      await chown(path, 1000, 1000);
    }
    const start = async () => {
      const child = Bun.spawn(
        [
          'docker',
          'run',
          '--rm',
          '--name',
          name,
          '--network',
          'host',
          '--read-only',
          '--user',
          user,
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges',
          '--memory',
          '512m',
          '--cpus',
          '1',
          '--pids-limit',
          '64',
          '--mount',
          `type=bind,src=${directory},dst=/check,readonly`,
          '--mount',
          `type=bind,src=${join(root, 'node_modules')},dst=/check/node_modules,readonly`,
          'node:22-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9',
          'node',
          '/check/auth.mjs',
          '/check/config.json',
        ],
        { stdout: 'pipe', stderr: 'ignore' },
      );
      const ready = async () => {
        const reader = child.stdout.getReader();
        try {
          const first = await reader.read();
          if (new TextDecoder().decode(first.value) !== 'OIDC_SERVICE_READY\n')
            throw new Error('Node service did not become ready');
        } finally {
          reader.releaseLock();
        }
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          ready(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Node startup timeout')), 15000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      return child;
    };
    let child = await start();
    return {
      close,
      restart: async (whileStopping?: () => Promise<void>) => {
        const stop = Bun.spawn(['docker', 'stop', '--time', '10', name], {
          stdout: 'ignore',
          stderr: 'ignore',
        });
        await whileStopping?.();
        if ((await stop.exited) !== 0 || (await child.exited) !== 0)
          throw new Error('Node service did not shut down cleanly');
        child = await start();
      },
      crashRestart: async (afterExit: () => Promise<void>) => {
        const killed = Bun.spawn(['docker', 'kill', '--signal', 'KILL', name], {
          stdout: 'ignore',
          stderr: 'ignore',
        });
        if ((await killed.exited) !== 0 || (await child.exited) !== 137)
          throw new Error('Node service was not killed');
        await afterExit();
        child = await start();
      },
      request: (path: string, init: RequestInit = {}) =>
        fetch(`https://127.0.0.1:${address.port}${path}`, {
          ...init,
          redirect: 'manual',
          signal: AbortSignal.any([AbortSignal.timeout(10000), ...(init.signal ? [init.signal] : [])]),
          tls: { ca: cert },
          headers: { ...Object.fromEntries(new Headers(init.headers)), host: '127.0.0.1:3000' },
        }),
    };
  } catch (error) {
    await close();
    throw error;
  }
}
