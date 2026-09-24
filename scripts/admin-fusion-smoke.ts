// Focused browser verification for advanced product fields and bounded MCP approvals.
// Creates only disposable local fixtures and never invokes a provider.
import postgres from 'postgres';
import { localSupabase } from './lib/local-supabase';

const config = localSupabase();
const origin = new URL(process.env.ADMIN_URL ?? 'http://127.0.0.1:5174');
if (!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) throw Error('Local admin URL required');
const run = crypto.randomUUID(),
  session = `fusion-${run}`;
const adminEmail = `${session}-admin@example.test`,
  targetEmail = `${session}-target@example.test`;
const password = `${crypto.randomUUID()}Aa1!`;
const product = crypto.randomUUID(),
  variant = crypto.randomUUID(),
  productMeta = crypto.randomUUID(),
  variantMeta = crypto.randomUUID();
const grant = crypto.randomUUID(),
  auditId = crypto.randomUUID(),
  approveId = crypto.randomUUID(),
  rejectId = crypto.randomUUID();
const issuer = `https://issuer.example.test/${run}`,
  resource = `https://resource.example.test/${run}`,
  project = `project-${run}`,
  client = `client-${run}`;
let admin = '',
  target = '';
const sql = postgres(config.DB_URL, { max: 1 });

async function api(path: string, method: string, body?: unknown, token = config.SERVICE_ROLE_KEY) {
  const response = await fetch(`${config.API_URL}${path}`, {
    method,
    headers: {
      apikey: token === config.SERVICE_ROLE_KEY ? config.SERVICE_ROLE_KEY : config.ANON_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw Error(`API ${path} failed (${response.status}): ${text}`);
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
  if (code) throw Error(`Browser ${args.join(' ')} failed: ${err || out}`);
  return out.trim();
}
const fillLabel = (label: string, value: string) => browser('find', 'label', label, 'fill', value);
const click = (name: string) => browser('find', 'role', 'button', 'click', '--name', name, '--exact');
const approvalBody = (action: string, id: string) => ({
  p_action: action,
  p_approval_id: id,
  p_grant_id: grant,
  p_user_id: admin,
  p_issuer: issuer,
  p_resource: resource,
  p_project: project,
  p_tool_name: 'set_user_role',
  p_arguments: { user_id: target, role: 'admin' },
});

try {
  admin = (await api('/auth/v1/admin/users', 'POST', { email: adminEmail, password, email_confirm: true }))
    .id;
  target = (await api('/auth/v1/admin/users', 'POST', { email: targetEmail, password, email_confirm: true }))
    .id;
  await api(`/rest/v1/profiles?id=eq.${admin}`, 'PATCH', { role: 'admin' });
  await sql.begin(async (tx: any) => {
    await tx`insert into public.products(id,slug,name,description,status,vendor,product_type,tags,seo_title,seo_description) values (${product},${`fusion-${run}`},'Fusion original','Original description','draft','Old vendor','Old type',${tx.array(['old', 'tag'])},'Old SEO','Old SEO description')`;
    await tx`insert into public.product_variants(id,product_id,sku,barcode,price,compare_at_price,cost,position) values (${variant},${product},${`SKU-${run}`},'OLD-BARCODE',10.00,15.00,4.00,37)`;
    await tx`insert into public.metafield_definitions(owner_type,namespace,key,name,type) values ('product','fusion',${`product_${run.replaceAll('-', '_')}`},'Fusion product','text'),('variant','fusion',${`variant_${run.replaceAll('-', '_')}`},'Fusion variant','text')`;
    await tx`insert into public.metafields(id,owner_type,owner_id,namespace,key,type,value) values (${productMeta},'product',${product},'fusion',${`product_${run.replaceAll('-', '_')}`},'text','"keep-product"'),(${variantMeta},'variant',${variant},'fusion',${`variant_${run.replaceAll('-', '_')}`},'text','"keep-variant"')`;
    await tx`insert into private.mcp_grants(id,binding,user_id,scopes) values (${grant},${tx.json({ issuer, resource, project, client_id: client })},${admin},${tx.array(['store:write', 'store:access'])})`;
  });
  await api('/rest/v1/rpc/mcp_action_approval_command', 'POST', approvalBody('stage', approveId));

  await browser('open', `${origin.origin}/products/${product}`);
  await browser('wait', 'input[type=email]');
  await browser('fill', 'input[type=email]', adminEmail);
  await browser('fill', 'input[type=password]', password);
  await click('Sign in');
  await browser('wait', '--text', 'Fusion original');
  await fillLabel('Vendor', 'New Vendor');
  await fillLabel('Product type', 'Limited Edition');
  await fillLabel('Tags', 'alpha, beta, exact-tag');
  await fillLabel('SEO title', 'Fusion SEO exact');
  await fillLabel('SEO description', 'Exact fusion search description');
  await fillLabel('Variant 1 barcode', 'NEW-123456789');
  await fillLabel('Variant 1 price', '22.34');
  await fillLabel('Variant 1 compare-at price', '29.99');
  await fillLabel('Variant 1 cost', '8.76');
  await browser('screenshot', '--full', '/tmp/admin-fusion-product-desktop.png');
  await browser('set', 'viewport', '390', '844');
  await browser('eval', `document.querySelector('[aria-label="Variant 1 barcode"]').closest('label').scrollIntoView(); window.scrollBy(0,-80)`);
  await browser('screenshot', '/tmp/admin-fusion-product-mobile.png');
  await browser('set', 'viewport', '1440', '1000');
  await click('Save product');
  await browser('wait', '--text', 'Product saved as draft.');
  const auth = await api('/auth/v1/token?grant_type=password', 'POST', { email: adminEmail, password });
  const saved = await api(
    '/rest/v1/rpc/get_admin_product',
    'POST',
    { product_id: product },
    auth.access_token,
  );
  const sv = saved.variants.find((v: { id: string }) => v.id === variant);
  if (
    saved.vendor !== 'New Vendor' ||
    saved.product_type !== 'Limited Edition' ||
    JSON.stringify(saved.tags) !== JSON.stringify(['alpha', 'beta', 'exact-tag']) ||
    saved.seo_title !== 'Fusion SEO exact' ||
    saved.seo_description !== 'Exact fusion search description' ||
    sv.barcode !== 'NEW-123456789' ||
    Number(sv.price) !== 22.34 ||
    Number(sv.compare_at_price) !== 29.99 ||
    Number(sv.cost) !== 8.76
  )
    throw Error(`Advanced product RPC mismatch: ${JSON.stringify(saved)}`);
  const preservedVariant = await sql`select position from public.product_variants where id=${variant}`;
  const preservedMetafields =
    await sql`select id,value from public.metafields where id in (${productMeta},${variantMeta}) order by id`;
  if (
    preservedVariant[0]?.position !== 37 ||
    preservedMetafields.length !== 2 ||
    preservedMetafields.find((m) => m.id === productMeta)?.value !== 'keep-product' ||
    preservedMetafields.find((m) => m.id === variantMeta)?.value !== 'keep-variant'
  )
    throw Error('Unedited variant position/metafields were not preserved');

  await browser('open', `${origin.origin}/approvals`);
  await browser('wait', '--text', approveId);
  const page = await browser('get', 'text', 'body');
  for (const expected of [approveId, target, '"role": "admin"', client, resource])
    if (!page.includes(expected)) throw Error(`Approval UI omitted ${expected}`);
  await browser('screenshot', '/tmp/admin-fusion-approvals-desktop.png');
  await click('Approve exact request');
  await browser('dialog', 'accept');
  await browser('wait', '1000');
  const approved = await sql`select state from private.mcp_action_approvals where id=${approveId}`;
  if (approved[0]?.state !== 'approved') throw Error('Approval decision was not persisted');
  const consumed = await api(
    '/rest/v1/rpc/mcp_action_approval_command',
    'POST',
    approvalBody('consume', approveId),
  );
  if (consumed.state !== 'consumed') throw Error('Trusted consume did not complete');
  const role = await sql`select role from public.profiles where id=${target}`;
  if (role[0]?.role !== 'admin') throw Error('Disposable target role was not updated');
  let replayBlocked = false;
  try {
    await api('/rest/v1/rpc/mcp_action_approval_command', 'POST', approvalBody('consume', approveId));
  } catch {
    replayBlocked = true;
  }
  if (!replayBlocked) throw Error('Consumed approval replay was not blocked');

  await api(`/rest/v1/profiles?id=eq.${target}`, 'PATCH', { role: 'customer' });
  await api('/rest/v1/rpc/mcp_action_approval_command', 'POST', approvalBody('stage', rejectId));
  await click('Refresh');
  await browser('wait', '--text', rejectId);
  await click('Reject');
  await browser('dialog', 'accept');
  await browser('wait', '1000');
  let rejectedBlocked = false;
  try {
    await api('/rest/v1/rpc/mcp_action_approval_command', 'POST', approvalBody('consume', rejectId));
  } catch {
    rejectedBlocked = true;
  }
  const rejected = await sql`select state from private.mcp_action_approvals where id=${rejectId}`;
  if (!rejectedBlocked || rejected[0]?.state !== 'rejected')
    throw Error('Rejected request was not persistently blocked');
  await browser('set', 'viewport', '390', '844');
  await browser('screenshot', '/tmp/admin-fusion-approvals-mobile.png');
  await api('/rest/v1/rpc/mcp_tool_audit_command', 'POST', {
    p_action: 'begin', p_id: auditId, p_grant_id: grant, p_user_id: admin,
    p_issuer: issuer, p_resource: resource, p_project: project,
    p_tool_name: 'update_product', p_mutation: true, p_resource_type: 'product', p_resource_id: product,
  });
  await browser('open', `${origin.origin}/connections`);
  await browser('wait', `section[aria-label="My Agent call records"] a[href="/products/${product}"]`);
  await browser('eval', `document.querySelector('section[aria-label="My Agent call records"]').scrollIntoView()`);
  await browser('screenshot', '/tmp/admin-fusion-audit-mobile.png');
  console.log(
    'PASS: advanced product persistence/preservation and exact approve/consume-once/reject approval lifecycle',
  );
} finally {
  try {
    await browser('close');
  } catch {}
  try {
    await sql.begin(async (tx: any) => {
      await tx`delete from private.mcp_tool_audit where id=${auditId}`;
      await tx`delete from private.mcp_action_approvals where id in (${approveId},${rejectId})`;
      await tx`delete from private.mcp_grants where id=${grant}`;
      await tx`delete from public.products where id=${product}`;
      await tx`delete from public.metafield_definitions where namespace='fusion' and key in (${`product_${run.replaceAll('-', '_')}`},${`variant_${run.replaceAll('-', '_')}`})`;
    });
  } catch (error) {
    console.error('Fixture SQL cleanup failed', error);
  }
  for (const id of [target, admin])
    if (id)
      try {
        await api(`/auth/v1/admin/users/${id}`, 'DELETE');
      } catch (error) {
        console.error('Fixture user cleanup failed', error);
      }
  await sql.end();
}
