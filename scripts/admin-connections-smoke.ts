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
  await wait('No recorded calls found.');
  const auditSection = '[aria-label="My Agent call records"]';
  await browser(
    'eval',
    `document.querySelector('${auditSection}').scrollIntoView();`,
  );
  await browser('screenshot', '/tmp/admin-call-records-empty.png');
  for (let i = 0; i < 22; i++) {
    const outcome = ['pending', 'returned', 'rejected', 'unknown'][i % 4];
    const admitted = new Date(Date.now() - i * 1000).toISOString();
    await db`insert into private.mcp_tool_audit(id,user_id,grant_id,client_id,issuer,resource,project,tool_name,mutation,admitted_at,finished_at,outcome)
      values(${crypto.randomUUID()},${i === 21 ? other : owner},${first.id},${i === 21 ? 'Other private audit' : 'Desktop Agent'},'https://auth.example','https://shop.example/mcp',${session},${outcome === 'unknown' ? 'update_order_admin_note' : i === 20 ? 'get_admin_customer' : 'get_admin_product'},${outcome === 'unknown'},${admitted},${outcome === 'pending' ? null : admitted},${outcome})`;
  }
  await click('Refresh call records');
  await wait('Older call records');
  await browser(
    'eval',
    `(() => {const s=document.querySelector('${auditSection}'); if(s.querySelectorAll('tbody tr').length!==20 || s.textContent.includes('Other private audit'))throw Error('Audit page/isolation'); s.scrollIntoView();})()`,
  );
  await browser('screenshot', '/tmp/admin-call-records.png');
  await click('Older call records');
  await wait('get_admin_customer');
  await browser(
    'eval',
    `if(document.querySelector('${auditSection}').querySelectorAll('tbody tr').length!==1)throw Error('Wrong older page');
    const sendAudit=window.fetch; let failAudit=true; window.fetch=async (...args)=>{
      if(String(args[0]).includes('/list_my_mcp_tool_calls') && failAudit){failAudit=false;return new Response('{}',{status:503});}
      return sendAudit(...args);
    };`,
  );
  await click('Refresh call records');
  await wait('Could not load current call records.');
  await browser(
    'eval',
    `(() => {const s=document.querySelector('${auditSection}'); if(!s.textContent.includes('get_admin_customer'))throw Error('Failed read discarded existing records'); s.scrollIntoView();})()`,
  );
  await browser('screenshot', '/tmp/admin-call-records-error.png');
  await click('Refresh call records');
  await wait('Older call records');
  await browser('set', 'viewport', '390', '844');
  await browser(
    'eval',
    `(() => {const s=document.querySelector('${auditSection}'); s.scrollIntoView(); if(document.documentElement.scrollWidth>innerWidth)throw Error('Audit page overflow'); const t=s.querySelector('.table-wrap'); t.scrollLeft=t.scrollWidth; if(t.scrollLeft<=0)throw Error('Audit table cannot scroll'); t.scrollLeft=0;})()`,
  );
  await browser('screenshot', '/tmp/admin-call-records-mobile.png');
  await browser('set', 'viewport', '1440', '1000');
  const configured = process.env.PUBLIC_MCP_CONNECTION
    ? JSON.parse(process.env.PUBLIC_MCP_CONNECTION)
    : null;
  await browser(
    'eval',
    `(() => {
    const config = ${JSON.stringify(configured)};
    const section = [...document.querySelectorAll('section')].find(s => s.querySelector('h2')?.textContent === 'Connect an Agent');
    if (!section) throw Error('Missing onboarding');
    const inputs = [...section.querySelectorAll('input')];
    if (config) {
      if (inputs[0]?.value !== config.resource || inputs[1]?.value !== config.issuer || inputs.some(i => !i.readOnly)) throw Error('Incorrect endpoints');
      const presets = inputs.slice(2).map(i => i.value);
      const expected = ['store:read', 'store:read store:write'].filter(p => p.split(' ').every(s => config.scopes.includes(s)));
      if (JSON.stringify(presets) !== JSON.stringify(expected)) throw Error('Missing or changed presets');
      if (presets.some(p => p.split(' ').some(s => !config.scopes.includes(s) || ['store:payments','store:access','store:privacy'].includes(s)))) throw Error('Elevated preset');
    } else if (inputs.length || !section.textContent.includes('not published')) throw Error('Invented configuration');
    section.scrollIntoView();
  })()`,
  );
  await browser(
    'screenshot',
    `/tmp/admin-onboarding-${configured ? 'configured' : 'unset'}.png`,
  );
  await browser('set', 'viewport', '390', '844');
  await browser(
    'eval',
    `[...document.querySelectorAll('h2')].find(h => h.textContent === 'Connect an Agent').scrollIntoView(); if(document.documentElement.scrollWidth>innerWidth)throw Error('Onboarding overflows');`,
  );
  await browser(
    'screenshot',
    `/tmp/admin-onboarding-${configured ? 'configured' : 'unset'}-mobile.png`,
  );
  await browser('set', 'viewport', '1440', '1000');
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
  await wait('Older call records');
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
  await checked(
    api(`/rest/v1/profiles?id=eq.${owner}`, {
      service: true,
      method: 'PATCH',
      body: { role: 'admin' },
    }),
  );
  const acrossPages = [later.id];
  for (let i = 0; i < 21; i++)
    acrossPages.push((await grant(owner, `Snapshot Agent ${i + 1}`)).id);
  await browser('open', `${origin.origin}/connections`);
  await wait('Preview all eligible connections');
  await browser(
    'eval',
    `(() => {
    const send=window.fetch; let failPreview=true, lose=true;
    window.snapshotBodies=[];
    window.fetch=async (...args) => {
      if(String(args[0]).includes('/preview_my_mcp_connection_revocation') && failPreview) {
        failPreview=false; return new Response('{}',{status:503});
      }
      if(String(args[0]).includes('/revoke_my_mcp_connections')) {
        snapshotBodies.push(JSON.parse(args[1].body));
        const res=await send(...args);
        if(lose) {lose=false; if(!res.ok)throw Error('RPC failed'); await res.text(); throw TypeError('Lost snapshot receipt');}
        return res;
      }
      return send(...args);
    };
  })()`,
  );
  await click('Preview all eligible connections');
  await wait('Could not verify the complete revocation preview.');
  await browser(
    'eval',
    `if(document.querySelector('[aria-label="Confirm revocation"]') || snapshotBodies.length)throw Error('Failed preview offered a partial mutation');`,
  );
  await click('Preview all eligible connections');
  await wait('Revoke 22 selected connection(s)?');
  await browser('set', 'viewport', '1440', '1000');
  await browser(
    'eval',
    `const section=document.querySelector('[aria-label="Confirm revocation"]'); if(section.querySelectorAll('li').length!==22)throw Error('Missing cross-page identities'); section.scrollIntoView();`,
  );
  await browser('screenshot', '/tmp/admin-connections-snapshot.png');
  await browser('set', 'viewport', '390', '844');
  await browser(
    'eval',
    `document.querySelector('[aria-label="Confirm revocation"]').scrollIntoView(); if(document.documentElement.scrollWidth>innerWidth)throw Error('Snapshot overflow'); const list=document.querySelector('.revocation-selection'); list.scrollTop=list.scrollHeight; if(list.scrollTop<=0 || list.tabIndex!==0)throw Error('Selection not accessible'); list.scrollTop=0;`,
  );
  await browser('screenshot', '/tmp/admin-connections-snapshot-mobile.png');
  await browser(
    'eval',
    `document.querySelector('.revocation-selection').focus();`,
  );
  await browser('press', 'PageDown');
  await browser('wait', '200');
  await browser(
    'eval',
    `if(document.querySelector('.revocation-selection').scrollTop<=0)throw Error('Keyboard cannot scroll selected connections');`,
  );
  const afterPreview = await grant(owner, 'Created after snapshot');
  await click('Confirm revocation');
  await wait('Revocation was not confirmed.');
  await click('Retry same revocation');
  await wait('22 connection(s) revoked locally.');
  await browser(
    'eval',
    `if(snapshotBodies.length!==2 || JSON.stringify(snapshotBodies[0])!==JSON.stringify(snapshotBodies[1]) || JSON.stringify([...snapshotBodies[0].grant_ids].sort())!==${JSON.stringify(JSON.stringify(acrossPages.sort()))})throw Error('Expanded snapshot retry');`,
  );
  if (
    (
      await db`select state from private.mcp_grants where id=${afterPreview.id}`
    )[0].state !== 'active'
  )
    throw Error('Snapshot revoked a later grant');
  const remaining =
    await db`select id from private.mcp_grants where user_id=${owner} and state='active'`;
  if (remaining.length !== 1 || remaining[0].id !== afterPreview.id)
    throw Error('Cross-page revocation incomplete');
  console.log(
    'PASS: login, isolation, exact retries, demoted self-revocation, business gate, cross-page snapshot and later grant exclusion',
  );
} finally {
  try {
    await browser('close');
  } finally {
    await db`delete from private.mcp_tool_audit where project=${session}`;
    await db`delete from private.mcp_grants where binding->>'project'=${session}`;
    await db`delete from private.mcp_grant_fences where binding->>'project'=${session}`;
    for (const id of users)
      await checked(
        api(`/auth/v1/admin/users/${id}`, { method: 'DELETE', service: true }),
      );
    await db.end();
  }
}
