import { localSupabase } from './lib/local-supabase';
const config = localSupabase();
const origin = new URL(process.env.ADMIN_URL ?? 'http://127.0.0.1:5174');
if (!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) throw Error('Local admin URL required');
const session = `customers-${crypto.randomUUID()}`;
const email = `${session}@example.test`,
  password = crypto.randomUUID() + 'Aa1!';
let user = '',
  customer = '',
  retriedCustomer = '';
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
  return response.status === 204 ? null : response.json();
}
async function browser(...args: string[]) {
  const proc = Bun.spawn(['agent-browser', '--session', session, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code) throw Error(`Browser ${args[0]} failed: ${err || out}`);
  return out.trim();
}
const click = (name: string) => browser('find', 'role', 'button', 'click', '--name', name, '--exact');
try {
  user = (
    await api('/auth/v1/admin/users', 'POST', {
      email,
      password,
      email_confirm: true,
    })
  ).id;
  await api(`/rest/v1/profiles?id=eq.${user}`, 'PATCH', { role: 'admin' });
  await browser('open', `${origin.origin}/customers/new`);
  await browser('wait', 'input[type=email]');
  await browser('fill', 'input[type=email]', email);
  await browser('fill', 'input[type=password]', password);
  await click('Sign in');
  await browser('wait', '--text', 'New customer');
  await browser(
    'eval',
    `(() => {
    const e = new Event('beforeunload', {cancelable:true}); window.dispatchEvent(e);
    if(e.defaultPrevented) throw Error('Pristine form should allow leaving');
    const original = window.fetch.bind(window); let lost = false;
    window.fetch = async (...args) => {
      const response = await original(...args);
      if(!lost && String(args[0]?.url ?? args[0]).includes('/rpc/create_customer') && response.ok) {
        lost = true; window.reviewCreatedId = (await response.clone().json()).id;
        window.reviewKey = JSON.parse(args[1].body).idempotency_key;
        throw Error('Lost committed create receipt');
      }
      return response;
    };
  })()`,
  );
  await click('Create customer');
  await browser('wait', '--text', 'Retry customer creation');
  retriedCustomer = JSON.parse(await browser('eval', 'window.reviewCreatedId'));
  if (!retriedCustomer) throw Error('Lost-receipt fixture did not commit');
  const blankRequest = JSON.parse(await browser('eval', 'window.reviewKey'));
  await browser(
    'eval',
    `(() => {
    window.reviewConfirm = window.confirm; window.reviewConfirmations = 0;
    window.confirm = () => { window.reviewConfirmations++; return false; };
    const e = new Event('beforeunload', {cancelable:true}); window.dispatchEvent(e);
    if(!e.defaultPrevented) throw Error('Unknown blank creation must guard tab close');
    window.reviewConfirmations = 0;
  })()`,
  );
  await browser('click', 'a[href="/customers"]');
  await browser('wait', '--fn', 'window.reviewConfirmations === 1');
  await browser(
    'eval',
    `(() => { if(location.pathname !== '/customers/new') throw Error('Unknown create lost navigation protection'); window.confirm = window.reviewConfirm; })()`,
  );
  await click('Retry customer creation');
  await browser('wait', '--url', `**/customers/${retriedCustomer}`);
  await browser(
    'eval',
    `(() => { const e = new Event('beforeunload', {cancelable:true}); window.dispatchEvent(e); if(e.defaultPrevented) throw Error('Completed creation still blocks leaving'); })()`,
  );
  const replay = await api('/rest/v1/rpc/create_customer', 'POST', {
    idempotency_key: blankRequest,
  });
  if (replay.id !== retriedCustomer) throw Error('Retry created a duplicate customer');
  await browser('open', `${origin.origin}/customers/new`);
  await browser('wait', '--text', 'New customer');
  await browser('fill', 'form.card label:first-of-type input', 'Smoke Customer');
  await browser('fill', 'form.card input[type=email]', 'customer@example.test');
  await browser('eval', `(() => {
    const original = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await original(...args);
      if(String(args[0]?.url ?? args[0]).includes('/rpc/create_customer') && response.ok)
        window.reviewCreatedId = (await response.clone().json()).id;
      return response;
    };
  })()`);
  await click('Create customer');
  await browser('wait', '--fn', '!!window.reviewCreatedId && location.pathname.endsWith(window.reviewCreatedId)');
  customer = JSON.parse(await browser('eval', 'window.reviewCreatedId'));
  await browser('wait', '--text', 'Smoke Customer');
  const created = await api('/rest/v1/rpc/get_admin_customer', 'POST', { customer_id: customer });
  if (created.email !== 'customer@example.test' || created.full_name !== 'Smoke Customer')
    throw Error('Created customer details differ');
  await click('Add address');
  await browser('fill', 'form[aria-label="New address"] label:nth-of-type(2) input', 'Smoke Recipient');
  await browser('fill', 'form[aria-label="New address"] label:nth-of-type(4) input', 'US');
  await browser('fill', 'form[aria-label="New address"] label:nth-of-type(5) input', '1 Main St');
  await browser('click', 'form[aria-label="New address"] button.primary');
  await browser(
    'wait',
    '--fn',
    '!document.querySelector(`form[aria-label="New address"]`) && document.body.innerText.includes("Smoke Recipient")',
  );
  await click('Make default');
  await browser('dialog', 'accept');
  await browser('wait', '--text', 'Default address changed.');
  await browser('set', 'viewport', '390', '844');
  await browser('eval', 'document.querySelector(".editor-side").scrollIntoView()');
  await browser('screenshot', '/tmp/admin-customer-address-mobile.png');
  await click('Unset default');
  await browser('dialog', 'accept');
  await browser('wait', '--text', 'Default address changed.');
  await click('Make default');
  await browser('dialog', 'accept');
  await browser('wait', '--text', 'Default address changed.');
  await click('Edit');
  await browser('fill', 'form[aria-label="Edit address"] label:nth-of-type(5) input', '2 Other St');
  await click('Save address');
  await browser('wait', '--text', 'Address saved.');
  await click('Delete');
  await browser('dialog', 'accept');
  await browser('wait', '--text', 'Address deleted.');
  const saved = await api(`/rest/v1/rpc/get_admin_customer`, 'POST', {
    customer_id: customer,
  });
  if (saved.full_name !== 'Smoke Customer' || saved.addresses.length)
    throw Error('Customer lifecycle state mismatch');
  console.log(
    'Customer smoke passed: exact retry after a lost receipt, creation and address lifecycle.',
  );
} finally {
  try {
    await browser('close');
  } catch {}
  for (const customerId of [customer, retriedCustomer].filter(Boolean)) {
    const sessionData = await api('/auth/v1/token?grant_type=password', 'POST', { email, password });
    const response = await fetch(`${config.API_URL}/rest/v1/rpc/anonymize_customer`, {
      method: 'POST',
      headers: {
        apikey: config.ANON_KEY,
        Authorization: `Bearer ${sessionData.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ customer_id: customerId }),
    });
    if (!response.ok) throw Error(`Customer anonymization failed (${response.status})`);
  }
  if (user) await api(`/auth/v1/admin/users/${user}`, 'DELETE');
}
