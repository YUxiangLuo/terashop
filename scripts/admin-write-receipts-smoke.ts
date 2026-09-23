// Local-only regression for committed writes whose response receipt is malformed.
import { localSupabase } from './lib/local-supabase';
const config = localSupabase();
const origin = new URL(process.env.ADMIN_URL ?? 'http://127.0.0.1:5174');
if (!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) throw Error('Local admin URL required');

const product = crypto.randomUUID(),
  shipping = crypto.randomUUID(),
  tax = crypto.randomUUID();
const session = `write-receipts-${product}`;
const email = `${session}@example.test`,
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
  if (!response.ok) throw Error(`Fixture API ${path} failed (${response.status})`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
async function browser(...args: string[]) {
  const process = Bun.spawn(['agent-browser', '--session', session, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (code) throw Error(`Browser ${args[0]} failed: ${err || out}`);
}
const click = (name: string) => browser('find', 'role', 'button', 'click', '--name', name, '--exact');
const fill = (label: string, value: string) => browser('find', 'label', label, 'fill', value, '--exact');
const wait = (text: string) => browser('wait', '--text', text);
const ready = (form: string) =>
  browser(
    'wait',
    '--fn',
    `!!document.querySelector(${JSON.stringify(`${form} fieldset`)})&&!document.querySelector(${JSON.stringify(`${form} fieldset`)}).disabled`,
  );
const intercept = (rpc: string, replacement: 'null' | 'wrong-id' | 'missing') =>
  browser(
    'eval',
    `(() => {
  const original=window.fetch; window.receiptDispatches=0;
  window.fetch=async (...args)=>{const response=await original(...args);if(!String(args[0]).endsWith('/rpc/${rpc}'))return response;
    window.receiptDispatches++;if(!response.ok)return response;const value=await response.json();
    const changed=${JSON.stringify(replacement)}==='null'?null:${JSON.stringify(replacement)}==='wrong-id'?{...value,id:crypto.randomUUID()}:(()=>{const copy={...value};delete copy.name;return copy})();
    return new Response(JSON.stringify(changed),{status:response.status,headers:{'Content-Type':'application/json'}});
  };
})()`,
  );
const lockedWithDraft = (form: string, selector: string, value: string) =>
  browser(
    'eval',
    `(() => {
  if(!document.querySelector(${JSON.stringify(`${form} fieldset`)}).disabled)throw Error('Malformed receipt did not lock editor');
  if(document.querySelector(${JSON.stringify(selector)}).value!==${JSON.stringify(value)})throw Error('Malformed receipt discarded draft');
  if(window.receiptDispatches!==1)throw Error('Unexpected write dispatch count');
})()`,
  );

try {
  user = (
    await api('/auth/v1/admin/users', 'POST', {
      email,
      password,
      email_confirm: true,
    })
  ).id;
  await api(`/rest/v1/profiles?id=eq.${user}`, 'PATCH', { role: 'admin' });
  await browser('open', `${origin.origin}/products/${product}?new=1`);
  await browser('wait', 'input[type=email]');
  await browser('fill', 'input[type=email]', email);
  await browser('fill', 'input[type=password]', password);
  await click('Sign in');

  await ready('#product-form');
  await fill('Name', 'Receipt product draft');
  await browser('fill', 'input[placeholder="linen-wrap-dress"]', `receipt-${product}`);
  await intercept('create_product', 'null');
  await click('Save product');
  await wait('Reload the saved version before another save');
  await lockedWithDraft(
    '#product-form',
    'input[placeholder="e.g. Linen wrap dress"]',
    'Receipt product draft',
  );
  await browser('eval', "document.querySelector('#product-form').requestSubmit()");
  await lockedWithDraft(
    '#product-form',
    'input[placeholder="e.g. Linen wrap dress"]',
    'Receipt product draft',
  );
  await click('Reload saved version');
  await browser('dialog', 'accept');
  await ready('#product-form');

  await fill('Name', 'Updated receipt draft');
  await intercept('update_product', 'wrong-id');
  await click('Save product');
  await wait('Reload the saved version before another save');
  await lockedWithDraft(
    '#product-form',
    'input[placeholder="e.g. Linen wrap dress"]',
    'Updated receipt draft',
  );
  await browser('eval', "document.querySelector('#product-form').requestSubmit()");
  await lockedWithDraft(
    '#product-form',
    'input[placeholder="e.g. Linen wrap dress"]',
    'Updated receipt draft',
  );
  await click('Reload saved version');
  await browser('dialog', 'accept');
  await ready('#product-form');

  await browser('open', `${origin.origin}/shipping/${shipping}?new=1`);
  await ready('#shipping-form');
  await fill('Name', 'Receipt shipping draft');
  await fill('Shipping price (USD)', '4.25');
  await intercept('create_shipping_method', 'wrong-id');
  await click('Save shipping method');
  await wait('Reload the shipping method before another save');
  await lockedWithDraft('#shipping-form', '#shipping-form input', 'Receipt shipping draft');
  await browser('eval', "document.querySelector('#shipping-form').requestSubmit()");
  await lockedWithDraft('#shipping-form', '#shipping-form input', 'Receipt shipping draft');
  await click('Reload shipping method');
  await browser('dialog', 'accept');
  await ready('#shipping-form');

  await browser('open', `${origin.origin}/taxes/${tax}?new=1`);
  await ready('#tax-form');
  await fill('Name', 'Receipt tax draft');
  await fill('Country code', 'ZZ');
  await fill('Tax rate (%)', '6.25');
  await intercept('create_tax_rate', 'missing');
  await click('Save tax rate');
  await wait('Reload the tax rate before another save');
  await lockedWithDraft('#tax-form', '#tax-form input', 'Receipt tax draft');
  await browser('eval', "document.querySelector('#tax-form').requestSubmit()");
  await lockedWithDraft('#tax-form', '#tax-form input', 'Receipt tax draft');
  await click('Reload tax rate');
  await browser('dialog', 'accept');
  await ready('#tax-form');

  for (const [rpc, id] of [
    ['get_admin_product', product],
    ['get_admin_shipping_method', shipping],
    ['get_admin_tax_rate', tax],
  ])
    if (
      !(await api(`/rest/v1/rpc/${rpc}`, 'POST', {
        [rpc === 'get_admin_product'
          ? 'product_id'
          : rpc === 'get_admin_shipping_method'
            ? 'shipping_method_id'
            : 'tax_rate_id']: id,
      }))
    )
      throw Error(`${rpc} fixture was not committed`);
  console.log(
    'Write receipt smoke passed: null, wrong-identity and missing-field committed responses preserve drafts, lock redispatch, and only a valid reload unlocks.',
  );
} catch (cause) {
  try {
    await browser('screenshot', '/tmp/admin-write-receipts-failure.png', '--full');
  } catch {}
  throw cause;
} finally {
  const failures: unknown[] = [];
  for (const cleanup of [
    () => browser('close'),
    () => api(`/rest/v1/products?id=eq.${product}`, 'DELETE'),
    () => api(`/rest/v1/shipping_methods?id=eq.${shipping}`, 'DELETE'),
    () => api(`/rest/v1/tax_rates?id=eq.${tax}`, 'DELETE'),
    async () => {
      if (user) await api(`/auth/v1/admin/users/${user}`, 'DELETE');
    },
  ])
    try {
      await cleanup();
    } catch (cause) {
      failures.push(cause);
    }
  if (failures.length) throw new AggregateError(failures, 'Write receipt smoke cleanup failed');
}
