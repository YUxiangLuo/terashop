// Opt-in supported-runtime check. No public listener, real accounts or Supabase access.
// Bun owns dependency installation/build; only the authorization service runs Node LTS.
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const image = 'node:22-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9';
const root = resolve(import.meta.dir, '..');
const directory = await mkdtemp(join(tmpdir(), 'tera-oidc-compat-'));
const name = `tera-oidc-compat-${crypto.randomUUID()}`;
try {
  await chmod(directory, 0o755);
  await mkdir(join(directory, 'node_modules'));
  const build = await Bun.build({
    entrypoints: [join(root, 'tests/support/oauth-provider-compat.ts')],
    outdir: directory,
    target: 'node',
    external: ['oidc-provider'],
    naming: 'scenario.mjs',
  });
  if (!build.success) throw new Error('Could not build OIDC compatibility scenario');
  await chmod(join(directory, 'scenario.mjs'), 0o644);
  await Bun.write(
    join(directory, 'run.mjs'),
    `
import assert from 'node:assert/strict';
import { verifyOAuthProvider } from './scenario.mjs';
assert.equal(process.versions.bun, undefined);
assert.equal(process.release.lts, 'Jod');
console.log('Authorization runtime:', process.version, process.release.lts);
for (const format of ['jwt', 'opaque']) {
  await verifyOAuthProvider(format);
  console.log('PASS:', format, 'S256/resource/scope/introspection/rotation/revocation');
}
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
      'none',
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
  await rm(directory, { recursive: true, force: true });
}
