// Local disposable fixtures; real login, RPC reads and private Realtime.
import { localSupabase } from './lib/local-supabase';
const config = localSupabase();
const origin = new URL(process.env.ADMIN_URL ?? 'http://127.0.0.1:5174');
if (!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) throw Error('Local Admin required');
const marker = `live-${crypto.randomUUID()}`;
const ids = Array.from({ length: 21 }, () => crypto.randomUUID());
let user = '';
const password = crypto.randomUUID() + 'Aa1!';
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
  return result.status === 204 ? null : result.json();
}
async function browser(...args: string[]) {
  const proc = Bun.spawn(['agent-browser', '--session', marker, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code) throw Error(`Browser ${args[0]}: ${err || out}`);
  return out.trim();
}
const click = (name: string) => browser('find', 'role', 'button', 'click', '--name', name, '--exact');
const wait = (text: string) => browser('wait', '--text', text);
const condition = (code: string) => browser('wait', '--fn', code);
const table = `document.querySelector('[aria-label="Product catalog"] tbody')`;
try {
  user = (
    await api('/auth/v1/admin/users', 'POST', {
      email: `${marker}@example.test`,
      password,
      email_confirm: true,
    })
  ).id;
  await api(`/rest/v1/profiles?id=eq.${user}`, 'PATCH', { role: 'admin' });
  await api(
    '/rest/v1/products',
    'POST',
    ids.map((id, i) => ({
      id,
      slug: `${marker}-${i}`,
      name: `${marker} Item ${i}`,
      status: 'draft',
      updated_at: new Date(Date.now() - i * 1000).toISOString(),
    })),
  );
  await api('/rest/v1/product_variants', 'POST', { product_id: ids[0], sku: marker, price: 13.27 });
  await browser('open', origin.origin);
  await browser('wait', 'input[type=email]');
  await browser('fill', 'input[type=email]', `${marker}@example.test`);
  await browser('fill', 'input[type=password]', password);
  await click('Sign in');
  await wait('Live product updates connected.');
  await condition(`![...document.querySelectorAll('button')].find(b=>b.textContent==='Apply').disabled`);
  await browser('fill', 'input[type=search]', marker);
  await browser('select', 'select', 'draft');
  await click('Apply');
  await wait('20 loaded');
  await click('Load more');
  await wait('21 loaded');
  await browser('fill', 'input[type=search]', 'Unsubmitted search');
  await browser(
    'eval',
    `(() => {
    const send=window.fetch; let fail=true;
    window.fetch=async (...args)=>{
      if(String(args[0]).includes('/list_admin_products') && JSON.parse(args[1].body).after_cursor && fail){
        fail=false; return new Response('{}',{status:503});
      }
      return send(...args);
    };
  })()`,
  );
  await api(`/rest/v1/products?id=in.(${ids[0]},${ids[20]})`, 'PATCH', { name: `${marker} Renamed` });
  await wait('Displayed products may be stale.');
  await browser(
    'eval',
    `if(${table}.rows.length!==21 || ${table}.textContent.includes('Renamed') || !${table}.textContent.includes('Item 20'))throw Error('Partial refresh installed')`,
  );
  await browser('screenshot', '/tmp/admin-products-live-error.png');
  await click('Retry');
  await condition(
    `[...${table}.querySelectorAll('a')].filter(a=>a.textContent.includes('Renamed')).length===2 && !document.body.innerText.includes('Loading products')`,
  );
  await browser(
    'eval',
    `if(${table}.rows.length!==21 || document.querySelector('input[type=search]').value!=='Unsubmitted search')throw Error('Pages or filter draft discarded')`,
  );
  await api(`/rest/v1/product_variants?product_id=eq.${ids[0]}`, 'PATCH', { price: 29.31 });
  await wait('$29.31');
  await api(`/rest/v1/products?id=eq.${ids[20]}`, 'PATCH', { status: 'archived' });
  await wait('20 loaded');
  await condition(`!${table}.querySelector('a[href="/products/${ids[20]}"]')`);
  await api(`/rest/v1/products?id=eq.${ids[19]}`, 'DELETE');
  await wait('19 loaded');
  await browser('set', 'viewport', '390', '844');
  await browser(
    'eval',
    `if(document.documentElement.scrollWidth>innerWidth)throw Error('Product page overflow')`,
  );
  await browser('screenshot', '/tmp/admin-products-live-mobile.png');
  await browser('set', 'viewport', '1440', '1000');
  await browser('screenshot', '/tmp/admin-products-live.png');
  console.log(
    'PASS: live product pages, atomic failed refresh/retry, filter draft, variant price, status removal and delete',
  );
} finally {
  const failures: unknown[] = [];
  for (const cleanup of [
    () => browser('close'),
    () => api(`/rest/v1/products?id=in.(${ids.join(',')})`, 'DELETE'),
    async () => {
      if (user) await api(`/auth/v1/admin/users/${user}`, 'DELETE');
    },
  ]) {
    try {
      await cleanup();
    } catch (cause) {
      failures.push(cause);
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Fixture cleanup failed');
}
