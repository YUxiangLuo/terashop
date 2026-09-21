// Read only the unique recipient's real local SMTP message, not Auth's database
// token or admin generateLink. Never follow a link outside this project's Auth.
export async function authMessages(email: string): Promise<Array<{ ID: string }>> {
  const base = process.env.MAILPIT_URL;
  if (!base) throw new Error('Mail tests require the local Supabase test runner');
  const response = await fetch(`${base}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error(`Mailpit search failed: ${response.status}`);
  const list = await response.json() as { messages: Array<{ ID: string; To: Array<{ Address: string }> }> };
  return list.messages.filter(row => row.To.some(to => to.Address.toLowerCase() === email.toLowerCase()));
}

export async function authMail(email: string, type: 'signup' | 'email_change' | 'recovery' | 'magiclink',
  excludeIds: string[] = []): Promise<URL> {
  const base = process.env.MAILPIT_URL;
  const api = process.env.API_URL;
  if (!base || !api) throw new Error('Mail tests require the local Supabase test runner');
  const deadline = Date.now() + 10_000;
  do {
    for (const row of await authMessages(email)) {
      if (excludeIds.includes(row.ID)) continue;
      const detail = await fetch(`${base}/api/v1/message/${encodeURIComponent(row.ID)}`, { signal: AbortSignal.timeout(3000) });
      if (!detail.ok) throw new Error(`Mailpit message failed: ${detail.status}`);
      const message = await detail.json() as { HTML: string };
      for (const match of message.HTML.matchAll(/href="([^"]+)"/g)) {
        const url = new URL(match[1].replaceAll('&amp;', '&'));
        if (url.searchParams.get('type') !== type) continue;
        if (url.origin !== new URL(api).origin || url.pathname !== '/auth/v1/verify' || !url.searchParams.get('token')) {
          throw new Error('Unexpected Auth confirmation link');
        }
        return url;
      }
    }
    await Bun.sleep(100);
  } while (Date.now() < deadline);
  throw new Error(`No local ${type} email received within 10 seconds`);
}
