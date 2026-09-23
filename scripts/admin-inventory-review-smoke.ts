// Local-only focused regression for inventory drafts, pending recovery, and atomic history loads.
import { localSupabase } from './lib/local-supabase';

const config = localSupabase();
const origin = new URL(process.env.ADMIN_URL ?? 'http://127.0.0.1:5174');
if (!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) throw Error('Local Admin required');
const product = crypto.randomUUID(),
  variant = crypto.randomUUID(),
  location = crypto.randomUUID();
const session = `inventory-review-${product}`,
  email = `${session}@example.test`;
const password = crypto.randomUUID() + 'Aa1!';
let user = '';
async function api(path: string, method: string, body?: unknown, token = config.SERVICE_ROLE_KEY) {
  const response = await fetch(`${config.API_URL}${path}`, {
    method,
    headers: {
      apikey: config.SERVICE_ROLE_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw Error(`Fixture ${path}: ${response.status} ${await response.text()}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
async function browser(...args: string[]) {
  const child = Bun.spawn(['agent-browser', '--session', session, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code) throw Error(`Browser ${args[0]}: ${err || out}`);
}
const click = (name: string) => browser('find', 'role', 'button', 'click', '--name', name, '--exact');
async function dialog(action: 'accept' | 'dismiss') {
  for (let attempt = 0; ; attempt++) {
    try {
      await browser('dialog', action);
      return;
    } catch (cause) {
      if (attempt >= 20 || !String(cause).includes('No dialog is showing')) throw cause;
      await Bun.sleep(100);
    }
  }
}
const check = (source: string) => browser('eval', `if(!(${source}))throw Error(${JSON.stringify(source)})`);
const movements = '[aria-label="Inventory movements"]';
try {
  user = (await api('/auth/v1/admin/users', 'POST', { email, password, email_confirm: true })).id;
  await api(`/rest/v1/profiles?id=eq.${user}`, 'PATCH', { role: 'admin' });
  const auth = await api('/auth/v1/token?grant_type=password', 'POST', { email, password });
  await api('/rest/v1/products', 'POST', {
    id: product,
    slug: session,
    name: 'Inventory review fixture',
    status: 'draft',
  });
  await api('/rest/v1/product_variants', 'POST', {
    id: variant,
    product_id: product,
    sku: session,
    price: 10,
    track_inventory: true,
  });
  await api('/rest/v1/rpc/create_location', 'POST', {
    location_id: location,
    changes: { code: session, name: 'Inventory review warehouse', is_active: true },
  });
  for (let index = 0; index < 21; index++) {
    await api(
      '/rest/v1/rpc/adjust_inventory',
      'POST',
      {
        variant_id: variant,
        location_id: location,
        delta: 1,
        note: `history-${index}`,
        idempotency_key: crypto.randomUUID(),
      },
      auth.access_token,
    );
  }
  await browser('open', `${origin.origin}/inventory?product=${product}`);
  await browser('wait', 'input[type=email]');
  await browser('fill', 'input[type=email]', email);
  await browser('fill', 'input[type=password]', password);
  await click('Sign in');
  await browser('wait', '[aria-label="Inventory"] select');
  await browser(
    'wait',
    '--fn',
    `!!document.querySelector('[aria-label="Inventory"] input[type=number]') && !document.querySelector('[aria-label="Inventory"] fieldset').disabled`,
  );
  await browser('select', '[aria-label="Inventory"] .fields.two label:last-child select', location);
  await check(
    `document.querySelectorAll('[aria-label="Inventory"] select')[1].value===${JSON.stringify(location)}`,
  );
  await browser('wait', `${movements} tbody tr`);
  await browser('fill', '[aria-label="Inventory"] input[type=number]', '4');
  await browser('fill', '[aria-label="Inventory"] input[placeholder*="Stock count"]', 'navigation draft');
  await browser('click', 'aside .module a[href="/orders"]');
  await dialog('dismiss');
  await check(
    `location.pathname==='/inventory' && document.querySelector('[aria-label="Inventory"] input[type=number]').value==='4'`,
  );
  await browser('click', 'aside .module a[href="/orders"]');
  await dialog('accept');
  await browser('wait', '--url', '**/orders');
  await browser('open', `${origin.origin}/inventory?product=${product}`);
  await browser('wait', '[aria-label="Inventory"] select');
  await browser(
    'wait',
    '--fn',
    `!!document.querySelector('[aria-label="Inventory"] input[type=number]') && !document.querySelector('[aria-label="Inventory"] fieldset').disabled`,
  );
  await browser('select', '[aria-label="Inventory"] .fields.two label:last-child select', location);
  await check(
    `document.querySelectorAll('[aria-label="Inventory"] select')[1].value===${JSON.stringify(location)}`,
  );
  await browser('wait', `${movements} tbody tr`);

  await browser(
    'eval',
    `window.historySnapshot=[...document.querySelectorAll('${movements} tbody tr')].map(x=>x.textContent).join('|')`,
  );
  await browser('network', 'route', '**/rest/v1/rpc/list_admin_inventory_movements', '--abort');
  await click('Load older movements');
  await browser('wait', '--text', 'Showing the previous movement history.');
  await browser('eval', `document.querySelector('${movements}').scrollIntoView()`);
  await browser('screenshot', '/tmp/admin-inventory-history-stale.png');
  await check(
    `document.querySelector('${movements} button.form-action') && [...document.querySelectorAll('${movements} tbody tr')].map(x=>x.textContent).join('|')===window.historySnapshot`,
  );
  await browser('select', `${movements} select`, 'restock');
  await click('Filter history');
  await check(
    `[...document.querySelectorAll('${movements} tbody tr')].map(x=>x.textContent).join('|')===window.historySnapshot`,
  );
  await browser('network', 'unroute', '**/rest/v1/rpc/list_admin_inventory_movements');
  await click('Filter history');
  await browser('wait', '--text', 'No movements match this selection.');
  await browser('select', `${movements} select`, '');
  await click('Filter history');
  await browser('wait', `${movements} tbody tr`);

  await browser('fill', '[aria-label="Inventory"] input[type=number]', '2');
  await browser('fill', '[aria-label="Inventory"] input[placeholder*="Stock count"]', 'pending recovery');
  await browser('network', 'route', '**/rest/v1/rpc/adjust_inventory', '--abort');
  await click('Confirm stock adjustment');
  await dialog('accept');
  await browser('wait', '--text', 'The operation may have succeeded.');
  await browser('network', 'unroute', '**/rest/v1/rpc/adjust_inventory');
  await browser('reload');
  await browser('wait', '--text', 'Unresolved stock operation: +2 units');
  await check(
    `[...document.querySelectorAll('[aria-label="Inventory"] button')].some(b=>b.textContent.includes('Retry saved adjustment'))`,
  );
  await click('Retry saved adjustment');
  await dialog('accept');
  await browser('wait', '--text', 'Stock adjustment confirmed.');
  await browser('open', `${origin.origin}/products/${product}`);
  await browser(
    'wait',
    '--fn',
    `!!document.querySelector('[aria-label="Inventory"] input[type=number]') && !document.querySelector('[aria-label="Inventory"] fieldset').disabled`,
  );
  await browser('fill', '[aria-label="Inventory"] input[type=number]', '7');
  await browser('fill', '[aria-label="Inventory"] input[placeholder*="Stock count"]', 'Retain stock draft');
  await browser('wait', '--text', 'Finish or clear the stock adjustment below');
  await check(
    `document.querySelector('#product-form fieldset').disabled && [...document.querySelectorAll('button')].find(b=>b.textContent.includes('Reload saved version')).disabled`,
  );
  await browser('screenshot', '/tmp/admin-inventory-draft-guard.png');
  await browser('eval', 'window.scrollTo(0, 0)');
  await browser('screenshot', '/tmp/admin-product-stock-guard.png');
  // Native navigation dialogs are exercised above; control this confirmation response
  // because synchronous selectOption cannot return its CDP reply while a dialog is open.
  await browser(
    'eval',
    `window.originalConfirm=window.confirm; window.targetConfirms=0; window.confirm=()=>{window.targetConfirms++; return false}`,
  );
  await browser('select', '[aria-label="Inventory"] .fields.two label:last-child select', location);
  await check(
    `window.targetConfirms===1 && document.querySelectorAll('[aria-label="Inventory"] select')[1].value!==${JSON.stringify(location)} && document.querySelector('[aria-label="Inventory"] input[type=number]').value==='7'`,
  );
  await browser('eval', `window.confirm=()=>{window.targetConfirms++; return true}`);
  await browser('select', '[aria-label="Inventory"] .fields.two label:last-child select', location);
  await browser(
    'wait',
    '--fn',
    `!document.querySelector('#product-form fieldset').disabled && !!document.querySelector('[aria-label="Inventory"] input[type=number]')`,
  );
  await check(
    `window.targetConfirms===2 && document.querySelectorAll('[aria-label="Inventory"] select')[1].value===${JSON.stringify(location)} && document.querySelector('[aria-label="Inventory"] input[type=number]').value==='' && document.querySelector('[aria-label="Inventory"] input[placeholder*="Stock count"]').value===''`,
  );
  await browser('eval', 'window.confirm=window.originalConfirm');
  console.log('PASS: inventory draft navigation, pending recovery, and atomic history refresh/pagination');
} catch (cause) {
  console.error(cause);
  try {
    await browser('dialog', 'dismiss');
  } catch {}
  try {
    await browser('screenshot', '/tmp/admin-inventory-review-failure.png', '--full');
  } catch {}
  throw cause;
} finally {
  const failures: unknown[] = [];
  for (const cleanup of [
    () => browser('close'),
    () => api(`/rest/v1/products?id=eq.${product}`, 'PATCH', { status: 'archived' }),
    () => api(`/rest/v1/locations?id=eq.${location}`, 'PATCH', { is_active: false }),
    async () => {
      if (user) await api(`/rest/v1/profiles?id=eq.${user}`, 'PATCH', { role: 'customer' });
    },
  ])
    try {
      await cleanup();
    } catch (cause) {
      failures.push(cause);
    }
  if (failures.length) throw new AggregateError(failures, 'Fixture cleanup failed');
}
