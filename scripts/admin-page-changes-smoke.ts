// Local-only notification coverage, without automatic navigation or draft replacement.
import { SQL } from 'bun';
import { localSupabase } from './lib/local-supabase';
const config = localSupabase();
const origin = new URL(process.env.ADMIN_URL ?? 'http://127.0.0.1:5174');
if (!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) throw Error('Local Admin required');
const db = new SQL(config.DB_URL, { max: 1 });
const id = crypto.randomUUID(),
  session = `page-live-${id}`;
const password = crypto.randomUUID() + 'Aa1!';
let user = '';
async function api(path: string, method: string, body?: unknown) {
  const result = await fetch(`${config.API_URL}${path}`, {
    method,
    headers: {
      apikey: config.SERVICE_ROLE_KEY,
      Authorization: `Bearer ${config.SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!result.ok) throw Error(`Fixture ${path}: ${result.status}`);
  const text = await result.text();
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
const wait = (text: string) => browser('wait', '--text', text);
try {
  user = (
    await api('/auth/v1/admin/users', 'POST', {
      email: `${session}@example.test`,
      password,
      email_confirm: true,
    })
  ).id;
  await api(`/rest/v1/profiles?id=eq.${user}`, 'PATCH', { role: 'admin' });
  await api('/rest/v1/products', 'POST', {
    id,
    slug: session,
    name: 'Live notification fixture',
    status: 'draft',
  });
  await browser('open', `${origin.origin}/products/${id}`);
  await browser('wait', 'input[type=email]');
  await browser('fill', 'input[type=email]', `${session}@example.test`);
  await browser('fill', 'input[type=password]', password);
  await click('Sign in');
  await wait('Live page notifications connected.');
  await browser('wait', '#product-form input');
  await browser('fill', '#product-form input', 'Unsaved product draft');
  await wait('Data used by this page may have changed.');
  await click('Dismiss change reminder');
  await browser('eval', `window.originalEditor=document.querySelector('#product-form')`);
  await api(`/rest/v1/products?id=eq.${id}`, 'PATCH', { name: 'Remote product change' });
  await wait('Data used by this page may have changed.');
  await browser(
    'eval',
    `if(document.querySelector('#product-form')!==window.originalEditor || document.querySelector('#product-form input').value!=='Unsaved product draft')throw Error('Notification replaced editor')`,
  );
  await browser('screenshot', '/tmp/admin-page-live-draft.png');
  // Explicitly leave this disposable draft; no save is issued.
  const cases = [
    ['/orders', 'public.orders'],
    ['/quotes', 'commerce.checkout_quotes'],
    ['/customers', 'public.customers'],
    ['/locations', 'public.locations'],
    ['/shipping', 'public.shipping_methods'],
    ['/taxes', 'public.tax_rates'],
    ['/promotions', 'public.promotions'],
    ['/outbox', 'commerce.outbox_events'],
    ['/payment-events', 'commerce.payment_provider_events'],
    ['/reconciliation', 'commerce.provider_money_movements'],
  ];
  await browser('open', `${origin.origin}/orders`);
  await wait('Live page notifications connected.');
  await browser('eval', 'window.spaNavigationMarker=true');
  for (const [path, table] of cases) {
    await browser('click', `nav a[href="${path}"]`);
    await browser('wait', '--url', `**${path}`);
    await wait('Live page notifications connected.');
    await wait('Data used by this page may have changed.');
    await click('Dismiss change reminder');
    await browser(
      'eval',
      `if(!window.spaNavigationMarker)throw Error('Expected SPA navigation'); window.oldHeading=document.querySelector('#main h1'); window.oldUrl=location.href`,
    );
    // Statement invalidation without changing unrelated fixture rows.
    await db.unsafe(`update ${table} set id=default where false`);
    await wait('Data used by this page may have changed.');
    await browser(
      'eval',
      `if(document.querySelector('#main h1')!==window.oldHeading || location.href!==window.oldUrl)throw Error('Notification navigated or remounted page')`,
    );
  }
  await browser('set', 'viewport', '390', '844');
  await browser(
    'eval',
    `if(document.documentElement.scrollWidth>innerWidth)throw Error('Notification overflow')`,
  );
  await browser('screenshot', '/tmp/admin-page-live-mobile.png');
  console.log(
    'PASS: product draft survives remote edit; remaining list domains notify without remount/navigation',
  );
} finally {
  const failures: unknown[] = [];
  for (const cleanup of [
    () => browser('close'),
    () => api(`/rest/v1/products?id=eq.${id}`, 'DELETE'),
    async () => {
      if (user) await api(`/auth/v1/admin/users/${user}`, 'DELETE');
    },
    () => db.close(),
  ]) {
    try {
      await cleanup();
    } catch (cause) {
      failures.push(cause);
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Fixture cleanup failed');
}
