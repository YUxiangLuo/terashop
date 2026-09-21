import { expect, spyOn, test } from 'bun:test';
import { createLoginBrowserSessions } from '../../mcp/src/browser-sessions';
import { createDownstreamLogin } from '../../mcp/src/login';

const origin = 'https://host.example';
function fixture() {
  const store = createLoginBrowserSessions(origin);
  const issued = store.issue();
  const cookie = issued.setCookie.split(';')[0];
  const get = () => new Request(`${origin}/callback`, { headers: { cookie } });
  const post = (extra: Record<string, string> = {}) =>
    new Request(`${origin}/consent`, {
      method: 'POST',
      headers: { cookie, origin, 'x-csrf-token': issued.csrfToken, ...extra },
    });
  return { store, issued, cookie, get, post };
}

test('host-only cookie has secure attributes and POST requires independent same-session CSRF proof', () => {
  const f = fixture();
  expect(f.issued.setCookie).toMatch(
    /^__Host-tera-mcp-login=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=300$/,
  );
  const id = f.store.read(f.get(), false);
  expect(f.issued.csrfToken).not.toBe(id);
  expect(f.store.read(f.post(), true)).toBe(id);
  const invalidHeaders: Record<string, string>[] = [
    { origin: 'https://evil.example' },
    { origin: '' },
    { 'x-csrf-token': '' },
    { 'x-csrf-token': f.store.issue().csrfToken },
  ];
  for (const headers of invalidHeaders)
    expect(() => f.store.read(f.post(headers), true)).toThrow(/^BROWSER_SESSION_REJECTED$/);
  expect(() => f.store.read(f.get(), true)).toThrow(/^BROWSER_SESSION_REJECTED$/);
  expect(() => f.store.read(f.post(), false)).toThrow(/^BROWSER_SESSION_REJECTED$/);
});

test('unknown, duplicate and malformed cookies and spoofed destinations are rejected', () => {
  const f = fixture();
  for (const cookie of [
    '',
    `${f.cookie}; ${f.cookie}`,
    `${f.cookie}; ${f.cookie.replace('=', ' =')}`,
    '__Host-tera-mcp-login=' + 'x'.repeat(43),
    f.cookie.replace('=', '="') + '"',
    f.cookie + '=extra',
    'x'.repeat(8193),
  ])
    expect(() => f.store.read(new Request(`${origin}/callback`, { headers: { cookie } }), false)).toThrow(
      /^BROWSER_SESSION_REJECTED$/,
    );
  expect(() =>
    f.store.read(
      new Request('https://evil.example/callback', {
        headers: { cookie: f.cookie, host: 'host.example', 'x-forwarded-host': 'host.example' },
      }),
      false,
    ),
  ).toThrow(/^BROWSER_SESSION_REJECTED$/);
  expect(() => createLoginBrowserSessions(origin).read(f.get(), false)).toThrow(/^BROWSER_SESSION_REJECTED$/);
});

test('browser sessions require a fixed HTTPS origin even in development', () => {
  for (const url of [
    'invalid',
    'http://127.0.0.1',
    `${origin}/path`,
    `${origin}?x=1`,
    'https://user@host.example',
  ])
    expect(() => createLoginBrowserSessions(url)).toThrow(/^INVALID_BROWSER_SESSION_ORIGIN$/);
});

test('expiry, explicit revocation and bounded capacity cannot evict a live session silently', () => {
  const clock = spyOn(Date, 'now').mockReturnValue(2_000_000_000_000);
  try {
    const f = fixture();
    clock.mockReturnValue(2_000_000_299_999);
    expect(f.store.read(f.get(), false)).toBeTruthy();
    clock.mockReturnValue(2_000_000_300_000);
    expect(() => f.store.read(f.get(), false)).toThrow(/^BROWSER_SESSION_REJECTED$/);
    const revoked = fixture();
    expect(revoked.store.revoke(revoked.post())).toContain('Max-Age=0');
    expect(() => revoked.store.read(revoked.get(), false)).toThrow(/^BROWSER_SESSION_REJECTED$/);
    const full = fixture();
    for (let i = 1; i < 1024; i++) full.store.issue();
    expect(() => full.store.issue()).toThrow(/^BROWSER_SESSION_CAPACITY$/);
    expect(full.store.read(full.get(), false)).toBeTruthy();
    clock.mockReturnValue(2_000_000_600_000);
    expect(full.store.issue().setCookie).toContain('Max-Age=300');
  } finally {
    clock.mockRestore();
  }
});

test('only the original live browser cookie can reach the PKCE exchange', async () => {
  const f = fixture();
  let requests = 0;
  const login = await createDownstreamLogin(
    {
      supabaseUrl: 'https://auth.example',
      anonKey: 'public',
      callbackUrl: `${origin}/callback`,
      browserSession: f.store.read(f.get(), false),
    },
    async () => {
      requests++;
      throw new Error('offline');
    },
  );
  const callback = new URL(login.redirectTo);
  callback.searchParams.set('code', 'code');
  const other = f.store.issue();
  const foreignRequest = new Request(callback, { headers: { cookie: other.setCookie.split(';')[0] } });
  await expect(login.exchange(callback.href, f.store.read(foreignRequest, false))).rejects.toThrow(
    /^LOGIN_CALLBACK_REJECTED$/,
  );
  expect(requests).toBe(0);
  await expect(login.exchange(callback.href, f.store.read(f.get(), false))).rejects.toThrow(
    /^LOGIN_EXCHANGE_UNCONFIRMED$/,
  );
  expect(requests).toBe(1);
});
