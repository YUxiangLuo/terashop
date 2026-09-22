// Opt-in supported-runtime check. No public listener, real accounts or Supabase access.
// Bun owns dependency installation/build; only the authorization service runs Node LTS.
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const image = 'node:22-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9';
const postgresImage =
  'postgres:17-bookworm@sha256:639ab7ceb90e13123085b741fb31ef493fba25463002f6da665352e7b534b652';
const storage = Bun.argv.includes('--with-storage');
if (Bun.argv.slice(2).some((arg) => arg !== '--with-storage')) throw new Error('Unknown argument');
const root = resolve(import.meta.dir, '..');
const directory = await mkdtemp(join(tmpdir(), 'tera-oidc-compat-'));
const name = `tera-oidc-compat-${crypto.randomUUID()}`;
const network = `${name}-network`;
const database = `${name}-db`;

async function docker(args: string[], input?: string) {
  const child = Bun.spawn(['docker', ...args], {
    stdin: input === undefined ? 'ignore' : new Blob([input]),
    stdout: 'ignore',
    stderr: 'pipe',
  });
  // Drain errors but never print SQL/passwords or Docker's command echo.
  await new Response(child.stderr).text();
  if ((await child.exited) !== 0) throw new Error(`Docker ${args[0]} failed`);
}
try {
  await chmod(directory, 0o755);
  await mkdir(join(directory, 'node_modules'));
  if (storage) {
    await docker(['network', 'create', '--internal', network]);
    const password = crypto.randomUUID().replaceAll('-', '');
    await docker([
      'run',
      '-d',
      '--rm',
      '--name',
      database,
      '--network',
      network,
      '--network-alias',
      'oidc-db',
      '--memory',
      '512m',
      '--cpus',
      '1',
      '--pids-limit',
      '128',
      '--tmpfs',
      '/var/lib/postgresql/data',
      '-e',
      `POSTGRES_PASSWORD=${crypto.randomUUID().replaceAll('-', '')}`,
      postgresImage,
    ]);
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      const check = Bun.spawnSync(
        ['docker', 'exec', database, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'],
        { stdout: 'ignore', stderr: 'ignore' },
      );
      if (check.exitCode === 0) {
        ready = true;
        break;
      }
      await Bun.sleep(500);
    }
    if (!ready) throw new Error('Disposable PostgreSQL did not become ready');
    await docker(
      ['exec', '-i', database, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'],
      `${await Bun.file(join(root, 'mcp/auth/storage.sql')).text()}
       create role oidc_runtime login password '${password}';
       grant usage on schema oidc to oidc_runtime;
       grant select, insert, update, delete on all tables in schema oidc to oidc_runtime;`,
    );
    await Bun.write(join(directory, 'database-url'), `postgres://oidc_runtime:${password}@oidc-db/postgres`);
    await chmod(join(directory, 'database-url'), 0o644); // Disposable credential, readable by container uid 1000.
  }
  const build = await Bun.build({
    entrypoints: (storage
      ? ['tests/support/oauth-storage-runtime.ts']
      : ['tests/support/oauth-provider-compat.ts', 'tests/support/oauth-interaction.ts']
    ).map((path) => join(root, path)),
    outdir: directory,
    target: 'node',
    external: ['oidc-provider', 'postgres'],
    naming: '[name].mjs',
  });
  if (!build.success) throw new Error('Could not build OIDC compatibility scenario');
  for (const output of build.outputs) await chmod(output.path, 0o644);
  await Bun.write(
    join(directory, 'run.mjs'),
    storage
      ? `import './oauth-storage-runtime.mjs';`
      : `
import assert from 'node:assert/strict';
import { verifyOAuthProvider } from './oauth-provider-compat.mjs';
import { verifyOAuthInteraction } from './oauth-interaction.mjs';
assert.equal(process.versions.bun, undefined);
assert.equal(process.release.lts, 'Jod');
console.log('Authorization runtime:', process.version, process.release.lts);
for (const format of ['jwt', 'opaque']) {
  await verifyOAuthProvider(format);
  console.log('PASS:', format, 'S256/resource/scope/introspection/rotation/revocation');
}
await verifyOAuthInteraction();
console.log('PASS: interaction/login/explicit consent/code issuance/failed completion cleanup');
`,
  );
  await chmod(join(directory, 'run.mjs'), 0o644);
  const child = Bun.spawn(
    [
      'docker',
      'run',
      '--rm',
      '--name',
      name,
      '--network',
      storage ? network : 'none',
      '--read-only',
      '--user',
      'node',
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
      '--workdir',
      '/check',
      image,
      'node',
      '--test',
      '--test-timeout=60000',
      'run.mjs',
    ],
    { stdout: 'inherit', stderr: 'inherit' },
  );
  if ((await child.exited) !== 0) throw new Error('Supported-runtime OIDC compatibility check failed');
} finally {
  // Also remove a container left behind by interrupted/failed docker run.
  Bun.spawnSync(['docker', 'rm', '--force', name], { stdout: 'ignore', stderr: 'ignore' });
  if (storage) {
    Bun.spawnSync(['docker', 'rm', '--force', '--volumes', database], { stdout: 'ignore', stderr: 'ignore' });
    Bun.spawnSync(['docker', 'network', 'rm', network], { stdout: 'ignore', stderr: 'ignore' });
  }
  await rm(directory, { recursive: true, force: true });
}
