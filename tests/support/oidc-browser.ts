import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { authMail, authMessages } from './mail';
import type { nodeOidcService } from './oidc-node-service';
import { verifyAdminFusion } from './admin-fusion';

// Opt-in local browser acceptance. No mocked HTTP, injected cookies, TLS bypass,
// generated Auth links or automatic approval. Browser output may contain codes;
// never print command arguments, URLs or response bodies on failure.
export async function verifyOidcBrowser(input: {
  node: Awaited<ReturnType<typeof nodeOidcService>>;
  origin: string;
  resource: string;
  redirect: string;
  email: string;
  interruptedEmail: string;
  offlineEmail: string;
  lostResponseEmail: string;
  discardedReceiptEmail: string;
  adminOrigin?: string;
  interruptApproval: (submit: () => Promise<void>, disconnect: () => Promise<void>) => Promise<void>;
}) {
  const { node, origin, resource, redirect, email } = input;
  const session = `mcp-consent-${crypto.randomUUID()}`;
  let callback: URL | undefined;
  const receiver = Bun.serve({
    hostname: '127.0.0.1',
    port: Number(new URL(redirect).port),
    tls: node.tls,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== '/callback') return new Response(null, { status: 404 });
      callback = url;
      return new Response('MCP client received authorization response.', {
        headers: {
          'Content-Type': 'text/plain',
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
        },
      });
    },
  });
  async function browser(...args: string[]) {
    const child = Bun.spawn(['agent-browser', '--session', session, '--ca-cert', node.caPath, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    try {
      const [stdout, , code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      assert.equal(code, 0, `Browser ${args[0]} failed (details suppressed)`);
      return stdout.trim();
    } finally {
      clearTimeout(timer);
    }
  }
  const click = async (selector: string) => {
    await browser('scrollintoview', selector);
    await browser('click', selector);
  };
  const state = randomBytes(24).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const authorization = () =>
    `${origin}/auth?${new URLSearchParams({
      client_id: 'agent',
      redirect_uri: redirect,
      response_type: 'code',
      scope: input.adminOrigin
        ? 'openid offline_access store:read store:write'
        : 'openid offline_access store:read',
      resource,
      prompt: 'consent',
      state,
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    })}`;
  async function login(address: string) {
    await browser('open', authorization());
    await browser('wait', '--text', '验证管理员邮箱');
    assert.equal(await browser('is', 'visible', '#approve'), 'false');
    const previous = (await authMessages(address)).map((m) => m.ID);
    await browser('fill', '#email', address);
    await click('button[type=submit]');
    const mail = await authMail(address, 'magiclink', previous);
    await browser('wait', '--text', '同一浏览器');
    // A second tab uses the actual browser cookie jar, but not the first tab's
    // sessionStorage. Return to the original tab before consenting.
    await browser('tab', 'new', '--label', 'mail', mail.href);
    await browser('wait', '--text', '邮箱验证已完成');
    assert.equal(new URL(await browser('get', 'url')).pathname, '/login/status');
    assert.equal(callback, undefined, 'Email verification must not issue a code');
    await browser('tab', 't1');
    await browser('tab', 'close', 'mail');
    await browser('reload');
    await browser('wait', '--text', '邮箱验证已完成');
    assert.equal(await browser('is', 'visible', '#approve'), 'true');
    assert.equal(callback, undefined, 'Reload must not approve');
  }
  async function assertStopped() {
    await browser('wait', '--text', '此授权已失效或结果无法确认');
    assert.equal(await browser('is', 'enabled', '#approve'), 'false');
    assert.equal(await browser('is', 'enabled', '#deny'), 'false');
    assert.equal(
      await browser('eval', "sessionStorage.getItem('tera-consent:' + location.pathname) === null"),
      'true',
    );
    assert.equal(callback, undefined, 'Invalidated login must not issue a code');
  }
  let client: Client | undefined;
  try {
    await login(input.interruptedEmail);
    if (process.env.MCP_BROWSER_EXPIRY === '1') {
      // Exercise the real five-minute session/cookie deadline. Do not change
      // clocks, inject cookies, shorten configuration or fabricate HTTP failures.
      for (let minute = 1; minute <= 4; minute++) {
        await Bun.sleep(60_000);
        console.log(`Browser natural-expiry check: ${minute} minute(s) elapsed`);
      }
      assert.equal(await browser('is', 'enabled', '#approve'), 'true');
      assert.equal(await browser('eval', "fetch('/login/status').then(response => response.status)"), '200');
      assert.equal(callback, undefined);
      await Bun.sleep(65_000);
      await assertStopped();
      assert.equal(await browser('eval', "fetch('/login/status').then(response => response.status)"), '403');
      if (process.env.MCP_BROWSER_EXPIRY_SCREENSHOT)
        await browser('screenshot', '--full', process.env.MCP_BROWSER_EXPIRY_SCREENSHOT);
      // More than five minutes have elapsed, so the email OTP send cooldown
      // has also elapsed. A new real login must recover, without reusing proof.
      await login(input.interruptedEmail);
    }
    await node.restart();
    await assertStopped();
    // Wait through another polling interval: failure must remain terminal.
    await browser('wait', '2200');
    assert.equal(await browser('is', 'enabled', '#approve'), 'false');
    assert.equal(callback, undefined);
    if (process.env.MCP_BROWSER_FAILURE_SCREENSHOT)
      await browser('screenshot', '--full', process.env.MCP_BROWSER_FAILURE_SCREENSHOT);
    await browser('open', `${origin}/login/status`);
    await browser('wait', '--text', '无法继续授权');
    assert.equal(await browser('get', 'count', 'button'), '0');
    await login(input.offlineEmail);
    await browser('set', 'offline', 'on');
    try {
      // Drop browser networking only; the actual issuer/DB stay available.
      // A failed status request must end this page's ability to approve.
      await assertStopped();
    } finally {
      await browser('set', 'offline', 'off');
    }
    assert.equal(
      await browser(
        'eval',
        "fetch('/login/status').then(response => response.json()).then(body => body.status === 'authenticated')",
      ),
      'true',
    );
    await browser('wait', '2200');
    await assertStopped();
    // Native click on disabled controls is inert even with connectivity restored.
    await browser('eval', "document.querySelector('#approve').click()");
    assert.equal(callback, undefined, 'Restoring connectivity must not approve');
    if (process.env.MCP_BROWSER_OFFLINE_SCREENSHOT)
      await browser('screenshot', '--full', process.env.MCP_BROWSER_OFFLINE_SCREENSHOT);
    await login(input.lostResponseEmail);
    // Add only a cancellation signal to the actual approval Fetch. Chromium's
    // offline toggle need not abort a request already in flight.
    await browser(
      'eval',
      `(() => {
      const original = window.fetch.bind(window);
      window.approvalAbort = new AbortController();
      window.approvalRequests = 0;
      window.fetch = (url, init) => {
        if (typeof url === 'string' && url.endsWith('/approve')) {
          window.approvalRequests++;
          return original(url, {...init, signal: window.approvalAbort.signal});
        }
        return original(url, init);
      };
    })()`,
    );
    await input.interruptApproval(
      () => click('#approve'),
      async () => {
        await browser('eval', 'window.approvalAbort.abort()');
      },
    );
    await browser('wait', '2200');
    await assertStopped();
    assert.equal(await browser('eval', 'window.approvalRequests'), '1');
    if (process.env.MCP_BROWSER_LOST_RESPONSE_SCREENSHOT)
      await browser('screenshot', '--full', process.env.MCP_BROWSER_LOST_RESPONSE_SCREENSHOT);
    await login(input.discardedReceiptEmail);
    // Deliberately discard a REAL successful response before the page consumes
    // it. This models application receipt loss, not a physical network failure.
    await browser(
      'eval',
      `(() => {
      const original = window.fetch.bind(window);
      window.approvalRequests = 0;
      window.receiptDiscarded = false;
      window.fetch = async (url, init) => {
        if (typeof url !== 'string' || !url.endsWith('/approve')) return original(url, init);
        window.approvalRequests++;
        const response = await original(url, init);
        const body = await response.json();
        window.receiptDiscarded = response.status === 200 &&
          typeof body.redirectTo === 'string' &&
          new URL(body.redirectTo, location.origin).origin === location.origin;
        throw new TypeError('Controlled loss of completion receipt');
      };
    })()`,
    );
    await click('#approve');
    await assertStopped();
    assert.equal(await browser('eval', 'window.receiptDiscarded'), 'true');
    await browser('wait', '2200');
    await assertStopped();
    assert.equal(await browser('eval', 'window.approvalRequests'), '1');
    if (process.env.MCP_BROWSER_DISCARDED_RECEIPT_SCREENSHOT)
      await browser('screenshot', '--full', process.env.MCP_BROWSER_DISCARDED_RECEIPT_SCREENSHOT);
    // A new authorization and a fresh real email login must still work after
    // losing the page's approval proof; do not reuse the old transaction.
    await login(email);
    assert.equal(await browser('eval', "document.cookie.includes('__Host-tera-mcp-login=')"), 'false');
    assert.equal(
      await browser(
        'eval',
        `fetch(location.pathname + '/approve', {
      method: 'POST', headers: {'Accept':'application/json', 'X-Tera-Consent':'approve', 'X-CSRF-Token':'wrong'}
    }).then(response => response.status)`,
      ),
      '403',
    );
    assert.equal(callback, undefined, 'Invalid CSRF must not complete consent');
    // Only a non-sensitive verified consent screenshot is retained on request.
    if (process.env.MCP_BROWSER_SCREENSHOT)
      await browser('screenshot', '--full', process.env.MCP_BROWSER_SCREENSHOT);
    await click('#approve');
    await browser('wait', '--text', 'MCP client received authorization response.');
    const approved = callback as URL | undefined;
    assert(approved && approved.searchParams.get('state') === state);
    assert(!approved.searchParams.has('error'));
    const code = approved.searchParams.get('code');
    assert(code, 'Client must receive an authorization code');
    const exchange = await node.request('/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: 'agent',
        redirect_uri: redirect,
        code,
        code_verifier: verifier,
        resource,
      }),
    });
    assert.equal(exchange.status, 200);
    const token = await exchange.json();
    assert.equal(token.token_type, 'Bearer');
    client = new Client({ name: 'browser-acceptance', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(resource), {
        fetch: (url, init) =>
          fetch(url, {
            ...init,
            tls: { ca: node.tls.cert },
            signal: AbortSignal.timeout(10_000),
          }),
        requestInit: { headers: { Authorization: `Bearer ${token.access_token}` } },
      }),
    );
    const result = await client.callTool({ name: 'get_admin_shop_settings', arguments: {} });
    assert.notEqual(result.isError, true);
    const settings = result.structuredContent as { data?: { currency?: string } } | undefined;
    assert.equal(settings?.data?.currency, 'USD');
    if (input.adminOrigin)
      await verifyAdminFusion({
        client,
        browser,
        adminOrigin: input.adminOrigin,
        email,
        resource,
        accessToken: token.access_token,
        ca: node.tls.cert,
      });
    await client.close();
    client = undefined;
    callback = undefined;
    await browser('open', authorization());
    await browser('wait', '--text', '验证管理员邮箱');
    await click('#deny');
    await browser('wait', '--text', 'MCP client received authorization response.');
    const denied = callback as URL | undefined;
    assert(denied && denied.searchParams.get('state') === state);
    assert.equal(denied.searchParams.get('error'), 'access_denied');
    assert.equal(denied.searchParams.has('code'), false);
  } finally {
    try {
      await client?.close();
    } finally {
      try {
        await browser('close');
      } finally {
        await receiver.stop(true);
      }
    }
  }
}
