import { createHash, timingSafeEqual } from 'node:crypto';

const cookieName = '__Host-tera-mcp-login';
const cookieFlags = 'Path=/; Secure; HttpOnly; SameSite=Lax';
const digest = (value: string) => createHash('sha256').update(value).digest();
const randomToken = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');

// Ephemeral login-transaction sessions, NOT authenticated users or MCP sessions.
// One process owns the store. Restart loses all sessions; never adopt a supplied ID.
export function createLoginBrowserSessions(publicOrigin: string) {
  let origin: URL;
  try {
    origin = new URL(publicOrigin);
    if (origin.protocol !== 'https:' || origin.href !== `${origin.origin}/`)
      throw new Error('Invalid origin');
  } catch {
    throw new Error('INVALID_BROWSER_SESSION_ORIGIN');
  }
  const sessions = new Map<string, { expiresAt: number; csrfDigest: Buffer }>();

  function checkOrigin(request: Request) {
    const url = new URL(request.url);
    if (url.origin !== origin.origin || url.username || url.password || url.hash)
      throw new Error('BROWSER_SESSION_REJECTED');
    // Do not reconstruct origins from Host, Forwarded or X-Forwarded-*.
  }

  function read(request: Request, mutation: boolean): string {
    try {
      checkOrigin(request);
      if (request.method !== (mutation ? 'POST' : 'GET')) throw new Error('Invalid request method');
      const header = request.headers.get('cookie') ?? '';
      if (header.length > 8192) throw new Error('Cookie header too large');
      const matches = header
        .split(';')
        .map((part) => part.trim())
        .filter((part) => part.split('=', 1)[0].trim() === cookieName);
      if (matches.length !== 1) throw new Error('Missing or duplicate login cookie');
      const value = matches[0].slice(cookieName.length + 1);
      if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error('Invalid login cookie');
      const key = digest(value).toString('hex');
      const session = sessions.get(key);
      if (!session || Date.now() >= session.expiresAt) {
        sessions.delete(key);
        throw new Error('Expired login session');
      }
      if (mutation) {
        const csrf = request.headers.get('x-csrf-token') ?? '';
        if (
          request.headers.get('origin') !== origin.origin ||
          !/^[A-Za-z0-9_-]{43}$/.test(csrf) ||
          !timingSafeEqual(session.csrfDigest, digest(csrf))
        )
          throw new Error('Invalid CSRF proof');
      }
      return value;
    } catch {
      throw new Error('BROWSER_SESSION_REJECTED');
    }
  }

  return {
    // Host renders csrfToken into its private no-store page; only Set-Cookie
    // carries the browser ID. The issue route still needs bootstrap/rate limits.
    issue() {
      const now = Date.now();
      for (const [key, session] of sessions) if (now >= session.expiresAt) sessions.delete(key);
      if (sessions.size >= 1024) throw new Error('BROWSER_SESSION_CAPACITY');
      const value = randomToken(),
        csrfToken = randomToken();
      sessions.set(digest(value).toString('hex'), {
        expiresAt: now + 300_000,
        csrfDigest: digest(csrfToken),
      });
      return { setCookie: `${cookieName}=${value}; ${cookieFlags}; Max-Age=300`, csrfToken };
    },
    // GET callbacks rely on the independent state + PKCE check in login.ts.
    // A valid cookie alone never authorizes a login or a grant approval.
    read,
    revoke(request: Request) {
      const value = read(request, true);
      sessions.delete(digest(value).toString('hex'));
      return `${cookieName}=; ${cookieFlags}; Max-Age=0`;
    },
  };
}
