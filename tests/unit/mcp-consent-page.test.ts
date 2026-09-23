import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { consentPage } from '../../mcp/src/consent-page';

const consent = {
  clientId: 'agent',
  redirectUri: 'https://client.example/callback',
  resource: 'https://shop.example/mcp',
  scopes: ['store:read'],
  offlineAccess: true,
};

test('consent escapes provider metadata and permits only its exact static script/style', async () => {
  const response = consentPage({ ...consent, clientId: '</dd><script>alert("x")</script>' });
  const html = await response.text();
  expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  expect(html.match(/<script>/g)).toHaveLength(1);
  const policy = response.headers.get('content-security-policy')!;
  for (const tag of ['script', 'style']) {
    const content = html.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))![1];
    expect(policy).toContain(`${tag}-src 'sha256-${createHash('sha256').update(content).digest('base64')}'`);
  }
  expect(policy).toContain("frame-ancestors 'none'");
  expect(policy).not.toContain('unsafe-inline');
  expect(response.headers.get('cache-control')).toBe('no-store');
});

// Execute the exact served script against a small DOM/network model. Real rendering
// is checked separately in a browser; these assertions isolate retry/consent decisions.
async function browser(saved = false) {
  const html = await consentPage(consent).text();
  const listeners: Record<string, () => void> = {};
  const elements = Object.fromEntries(
    ['status', 'login', 'approve', 'deny', 'email'].map((id) => [
      id,
      {
        hidden: id === 'approve',
        disabled: false,
        textContent: '',
        value: 'admin@example.com',
        addEventListener(event: string, listener: (event: { preventDefault(): void }) => void) {
          listeners[`${id}:${event}`] = () => listener({ preventDefault() {} });
        },
      },
    ]),
  );
  const storage = new Map(saved ? [['tera-consent:/interaction/test', 'csrf-proof']] : []);
  const calls: { url: string; init: RequestInit }[] = [];
  const navigations: string[] = [];
  const timers: (() => Promise<void>)[] = [];
  let status = 'pending',
    rejected = false;
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], {
    document: {
      getElementById: (id: string) => elements[id],
      querySelectorAll: () => [elements.email, elements.approve, elements.deny],
    },
    sessionStorage: {
      getItem: (key: string) => storage.get(key),
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    location: {
      pathname: '/interaction/test',
      origin: 'https://auth.example',
      assign: (url: string) => navigations.push(url),
    },
    URL,
    setTimeout: (fn: () => Promise<void>) => {
      timers.push(fn);
      return fn;
    },
    clearTimeout: (fn: () => Promise<void>) => {
      const i = timers.indexOf(fn);
      if (i >= 0) timers.splice(i, 1);
    },
    fetch: async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (rejected) return Response.json({}, { status: 403 });
      return Response.json(
        url.endsWith('/start')
          ? { csrfToken: 'csrf-proof' }
          : url === '/login/status'
            ? { status }
            : { redirectTo: '/auth/resume' },
      );
    },
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  await settle();
  return {
    elements,
    storage,
    calls,
    navigations,
    settle,
    click: (id: string) => listeners[`${id}:click`](),
    submit: () => listeners['login:submit'](),
    poll: async () => {
      await timers.shift()!();
    },
    authenticate: () => {
      status = 'authenticated';
    },
    reject: () => {
      rejected = true;
    },
  };
}

test('email proof never auto-approves; explicit approval is single-flight and uses JSON CSRF protocol', async () => {
  const b = await browser();
  expect(b.calls).toHaveLength(0);
  b.submit();
  b.submit();
  await b.settle();
  expect(b.calls.map((c) => c.url)).toEqual(['/interaction/test/start', '/login/email']);
  b.authenticate();
  await b.poll();
  expect(b.elements.approve.hidden).toBe(false);
  expect(b.navigations).toHaveLength(0);
  b.click('approve');
  b.click('approve');
  await b.settle();
  const approvals = b.calls.filter((c) => c.url.endsWith('/approve'));
  expect(approvals).toHaveLength(1);
  expect(approvals[0].init.headers).toEqual({
    Accept: 'application/json',
    'X-CSRF-Token': 'csrf-proof',
    'X-Tera-Consent': 'approve',
  });
  expect(approvals[0].init.redirect).toBe('error');
  expect(b.navigations).toEqual(['https://auth.example/auth/resume']);
  expect(b.storage.size).toBe(0);
});

test('reload polls without resetting the login; failed approval stops without retrying', async () => {
  const b = await browser(true);
  expect(b.calls.map((c) => c.url)).toEqual(['/login/status']);
  b.authenticate();
  await b.poll();
  b.reject();
  b.click('approve');
  await b.settle();
  b.click('approve');
  await b.settle();
  expect(b.calls.filter((c) => c.url.endsWith('/approve'))).toHaveLength(1);
  expect(b.elements.approve.disabled).toBe(true);
  expect(b.elements.status.textContent).toContain('结果无法确认');
  expect(b.navigations).toHaveLength(0);
  expect(b.storage.size).toBe(0);
});

test('reject works before email login and never submits approval', async () => {
  const b = await browser();
  b.click('deny');
  await b.settle();
  expect(b.calls.map((c) => c.url)).toEqual(['/interaction/test/start', '/interaction/test/cancel']);
  expect(new Headers(b.calls[1].init.headers).get('x-tera-consent')).toBe('deny');
  expect(b.navigations).toEqual(['https://auth.example/auth/resume']);
});

test('expired status disables approval without submitting or bootstrapping again', async () => {
  const b = await browser(true);
  b.authenticate();
  await b.poll();
  expect(b.elements.approve.hidden).toBe(false);
  b.reject();
  await b.poll();
  b.click('approve');
  await b.settle();
  expect(b.elements.approve.disabled).toBe(true);
  expect(b.calls.every((call) => call.url === '/login/status')).toBe(true);
  expect(b.navigations).toHaveLength(0);
});
