// Local-only real personal RPCs and browser login. No shop business mutations.
import { localSupabase } from './lib/local-supabase';
import postgres from 'postgres';
Object.assign(process.env, localSupabase());
const { api, checked } = await import('../tests/helpers');
const origin = new URL(process.env.ADMIN_URL ?? 'http://127.0.0.1:5174');
if (!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))
  throw Error('Local Admin URL required');
const session = `connections-${crypto.randomUUID()}`;
const db = postgres(process.env.DB_URL!, { max: 1 });
const users: string[] = [];
const password = crypto.randomUUID() + 'Aa1!';
const email = `${session}@example.test`;
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
const click = (name: string) =>
  browser('find', 'role', 'button', 'click', '--name', name, '--exact');
const wait = (text: string) => browser('wait', '--text', text);
async function user(address: string) {
  const { id } = await checked<{ id: string }>(
    api('/auth/v1/admin/users', {
      service: true,
      method: 'POST',
      body: { email: address, password, email_confirm: true },
    }),
  );
  users.push(id);
  await checked(
    api(`/rest/v1/profiles?id=eq.${id}`, {
      service: true,
      method: 'PATCH',
      body: { role: 'admin' },
    }),
  );
  return id;
}
async function grant(userId: string, client: string) {
  return checked<{ id: string }>(
    api('/rest/v1/rpc/mcp_grant_command', {
      service: true,
      method: 'POST',
      body: {
        p_action: 'create',
        p_user_id: userId,
        p_scopes: ['store:read'],
        p_binding: {
          issuer: 'https://auth.example',
          resource: 'https://shop.example/mcp',
          project: session,
          subject: userId,
          client_id: client,
          session_id: crypto.randomUUID(),
        },
      },
    }),
  );
}
try {
  const owner = await user(email),
    other = await user(`other-${email}`);
  const first = await grant(owner, 'Desktop Agent'),
    second = await grant(owner, 'Read-only Assistant');
  await grant(other, 'Other user connection');
  await browser('set', 'viewport', '1440', '1000');
  await browser('open', `${origin.origin}/connections`);
  await browser('wait', 'input[type=email]');
  await browser('fill', 'input[type=email]', email);
  await browser('fill', 'input[type=password]', password);
  await click('Sign in');
  await wait('Desktop Agent');
  await browser(
    'eval',
    `if(document.body.textContent.includes('Other user connection')) throw Error('Cross-user disclosure'); if(document.querySelector('main [role=alert]')) throw Error('List failed');`,
  );
  await click('Revoke Desktop Agent');
  await wait('Revoke 1 selected connection(s)?');
  await browser('screenshot', '/tmp/admin-connections-confirm.png', '--full');
  // Drop a real committed receipt; do not fabricate a successful RPC.
  await browser(
    'eval',
    `(() => {
    const send=window.fetch; window.revokeBodies=[]; let lose=true;
    window.fetch=async (...args) => {
      if(String(args[0]).includes('/revoke_my_mcp_connections')) {
        window.revokeBodies.push(JSON.parse(args[1].body));
        const res=await send(...args);
        if(lose) {lose=false; if(!res.ok)throw Error('RPC did not commit'); await res.text(); throw TypeError('Lost receipt');}
        return res;
      }
      return send(...args);
    };
  })()`,
  );
  await click('Confirm revocation');
  await wait('Revocation was not confirmed.');
  await browser('screenshot', '/tmp/admin-connections-unknown.png', '--full');
  const later = await grant(owner, 'New connection after confirmation');
  await click('Retry same revocation');
  await wait('1 connection(s) revoked locally.');
  await browser(
    'eval',
    `if(revokeBodies.length!==2 || JSON.stringify(revokeBodies[0])!==JSON.stringify(revokeBodies[1])) throw Error('Changed retry snapshot');`,
  );
  const [revoked] =
    await db`select state from private.mcp_grants where id=${first.id}`;
  if (revoked.state !== 'revoked') throw Error('Revocation not persisted');
  const [unaffected] =
    await db`select state from private.mcp_grants where id=${later.id}`;
  if (unaffected.state !== 'active') throw Error('New grant revoked by retry');
  await wait('New connection after confirmation');
  await browser('screenshot', '/tmp/admin-connections.png', '--full');
  await browser('set', 'viewport', '390', '844');
  await browser('screenshot', '/tmp/admin-connections-mobile.png', '--full');
  await browser(
    'eval',
    `const table=document.querySelector('.table-wrap'); if(document.documentElement.scrollWidth>innerWidth)throw Error('Page overflows'); table.scrollLeft=table.scrollWidth; if(table.scrollLeft<=0)throw Error('Table cannot scroll');`,
  );
  await browser(
    'screenshot',
    '/tmp/admin-connections-mobile-actions.png',
    '--full',
  );
  await checked(
    api(`/rest/v1/profiles?id=eq.${owner}`, {
      service: true,
      method: 'PATCH',
      body: { role: 'customer' },
    }),
  );
  await browser('reload');
  await wait('Read-only Assistant');
  await browser(
    'eval',
    `if(document.querySelector('nav a[href="/orders"]'))throw Error('Business navigation exposed after demotion');`,
  );
  await click('Revoke Read-only Assistant');
  await click('Confirm revocation');
  await wait('1 connection(s) revoked locally.');
  if (
    (await db`select state from private.mcp_grants where id=${second.id}`)[0]
      .state !== 'revoked'
  )
    throw Error('Demoted self revoke failed');
  await browser('open', `${origin.origin}/orders`);
  await wait('Administrator access required');
  console.log(
    'PASS: real login, personal isolation, exact retry after lost receipt, new grant preserved, demoted self-revocation and business gate',
  );
} finally {
  try {
    await browser('close');
  } finally {
    await db`delete from private.mcp_grants where binding->>'project'=${session}`;
    await db`delete from private.mcp_grant_fences where binding->>'project'=${session}`;
    for (const id of users)
      await checked(
        api(`/auth/v1/admin/users/${id}`, { method: 'DELETE', service: true }),
      );
    await db.end();
  }
}
