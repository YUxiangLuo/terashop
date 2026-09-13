import { localSupabase } from './lib/local-supabase';

localSupabase(); // Refuse reset unless this project's local services are available.
const reset = Bun.spawn(['bunx', '--no-install', 'supabase', 'db', 'reset', '--local',
  '--network-id', 'tera-headless-loopback'], { stdout: 'inherit', stderr: 'inherit' });
if (await reset.exited !== 0) process.exit(reset.exitCode ?? 1);
await import('./seed-media');
