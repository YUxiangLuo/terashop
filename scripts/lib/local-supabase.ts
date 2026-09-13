export interface LocalSupabase {
  API_URL: string;
  DB_URL: string;
  MAILPIT_URL: string;
  ANON_KEY: string;
  SERVICE_ROLE_KEY: string;
}

export function validateLocalSupabase(value: Record<string, unknown>): LocalSupabase {
  for (const name of ['API_URL', 'DB_URL', 'MAILPIT_URL', 'ANON_KEY', 'SERVICE_ROLE_KEY'] as const) {
    if (typeof value[name] !== 'string' || !value[name]) throw new Error(`Local Supabase is missing ${name}`);
  }
  for (const name of ['API_URL', 'DB_URL', 'MAILPIT_URL'] as const) {
    const url = new URL(value[name] as string);
    const protocols = name === 'DB_URL' ? ['postgres:', 'postgresql:'] : ['http:', 'https:'];
    if (!protocols.includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      throw new Error(`${name} must refer to local Supabase; refusing a non-local test target`);
    }
  }
  return {
    API_URL: value.API_URL as string, DB_URL: value.DB_URL as string,
    MAILPIT_URL: value.MAILPIT_URL as string,
    ANON_KEY: value.ANON_KEY as string, SERVICE_ROLE_KEY: value.SERVICE_ROLE_KEY as string,
  };
}

// Never inherit an arbitrary shell DB_URL or eval CLI output. Check failure
// before starting tests/reset, and keep local credentials out of logs.
export function localSupabase(): LocalSupabase {
  const status = Bun.spawnSync(['bunx', '--no-install', 'supabase', 'status', '-o', 'json']);
  if (status.exitCode !== 0) throw new Error('Local Supabase is unavailable; run bun run start');
  return validateLocalSupabase(JSON.parse(status.stdout.toString()));
}
