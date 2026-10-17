import assert from 'node:assert/strict';
import type { Client } from '@modelcontextprotocol/client';
import { api, checked } from '../helpers';

// Called only after actual browser OAuth consent and PKCE exchange. The Admin
// session is independently established; no token/cookie/session injection.
export async function verifyAdminFusion(input: {
  client: Client;
  browser: (...args: string[]) => Promise<string>;
  adminOrigin: string;
  email: string;
  resource: string;
  accessToken: string;
  ca: string;
}) {
  const { client, browser, adminOrigin, email } = input;
  const id = crypto.randomUUID();
  const name = `MCP fusion ${id}`;
  const click = (name: string) => browser('find', 'role', 'button', 'click', '--name', name, '--exact');
  const wait = (text: string) => browser('wait', '--text', text);
  async function read() {
    const result = await client.callTool({ name: 'get_admin_category', arguments: { category_id: id } });
    assert.notEqual(result.isError, true);
    const content = result.structuredContent as {
      data: {
        id: string;
        name: string;
        updated_at: string;
        is_active: boolean;
      };
    };
    assert.ok(content?.data);
    return content.data;
  }
  async function update(expected_updated_at: string, name: string) {
    const result = await client.callTool({
      name: 'update_category',
      arguments: {
        category_id: id,
        expected_updated_at,
        changes: { name },
      },
    });
    assert.notEqual(result.isError, true);
    const data = (result.structuredContent as { data: { id: string; updated_at: string } }).data;
    assert.equal(data.id, id);
    assert.equal(typeof data.updated_at, 'string');
    return data.updated_at;
  }
  try {
    const result = await client.callTool({
      name: 'create_category',
      arguments: { category_id: id, changes: { name, slug: `fusion-${id}`, is_active: false, position: -7 } },
    });
    assert.notEqual(result.isError, true);
    const original = await read();
    assert.equal(original.id, id);
    assert.equal(original.name, name);
    assert.equal(original.is_active, false);
    assert.equal(typeof original.updated_at, 'string');
    await browser('open', `${adminOrigin}/categories/${id}`);
    await browser('wait', 'input[type=email]');
    await browser('fill', 'input[type=email]', email);
    await browser('fill', 'input[type=password]', 'password123'); // signup fixture's password
    await click('Sign in');
    await browser('wait', '#category-form');
    await browser(
      'eval',
      `(() => {
      const form=document.querySelector('#category-form');
      if(form.querySelector('input').value!==${JSON.stringify(name)} || form.querySelector('input[type=checkbox]').checked || form.querySelector('input[type=number]').value!=='-7')throw Error('MCP facts differ in Admin');
    })()`,
    );
    const nameInput = '#category-form section:first-child > label:first-of-type input';
    await browser('fill', nameInput, 'Unsaved local edit');
    const remoteVersion = await update(original.updated_at, 'Remote change during editing');
    await browser('set', 'viewport', '390', '844');
    await click('Save category');
    await wait('Another edit changed this record.');
    await browser(
      'eval',
      `if(!document.querySelector('#category-form fieldset').disabled || document.querySelector('${nameInput}').value!=='Unsaved local edit')throw Error('Conflicting editor overwritten or unlocked')`,
    );
    await browser('screenshot', '/tmp/admin-fusion-conflict.png', '--full');
    await click('Reload category');
    await browser('dialog', 'accept');
    await browser(
      'wait',
      '--fn',
      `document.querySelector('${nameInput}').value==='Remote change during editing' && !document.querySelector('#category-form fieldset').disabled`,
    );
    // Prove both clients consume the same revision contract, not parallel state.
    await browser(
      'fill',
      '#category-form section:first-child > label:first-of-type input',
      'Edited independently in Admin',
    );
    await click('Save category');
    await wait('Category saved');
    const saved = await read();
    assert.equal(saved.name, 'Edited independently in Admin');
    assert.notEqual(saved.updated_at, remoteVersion);
    assert.equal(saved.is_active, false);
    const stale = await client.callTool({
      name: 'update_category',
      arguments: {
        category_id: id,
        expected_updated_at: original.updated_at,
        changes: { name: 'Stale overwrite' },
      },
    });
    assert.equal(stale.isError, true);
    assert.equal((await read()).name, saved.name);
    await browser('open', `${adminOrigin}/connections`);
    await wait('create_category');
    await wait('update_category');
    const rowCount = Number(await browser('get', 'count', '[aria-label="My Agent call records"] tbody tr'));
    await read();
    await click('Refresh call records');
    await browser(
      'wait',
      '--fn',
      `document.querySelectorAll('[aria-label="My Agent call records"] tbody tr').length===${rowCount + 1}`,
    );
    await browser('set', 'viewport', '1440', '1000');
    await browser('eval', `document.querySelector('[aria-label="My Agent call records"]').scrollIntoView()`);
    await browser('screenshot', '/tmp/admin-fusion-calls.png');
    await browser(
      'eval',
      `(() => {
      const section=document.querySelector('[aria-label="My Agent call records"]');
      const rows=[...section.querySelectorAll('tbody tr')];
      for(const [tool,outcome] of [['create_category','returned'],['update_category','rejected']]) {
        const row=rows.find(r=>r.querySelector('strong')?.textContent===tool && r.textContent.includes(outcome));
        if(!row || !row.textContent.includes(outcome) || !row.textContent.includes('agent') || !row.textContent.includes(${JSON.stringify(input.resource)}))throw Error('Missing trusted call audit');
      }
      if(section.textContent.includes(${JSON.stringify(name)}) || section.textContent.includes('Stale overwrite'))throw Error('Arguments leaked into audit');
    })()`,
    );
    await click('Revoke agent');
    await wait('Revoke 1 selected connection(s)?');
    await click('Confirm revocation');
    await wait('1 connection(s) revoked locally.');
    // Explicitly reuse the same bearer. No OAuth auto-refresh and no new client
    // registration can obscure whether the original grant was actually denied.
    for (const tool of [
      { name: 'get_admin_category', arguments: { category_id: id } },
      {
        name: 'update_category',
        arguments: {
          category_id: id,
          expected_updated_at: saved.updated_at,
          changes: { name: 'Revoked overwrite' },
        },
      },
    ]) {
      const response = await fetch(input.resource, {
        method: 'POST',
        tls: { ca: input.ca },
        headers: {
          Authorization: `Bearer ${input.accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'tools/call', params: tool }),
        signal: AbortSignal.timeout(10000),
      });
      await response.body?.cancel();
      assert.equal(response.status, 401, 'Original bearer must fail after Admin revocation');
    }
    await browser('open', `${adminOrigin}/categories/${id}`);
    await browser('wait', '#category-form');
    await browser(
      'eval',
      `if(document.querySelector('#category-form input').value!==${JSON.stringify(saved.name)})throw Error('Revoked write changed category')`,
    );
    console.log(
      'Admin fusion: OAuth -> MCP write -> Admin edit/audit -> revoke -> same bearer read/write denied',
    );
  } finally {
    await checked(api(`/rest/v1/categories?id=eq.${id}`, { method: 'DELETE', service: true }));
  }
}
