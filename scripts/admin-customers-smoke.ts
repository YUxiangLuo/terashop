import { localSupabase } from './lib/local-supabase';
const config = localSupabase();
const origin = new URL(process.env.ADMIN_URL ?? 'http://127.0.0.1:5174');
if (!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) throw Error('Local admin URL required');
const request = crypto.randomUUID(),
  session = `customers-${request}`;
const email = `${session}@example.test`,
  password = crypto.randomUUID() + 'Aa1!';
let user = '',
  customer = '';
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
}
const click = (name: string) => browser('find', 'role', 'button', 'click', '--name', name, '--exact');
async function browserUrl() {
  const proc = Bun.spawn(['agent-browser', '--session', session, 'get', 'url'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code) throw Error(`Browser URL failed: ${err || out}`);
  return new URL(out.trim());
}
try {
  user = (await api('/auth/v1/admin/users', 'POST', { email, password, email_confirm: true })).id;
  await api(`/rest/v1/profiles?id=eq.${user}`, 'PATCH', { role: 'admin' });
  await browser('open', `${origin.origin}/customers/new`);
  await browser('wait', 'input[type=email]');
  await browser('fill', 'input[type=email]', email);
  await browser('fill', 'input[type=password]', password);
  await click('Sign in');
  await browser('wait', '--text', 'New customer');
  if (!/^[0-9a-f-]{36}$/.test((await browserUrl()).searchParams.get('request') ?? ''))
    throw Error('Direct customer-create route did not initialize its request identity');
  await browser('fill', 'form.card label:first-of-type input', 'Smoke Customer');
  await browser('fill', 'form.card input[type=email]', 'customer@example.test');
  await click('Create customer');
  await browser('wait', '--text', 'Smoke Customer');
  customer = (await browserUrl()).pathname.split('/').pop()!;
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
  const saved = await api(`/rest/v1/rpc/get_admin_customer`, 'POST', { customer_id: customer });
  if (saved.full_name !== 'Smoke Customer' || saved.addresses.length)
    throw Error('Customer lifecycle state mismatch');
  console.log('Customer smoke passed: direct create identity and address create/default/unset/edit/delete.');
} finally {
  try {
    await browser('close');
  } catch {}
  if (customer) {
    const sessionData = await api('/auth/v1/token?grant_type=password', 'POST', { email, password });
    const response = await fetch(`${config.API_URL}/rest/v1/rpc/anonymize_customer`, {
      method: 'POST',
      headers: {
        apikey: config.ANON_KEY,
        Authorization: `Bearer ${sessionData.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ customer_id: customer }),
    });
    if (!response.ok) throw Error(`Customer anonymization failed (${response.status})`);
  }
  if (user) await api(`/auth/v1/admin/users/${user}`, 'DELETE');
}
