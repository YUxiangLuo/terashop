import { expect, spyOn, test } from 'bun:test';
import { createLoginHttpHandler } from '../../mcp/src/login-http';

const origin = 'https://host.example';
const config = {
  publicOrigin: origin,
  callbackUrl: `${origin}/callback`,
  supabaseUrl: 'https://auth.example',
  anonKey: 'public',
};
const bootstrap = () =>
  new Request(`${origin}/login/session`, {
    method: 'POST',
    headers: { origin, 'x-tera-login': 'start' },
  });
async function browser(host: ReturnType<typeof createLoginHttpHandler>) {
  const response = await host.handle(bootstrap());
  expect(response.status).toBe(201);
  const cookie = response.headers.get('set-cookie')!.split(';')[0];
  const { csrfToken } = (await response.json()) as { csrfToken: string };
  const get = (path: string) => new Request(new URL(path, origin), { headers: { cookie } });
  const post = (path: string, body?: string) =>
    new Request(`${origin}${path}`, {
      method: 'POST',
      headers: { cookie, origin, 'x-csrf-token': csrfToken, 'content-type': 'application/json' },
      body,
    });
  return { get, post, cookie, csrfToken };
}
async function fixture() {
  const user = crypto.randomUUID(),
    session = crypto.randomUUID();
  const calls: string[] = [];
  const state = { callback: '', sendFails: false, onToken: async () => {} };
  const host = createLoginHttpHandler(config, async (url, init) => {
    calls.push(url);
    if (url.includes('/otp?')) {
      expect(JSON.parse(init.body as string)).toMatchObject({
        email: 'admin@example.com',
        create_user: false,
        code_challenge_method: 's256',
      });
      const callback = new URL(new URL(url).searchParams.get('redirect_to')!);
      callback.searchParams.set('code', 'code');
      state.callback = callback.href;
      if (state.sendFails) throw new Error('secret provider error');
      return Response.json({});
    }
    if (url.endsWith('grant_type=pkce')) {
      await state.onToken();
      return Response.json({
        access_token: 'secret-access',
        refresh_token: 'secret-refresh',
        token_type: 'bearer',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user: { id: user, is_anonymous: false },
      });
    }
    if (url.endsWith('/user')) return Response.json({ id: user, is_anonymous: false, role: 'authenticated' });
    if (url.endsWith('/is_admin')) return Response.json(true);
    if (url.endsWith('/get_mcp_downstream_session'))
      return Response.json({ user_id: user, session_id: session });
    throw new Error('Unexpected endpoint');
  });
  return { host, calls, state, user, session, b: await browser(host) };
}
const emailBody = JSON.stringify({ email: 'admin@example.com' });

test('HTTP login routes complete one internal handoff without returning credentials to the browser', async () => {
  const f = await fixture();
  const other = await browser(f.host);
  expect((await f.host.handle(f.b.post('/login/email', emailBody))).status).toBe(202);
  expect((await f.host.handle(other.get(f.state.callback))).status).toBe(400);
  expect(f.calls).toHaveLength(1);
  const invalid = new URL(f.state.callback);
  invalid.searchParams.append('state', 'extra');
  expect((await f.host.handle(f.b.get(invalid.href))).status).toBe(400);
  const response = await f.host.handle(f.b.get(f.state.callback));
  expect(response.status).toBe(303);
  expect(response.headers.get('location')).toBe(`${origin}/login/status`);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(await response.text()).not.toContain('secret');
  expect(await (await f.host.handle(f.b.get('/login/status'))).json()).toEqual({ status: 'authenticated' });
  expect((await f.host.handle(f.b.post('/login/approve'))).status).toBe(404);
  expect(() => f.host.takeIdentity(other.post('/login/approve'))).toThrow();
  expect(f.host.takeIdentity(f.b.post('/login/approve'))).toMatchObject({
    userId: f.user,
    sessionId: f.session,
    credentials: { accessToken: 'secret-access' },
  });
  expect(() => f.host.takeIdentity(f.b.post('/login/approve'))).toThrow();
  expect((await f.host.handle(f.b.get(f.state.callback))).status).toBe(400);
  expect(f.calls.filter((c) => c.endsWith('grant_type=pkce'))).toHaveLength(1);
});

test('CSRF, foreign origins, body limits and strict fields reject before email dispatch', async () => {
  const f = await fixture();
  for (const request of [
    new Request(`${origin}/login/session`),
    new Request(`${origin}/login/session`, {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'x-tera-login': 'start' },
    }),
    new Request(`${origin}/login/email`, {
      method: 'POST',
      headers: { cookie: f.b.cookie },
      body: emailBody,
    }),
    new Request('https://evil.example/login/status', {
      headers: { cookie: f.b.cookie, host: 'host.example' },
    }),
    f.b.post(
      '/login/email',
      JSON.stringify({ email: 'admin@example.com', redirectTo: 'https://evil.example' }),
    ),
    f.b.post('/login/email', 'x'.repeat(1025)),
  ])
    expect((await f.host.handle(request)).status).toBe(403);
  expect(f.calls).toHaveLength(0);
  expect((await f.host.handle(f.b.post('/login/email', emailBody))).status).toBe(202);
});

test('email admission is single-use under concurrency and uncertain delivery does not leak provider errors', async () => {
  for (const fails of [false, true]) {
    const f = await fixture();
    f.state.sendFails = fails;
    const responses = await Promise.all([1, 2].map(() => f.host.handle(f.b.post('/login/email', emailBody))));
    expect(responses.map((r) => r.status).sort()).toEqual([202, 409]);
    expect(await responses.find((r) => r.status === 202)!.json()).toEqual({ status: 'email_requested' });
    expect(await (await f.host.handle(f.b.get('/login/status'))).json()).toEqual({ status: 'pending' });
    expect((await f.host.handle(f.b.post('/login/email', emailBody))).status).toBe(409);
    expect(f.calls).toHaveLength(1);
  }
});

test('cancellation or expiry during exchange prevents the host from obtaining credentials', async () => {
  for (const expire of [false, true]) {
    const clock = spyOn(Date, 'now').mockReturnValue(2_000_000_000_000);
    try {
      const f = await fixture();
      await f.host.handle(f.b.post('/login/email', emailBody));
      f.state.onToken = async () => {
        if (expire) clock.mockReturnValue(2_000_000_300_000);
        else
          expect((await f.host.handle(f.b.post('/login/cancel'))).headers.get('set-cookie')).toContain(
            'Max-Age=0',
          );
      };
      await f.host.handle(f.b.get(f.state.callback));
      expect(() => f.host.takeIdentity(f.b.post('/login/approve'))).toThrow();
      expect((await f.host.handle(f.b.get('/login/status'))).status).toBe(403);
      expect(f.calls.filter((c) => c.endsWith('grant_type=pkce'))).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
  }
});

test('bootstrap is bounded per process and retry becomes possible at the minute boundary', async () => {
  const clock = spyOn(Date, 'now').mockReturnValue(2_000_000_000_000);
  try {
    const f = await fixture();
    for (let i = 1; i < 20; i++) expect((await f.host.handle(bootstrap())).status).toBe(201);
    clock.mockReturnValue(2_000_000_059_999);
    expect((await f.host.handle(bootstrap())).status).toBe(429);
    expect((await f.host.handle(f.b.get('/login/status'))).status).toBe(200);
    clock.mockReturnValue(2_000_000_060_000);
    expect((await f.host.handle(bootstrap())).status).toBe(201);
  } finally {
    clock.mockRestore();
  }
});

test('concurrent callbacks cannot exchange twice or prevent the admitted callback completing', async () => {
  const f = await fixture();
  await f.host.handle(f.b.post('/login/email', emailBody));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.state.onToken = async () => {
    entered.resolve();
    await release.promise;
  };
  const first = f.host.handle(f.b.get(f.state.callback));
  await entered.promise;
  try {
    expect((await f.host.handle(f.b.get(f.state.callback))).status).toBe(400);
  } finally {
    release.resolve();
  }
  expect((await first).status).toBe(303);
  expect(f.host.takeIdentity(f.b.post('/login/approve')).userId).toBe(f.user);
  expect(f.calls.filter((c) => c.endsWith('grant_type=pkce'))).toHaveLength(1);
});

test('streaming body limit uses actual bytes rather than a forged Content-Length', async () => {
  const f = await fixture();
  let cancelled = false;
  const req = new Request(`${origin}/login/email`, {
    method: 'POST',
    headers: {
      cookie: f.b.cookie,
      origin,
      'x-csrf-token': f.b.csrfToken,
      'content-type': 'application/json',
      'content-length': '1',
    },
    body: new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(600));
      },
      cancel() {
        cancelled = true;
      },
    }),
  });
  expect((await f.host.handle(req)).status).toBe(403);
  expect(cancelled).toBe(true);
  expect(f.calls).toHaveLength(0);
});
