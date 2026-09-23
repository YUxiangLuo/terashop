// Artifact-level OIDC recovery rehearsal. This intentionally does not claim to
// be a transactionally consistent backup of the rest of a Supabase deployment.
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import postgres from 'postgres';
import type { AdapterPayload } from 'oidc-provider';
import { createOidcAdapter } from '../mcp/src/oidc-adapter';

if (Bun.argv.length !== 2) throw new Error('This drill takes no arguments');

const image = 'postgres:17-bookworm@sha256:639ab7ceb90e13123085b741fb31ef493fba25463002f6da665352e7b534b652';
const nodeImage =
  'node:22-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9';
const root = resolve(import.meta.dir, '..');
const directory = await mkdtemp(join(tmpdir(), 'tera-mcp-recovery-'));
const suffix = crypto.randomUUID();
const source = `tera-mcp-recovery-source-${suffix}`;
const target = `tera-mcp-recovery-target-${suffix}`;
const password = crypto.randomUUID().replaceAll('-', '');
const archive = join(directory, 'oidc.dump');
const config = join(directory, 'maintenance.json');

async function docker(args: string[], input?: string): Promise<string> {
  const child = Bun.spawn(['docker', ...args], {
    stdin: input === undefined ? 'ignore' : new Blob([input]),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(), // Drain, but never expose command output or credentials.
  ]);
  if ((await child.exited) !== 0) throw new Error(`Docker ${args[0]} failed`);
  return stdout.trim();
}

async function startDatabase(name: string): Promise<number> {
  await docker([
    'run',
    '-d',
    '--rm',
    '--name',
    name,
    '--memory',
    '256m',
    '--cpus',
    '1',
    '--pids-limit',
    '128',
    '--tmpfs',
    '/var/lib/postgresql/data',
    '-p',
    '127.0.0.1::5432',
    '-e',
    `POSTGRES_PASSWORD=${password}`,
    image,
  ]);
  for (let attempt = 0; attempt < 60; attempt++) {
    const check = Bun.spawnSync(['docker', 'exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    if (check.exitCode === 0) {
      const mapping = await docker(['port', name, '5432/tcp']);
      const port = Number(mapping.slice(mapping.lastIndexOf(':') + 1));
      if (!Number.isSafeInteger(port) || port < 1) throw new Error('Invalid disposable database port');
      return port;
    }
    await Bun.sleep(500);
  }
  throw new Error('Disposable PostgreSQL did not become ready');
}

function databaseUrl(port: number): string {
  return `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;
}

async function runMaintenance(
  expected: { artifactsInvalidated: number; grantsRevoked: number } | { artifactsCleaned: number },
  operation = 'invalidate-restored-authorization',
) {
  const stdout = await docker([
    'run',
    '--rm',
    '--network',
    'host',
    '--memory',
    '256m',
    '--cpus',
    '1',
    '--pids-limit',
    '128',
    '--mount',
    `type=bind,src=${directory},dst=/check,readonly`,
    '--mount',
    `type=bind,src=${join(root, 'node_modules')},dst=/check/node_modules,readonly`,
    nodeImage,
    'node',
    '/check/maintenance.js',
    operation,
    '/check/maintenance.json',
  ]);
  assert.deepEqual(JSON.parse(stdout), expected, 'unexpected maintenance result');
}

let sourceDb: postgres.Sql | undefined;
let targetDb: postgres.Sql | undefined;
try {
  await mkdir(join(directory, 'node_modules'));
  const build = await Bun.build({
    entrypoints: [join(root, 'mcp/src/maintenance.ts')],
    outdir: directory,
    target: 'node',
    format: 'esm',
    external: ['postgres'],
  });
  if (!build.success) throw new Error('Maintenance build failed');
  await Bun.write(join(directory, 'package.json'), '{"type":"module"}');
  const sourcePort = await startDatabase(source);
  await docker(
    ['exec', '-i', source, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'],
    await Bun.file(join(root, 'mcp/auth/storage.sql')).text(),
  );
  sourceDb = postgres(databaseUrl(sourcePort), { ssl: false, max: 1, onnotice: () => {} });

  const grantId = `grant-${crypto.randomUUID()}`;
  const accessId = `access-${crypto.randomUUID()}`;
  const refreshId = `refresh-${crypto.randomUUID()}`;
  const interactionId = `pending-${crypto.randomUUID()}`;
  const SourceAdapter = createOidcAdapter(sourceDb);
  const Grant = new SourceAdapter('Grant');
  const AccessToken = new SourceAdapter('AccessToken');
  const RefreshToken = new SourceAdapter('RefreshToken');
  await new SourceAdapter('Session').upsert('expired-dump-fixture', { accountId: 'expired' }, 0);
  await Grant.upsert(grantId, { accountId: 'fixture-account' } as AdapterPayload, 3600);
  await AccessToken.upsert(accessId, { grantId, accountId: 'fixture-account' } as AdapterPayload, 3600);
  await RefreshToken.upsert(refreshId, { grantId, accountId: 'fixture-account' } as AdapterPayload, 3600);
  await sourceDb`insert into oidc.approval_attempts(interaction_id,binding)
    values (${interactionId},${sourceDb.json({ session_id: grantId })})`;

  // The archive precedes revocation, reproducing stale authorization after restore.
  await docker([
    'exec',
    source,
    'pg_dump',
    '-U',
    'postgres',
    '-d',
    'postgres',
    '-Fc',
    '-f',
    '/tmp/oidc.dump',
  ]);
  await docker(['cp', `${source}:/tmp/oidc.dump`, archive]);
  await Grant.revokeByGrantId!(grantId);
  assert.equal(await AccessToken.find!(accessId), undefined, 'source access token remained usable');
  assert.equal(await RefreshToken.find!(refreshId), undefined, 'source refresh token remained usable');

  const targetPort = await startDatabase(target);
  await docker(['cp', archive, `${target}:/tmp/oidc.dump`]);
  await docker([
    'exec',
    target,
    'pg_restore',
    '-U',
    'postgres',
    '-d',
    'postgres',
    '--exit-on-error',
    '/tmp/oidc.dump',
  ]);
  targetDb = postgres(databaseUrl(targetPort), { ssl: false, max: 2, onnotice: () => {} });
  const TargetAdapter = createOidcAdapter(targetDb);
  const RestoredAccess = new TargetAdapter('AccessToken');
  const RestoredRefresh = new TargetAdapter('RefreshToken');
  assert.ok(await RestoredAccess.find!(accessId), 'stale access token was not visible before maintenance');
  assert.ok(await RestoredRefresh.find!(refreshId), 'stale refresh token was not visible before maintenance');

  await Bun.write(config, JSON.stringify({ databaseUrl: databaseUrl(targetPort) }));
  await chmod(config, 0o600);
  await runMaintenance({ artifactsCleaned: 1 }, 'cleanup');
  assert.equal(
    (await targetDb`select payload from oidc.artifacts where id='expired-dump-fixture'`)[0].payload,
    null,
  );
  await runMaintenance({ artifactsInvalidated: 3, grantsRevoked: 1 });
  assert.equal(await RestoredAccess.find!(accessId), undefined, 'old access token survived maintenance');
  assert.equal(await RestoredRefresh.find!(refreshId), undefined, 'old refresh token survived maintenance');
  await assert.rejects(
    RestoredAccess.upsert!(accessId, { grantId, accountId: 'stale-save' } as AdapterPayload, 3600),
    'stale artifact save was accepted',
  );
  assert.equal(
    (await targetDb`select state from oidc.approval_attempts where interaction_id=${interactionId}`)[0]
      ?.state,
    'pending',
  );
  assert.equal(
    (await targetDb`select count(*)::int count from oidc.revoked_grants where id=${grantId}`)[0]?.count,
    1,
  );

  await runMaintenance({ artifactsInvalidated: 0, grantsRevoked: 0 });
  const freshGrant = `grant-${crypto.randomUUID()}`;
  const freshToken = `access-${crypto.randomUUID()}`;
  const FreshGrant = new TargetAdapter('Grant');
  await FreshGrant.upsert(freshGrant, { accountId: 'fresh-account' } as AdapterPayload, 3600);
  await RestoredAccess.upsert!(
    freshToken,
    { grantId: freshGrant, accountId: 'fresh-account' } as AdapterPayload,
    3600,
  );
  assert.ok(await RestoredAccess.find!(freshToken), 'fresh authorization was rejected');

  console.log('PASS: custom pg_dump/pg_restore OIDC artifact recovery rehearsal');
  console.log(
    'PASS: stale artifacts invalidated, journal retained, revocation durable, fresh authorization accepted',
  );
} finally {
  await sourceDb?.end({ timeout: 2 }).catch(() => {});
  await targetDb?.end({ timeout: 2 }).catch(() => {});
  Bun.spawnSync(['docker', 'rm', '--force', '--volumes', source], { stdout: 'ignore', stderr: 'ignore' });
  Bun.spawnSync(['docker', 'rm', '--force', '--volumes', target], { stdout: 'ignore', stderr: 'ignore' });
  await rm(directory, { recursive: true, force: true });
}
