import postgres from 'postgres';
import * as z from 'zod/v4';
import { readOidcProviderConfiguration } from './oidc-host';
import { cleanupExpiredOidcPayloads, invalidateRestoredOidcAuthorization } from './oidc-maintenance';

const config = z.looseObject({ databaseUrl: z.string().url() });

async function main() {
  // Match the authorization service's supported database runtime.
  if (process.versions.bun || Number(process.versions.node.split('.')[0]) !== 22 || !process.release.lts)
    throw new Error('runtime');
  if (process.argv.length < 4 || process.argv.length > 5) throw new Error('arguments');
  const operation = process.argv[2];
  const path = process.argv[3]!;
  const parsed = config.parse(await readOidcProviderConfiguration(path));
  const url = new URL(parsed.databaseUrl);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !url.username ||
    !url.password ||
    url.pathname === '/' ||
    url.search ||
    url.hash
  )
    throw new Error('database');
  const database = postgres(parsed.databaseUrl, {
    max: 1,
    connect_timeout: 5,
    ssl: ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ? false : 'verify-full',
    onnotice: () => {},
  });
  try {
    const result = await (async () => {
      if (operation === 'cleanup') {
        const raw = process.argv[4];
        const limit = raw === undefined ? 100 : Number(raw);
        return { artifactsCleaned: await cleanupExpiredOidcPayloads(database, limit) };
      }
      if (operation === 'invalidate-restored-authorization' && process.argv[4] === undefined)
        return invalidateRestoredOidcAuthorization(database);
      throw new Error('operation');
    })();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await database.end({ timeout: 5 });
  }
}

try {
  await main();
} catch {
  process.stderr.write('OIDC_MAINTENANCE_FAILED\n');
  process.exitCode = 1;
}
