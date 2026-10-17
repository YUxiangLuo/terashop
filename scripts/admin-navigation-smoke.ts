// Local-only real login, responsive navigation, deep links and draft protection.
import { localSupabase } from './lib/local-supabase';
const config = localSupabase();
const origin = new URL(process.env.ADMIN_URL ?? 'http://127.0.0.1:5174');
if (!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) throw Error('Local Admin required');
const id = crypto.randomUUID(),
  session = `navigation-${id}`,
  password = crypto.randomUUID() + 'Aa1!';
let user = '';
async function api(path: string, method: string, body?: unknown) {
  const response = await fetch(`${config.API_URL}${path}`, {
    method,
    headers: {
      apikey: config.SERVICE_ROLE_KEY,
      Authorization: `Bearer ${config.SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw Error(`Fixture ${path}: ${response.status}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
async function browser(...args: string[]) {
  const p = Bun.spawn(['agent-browser', '--session', session, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code) throw Error(`Browser ${args[0]}: ${err || out}`);
}
const click = (name: string) => browser('find', 'role', 'button', 'click', '--name', name, '--exact');
const check = (condition: string) =>
  browser('eval', `if(!(${condition}))throw Error(${JSON.stringify(condition)})`);
try {
  user = (
    await api('/auth/v1/admin/users', 'POST', {
      email: `${session}@example.test`,
      password,
      email_confirm: true,
    })
  ).id;
  await api(`/rest/v1/profiles?id=eq.${user}`, 'PATCH', { role: 'admin' });
  await api('/rest/v1/products', 'POST', { id, slug: session, name: 'Navigation fixture', status: 'draft' });
  await browser('set', 'viewport', '1440', '1000');
  await browser('open', `${origin.origin}/products/${id}`);
  await browser('wait', 'input[type=email]');
  await browser('fill', 'input[type=email]', `${session}@example.test`);
  await browser('fill', 'input[type=password]', password);
  await click('Sign in');
  await browser('wait', '#product-form input');
  await check(`document.querySelectorAll('aside .module').length===7`);
  await check(`document.querySelector('aside a[aria-current=page]').getAttribute('href')==='/'`);
  await check(
    `document.querySelector('aside [aria-label="Personal navigation"] a').getAttribute('href')==='/connections'`,
  );
  const routes = [
    ['/quotes', 'Orders'],
    ['/categories', 'Products'],
    ['/reviews', 'Products'],
    ['/metadata', 'Products'],
    ['/locations', 'Inventory'],
    ['/inventory/transfers', 'Inventory'],
    ['/customers', 'Customers'],
    ['/promotions', 'Promotions'],
    ['/reconciliation', 'Operations'],
    ['/payment-events', 'Operations'],
    ['/outbox', 'Operations'],
    ['/reports', 'Operations'],
    ['/shipping', 'Settings'],
    ['/settings', 'Settings'],
    ['/taxes', 'Settings'],
    ['/orders', 'Orders'],
    ['/inventory', 'Inventory'],
    ['/', 'Products'],
  ];
  for (const [path, group] of routes) {
    await browser('open', `${origin.origin}${path}`);
    await browser('wait', 'aside .module.active');
    await check(
      `document.querySelector('aside .module.active > a').textContent.trim()===${JSON.stringify(group)}`,
    );
    await check(
      `document.querySelectorAll('aside a[aria-current=page]').length===1 && document.querySelector('aside a[aria-current=page]').getAttribute('href')===${JSON.stringify(path)}`,
    );
  }
  await click('Expand Operations');
  await browser('click', 'aside .subnav a[href="/outbox"]');
  await browser('wait', '--url', '**/outbox');
  await browser('wait', '--text', 'Outbox events');
  await browser('screenshot', '/tmp/admin-menu-desktop.png');
  await browser('back');
  await browser('wait', '--url', `${origin.origin}/`);
  await browser('wait', 'aside a[aria-current=page][href="/"]');
  await browser('set', 'viewport', '390', '844');
  await check(
    `getComputedStyle(document.querySelector('aside')).display==='none' && !document.querySelector('dialog').open`,
  );
  await check(
    `document.querySelector('.mobile-navigation').getBoundingClientRect().height<90 && document.documentElement.scrollWidth<=innerWidth`,
  );
  await browser('screenshot', '/tmp/admin-menu-mobile-closed.png');
  await click('Menu');
  await browser('wait', 'dialog[open]');
  await check(`document.querySelector('dialog').contains(document.activeElement)`);
  // Native Tab traversal can expose body as activeElement at the browser-chrome
  // boundary. Test every step: no background control may receive focus.
  for (let i = 0; i < 25; i++) {
    await browser('press', 'Tab');
    await check(`document.querySelector('dialog').matches(':modal') && (document.querySelector('dialog').contains(document.activeElement) || document.activeElement === document.body)`);
  }
  await browser('eval', `document.querySelector('.topbar button').focus()`);
  await check(`document.activeElement !== document.querySelector('.topbar button')`);
  await browser('focus', 'dialog [aria-label="Close navigation"]');
  await browser('press', 'Escape');
  await check(`!document.querySelector('dialog').open && document.activeElement.textContent.trim()==='Menu'`);
  await click('Menu');
  await browser('mouse', 'move', '380', '400');
  await browser('mouse', 'down');
  await browser('mouse', 'up');
  await check(`!document.querySelector('dialog').open && document.activeElement.textContent.trim()==='Menu'`);
  await click('Menu');
  await browser('click', 'dialog [aria-label="Expand Settings"]');
  await browser('screenshot', '/tmp/admin-menu-mobile-open.png');
  await browser('click', 'dialog a[href="/taxes"]');
  await browser('wait', '--url', '**/taxes');
  await check(`!document.querySelector('dialog').open`);
  await click('Menu');
  await browser('set', 'viewport', '1440', '1000');
  await check(
    `!document.querySelector('dialog').open && getComputedStyle(document.body).overflow!=='hidden'`,
  );
  await browser('open', `${origin.origin}/products/${id}`);
  await browser('wait', '#product-form input');
  await browser('fill', '#product-form input', 'Keep this navigation draft');
  await browser('set', 'viewport', '390', '844');
  await click('Menu');
  await browser('click', 'dialog .module a[href="/orders"]');
  await browser('dialog', 'dismiss');
  await check(`location.pathname==='/products/${id}' && document.querySelector('dialog').open`);
  await click('Close navigation');
  await check(`document.querySelector('#product-form input').value==='Keep this navigation draft'`);
  // Explicitly leave this disposable draft, then verify the demoted account boundary.
  await browser('open', `${origin.origin}/connections`);
  await browser('wait', '--text', 'My Agent connections');
  await api(`/rest/v1/profiles?id=eq.${user}`, 'PATCH', { role: 'customer' });
  await browser('reload');
  await browser('wait', '.mobile-navigation');
  await click('Menu');
  await check(
    `document.querySelector('dialog [aria-label="Main navigation"]')===null && document.querySelector('dialog a[href="/connections"]')!==null`,
  );
  await click('Close navigation');
  await click('Sign out');
  await browser('wait', 'input[type=email]');
  await check(`document.querySelector('dialog')===null`);
  console.log(
    'PASS: seven modules, all route families, history, personal isolation, responsive drawer, focus/Escape, resize, draft cancellation, demotion and logout',
  );
} finally {
  await browser('close').catch(() => {});
  await api(`/rest/v1/products?id=eq.${id}`, 'DELETE');
  if (user) await api(`/auth/v1/admin/users/${user}`, 'DELETE');
}
