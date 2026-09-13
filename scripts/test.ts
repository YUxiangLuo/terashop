import { localSupabase } from './lib/local-supabase';

const args = Bun.argv.slice(2);
const reset = args.includes('--reset');
const integration = args.includes('--integration');
const forwarded = args.filter(arg => arg !== '--reset' && arg !== '--integration');
// Resolve before any destructive operation; a failed status lookup must not
// fall through to tests using credentials inherited from the caller's shell.
const env = { ...process.env, ...localSupabase() };
if (reset) {
  const child = Bun.spawn(['bun', 'run', 'setup'], { env, stdout: 'inherit', stderr: 'inherit' });
  const exit = await child.exited;
  if (exit !== 0) process.exit(exit);
}
const files = integration
  ? [...new Bun.Glob('tests/**/*.test.ts').scanSync('.')].filter(path => !path.startsWith('tests/unit/')).sort()
  : [];
const child = Bun.spawn(['bun', 'test', '--parallel=1', ...files, ...forwarded], {
  env, stdout: 'inherit', stderr: 'inherit',
});
process.exitCode = await child.exited;
