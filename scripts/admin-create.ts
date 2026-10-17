import { localSupabase } from './lib/local-supabase';

// Local bootstrap only: promote an existing Auth user. Never creates users or passwords.
const email = process.argv[2]?.trim().toLowerCase();
if (!email || !email.includes('@')) throw new Error('Usage: bun run admin:create <email>');
const { API_URL, SERVICE_ROLE_KEY } = localSupabase();
async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`admin:create: ${init.method ?? 'GET'} ${path.split('?')[0]} returned ${response.status}`);
  return response;
}

let user: { id: string; email?: string; is_anonymous?: boolean } | undefined;
for (let page = 1; !user; page++) {
  const { users } = (await (await request(`/auth/v1/admin/users?page=${page}&per_page=1000`)).json()) as {
    users: { id: string; email?: string; is_anonymous?: boolean }[];
  };
  user = users.find((item) => item.email?.toLowerCase() === email);
  if (users.length < 1000) break;
}
if (!user || user.is_anonymous) throw new Error(`No registered Auth user found for ${email}; sign up first`);
const updated: unknown[] = await (
  await request(`/rest/v1/profiles?id=eq.${user.id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ role: 'admin' }),
  })
).json();
if (updated.length !== 1) throw new Error(`Profile missing for ${email}`);
console.log(`${email} is now an admin. Reload Admin to continue.`);
