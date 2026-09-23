import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { AdminBackend } from './backend';
import { createAdminServer } from './server';

try {
  const backend = new AdminBackend({
    url: process.env.TERA_SUPABASE_URL ?? '',
    anonKey: process.env.TERA_SUPABASE_ANON_KEY ?? '',
    accessToken: process.env.TERA_ADMIN_ACCESS_TOKEN ?? '',
  });
  await backend.assertAdmin();
  await serveStdio(() =>
    createAdminServer(backend, {
      allowWrites: process.env.TERA_MCP_ALLOW_WRITES === 'true',
      adminOrigin: process.env.TERA_ADMIN_ORIGIN,
    }),
  );
} catch {
  // stdout is reserved for the protocol. Never print credentials or raw errors.
  console.error(
    'Admin MCP could not start. Check Supabase origin, public key and a current non-anonymous admin session.',
  );
  process.exitCode = 1;
}
