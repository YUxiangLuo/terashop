import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { API, ANON_KEY, SERVICE_KEY, api, checked, makeAdmin, rpc, signup, type TestUser } from './helpers';
import { Cleanup } from './support/cleanup';
import { AdminBackend } from '../mcp/src/backend';
import { mcpSession, toolData } from './support/mcp';

const cleanup = new Cleanup();
let admin: TestUser, customer: TestUser;

beforeAll(async () => {
  [admin, customer] = await Promise.all([signup(), signup()]);
  await makeAdmin(admin.userId);
});
afterEach(() => cleanup.run());
afterAll(() => cleanup.run());

const png = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
  0, 0, 0, 1, 0, 0, 0, 1, 8, 4, 0, 0, 0, 181, 28, 12, 2,
  0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 252, 255, 31, 0, 3,
  3, 2, 0, 238, 254, 95, 217, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
]);

function objectRequest(bucket: string, key: string, token: string | undefined, init: RequestInit) {
  return fetch(`${API}/storage/v1/object/${bucket}/${key}`, {
    ...init,
    headers: {
      apikey: ANON_KEY,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(15_000),
  });
}

async function removeObject(key: string) {
  const response = await fetch(`${API}/storage/v1/object/catalog-media/${key}`, {
    method: 'DELETE', headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!response.ok) throw new Error(`Storage cleanup failed: ${response.status} ${await response.text()}`);
}

test('MCP uploads an immutable public object, rejects overwrite, and attaches through product revision', async () => {
  const productId = crypto.randomUUID(), imageId = crypto.randomUUID();
  const key = `products/${productId}/${imageId}.png`;
  cleanup.defer(() => checked(api(`/rest/v1/products?id=eq.${productId}`, { service: true, method: 'DELETE' })));
  const draft = await checked<{ revision: number }>(rpc('create_product', {
    product_id: productId, changes: { product: { slug: productId, name: 'Storage draft' } },
  }, admin.token));

  const session = await mcpSession(new AdminBackend({ url: API, anonKey: ANON_KEY, accessToken: admin.token }), true);
  cleanup.defer(() => session.close());
  const args = { product_id: productId, media_id: imageId, content_type: 'image/png', data_base64: Buffer.from(png).toString('base64') };
  const upload = await toolData(session.client, 'upload_product_media', args);
  cleanup.defer(() => removeObject(key));
  expect(upload).toEqual({ path: key, url: `${API}/storage/v1/object/public/catalog-media/${key}` });
  expect((await session.client.callTool({ name: 'upload_product_media', arguments: args })).isError).toBe(true);
  expect((await session.client.callTool({ name: 'upload_product_media', arguments: {
    ...args, product_id: crypto.randomUUID(),
  } })).isError).toBe(true);
  expect(await checked(rpc('get_admin_product', { product_id: productId }, admin.token))).toMatchObject({
    revision: draft.revision, images: [],
  });

  const publicUrl = `${API}/storage/v1/object/public/catalog-media/${key}`;
  const download = await fetch(publicUrl, { cache: 'no-store' });
  expect(download.status).toBe(200);
  expect(download.headers.get('content-type')).toContain('image/png');
  expect(new Uint8Array(await download.arrayBuffer())).toEqual(png);

  const saved = await checked<{ images: Array<{ id: string; url: string }> }>(rpc('update_product', {
    product_id: productId, expected_revision: draft.revision,
    changes: { images: [{ id: imageId, url: publicUrl, alt: 'Uploaded image' }] },
  }, admin.token));
  expect(saved.images).toContainEqual(expect.objectContaining({ id: imageId, url: publicUrl }));
  expect(await checked(rpc('get_admin_product', { product_id: productId }, admin.token)))
    .toMatchObject({ images: [{ id: imageId, url: publicUrl }] });

  const readonly = await mcpSession(new AdminBackend({ url: API, anonKey: ANON_KEY, accessToken: admin.token }));
  cleanup.defer(() => readonly.close());
  const identity = { product_id: productId, media_id: imageId, content_type: 'image/png' };
  const expected = {
    path: key, url: publicUrl, content_type: 'image/png', byte_size: png.byteLength,
    sha256: Buffer.from(await crypto.subtle.digest('SHA-256', png)).toString('hex'),
  };
  expect(await toolData<typeof expected>(readonly.client, 'inspect_product_media', identity)).toEqual(expected);
  // Objects survive deletion of the product; recovery must not depend on its existence.
  await checked(api(`/rest/v1/products?id=eq.${productId}`, { service: true, method: 'DELETE' }));
  expect(await toolData<typeof expected>(readonly.client, 'inspect_product_media', identity)).toEqual(expected);
  expect((await readonly.client.callTool({ name: 'inspect_product_media', arguments: {
    ...identity, media_id: crypto.randomUUID(),
  } })).isError).toBe(true);
});

test('MCP discovers only canonical product paths, pages by Storage identity, and denies customer access', async () => {
  const productId = crypto.randomUUID(); // No product row: discovery includes orphan uploads.
  const mediaId = crypto.randomUUID();
  const expected: Array<{ id: string; product_id: string; media_id: string; path: string; expected_content_type: string }> = [];
  for (const [extension, mime] of [['jpg', 'image/jpeg'], ['png', 'image/png'], ['webp', 'image/webp']]) {
    const path = `products/${productId}/${mediaId}.${extension}`;
    const uploaded = await objectRequest('catalog-media', path, admin.token, {
      method: 'POST', body: png, headers: { 'Content-Type': 'image/png', 'x-upsert': 'false' },
    });
    expect(uploaded.ok).toBe(true);
    cleanup.defer(() => removeObject(path));
    const result = await uploaded.json();
    expect(result.Id).toBeString();
    expected.push({ id: result.Id, product_id: productId, media_id: mediaId, path, expected_content_type: mime });
  }
  // Service fixtures deliberately bypass the canonical-key insert policy.
  for (const path of [
    `products/${crypto.randomUUID()}/${mediaId}.png`,
    `products/${productId}/legacy.png`,
    `products/${productId}/${mediaId}.png/extra`,
    `products/${productId}/${mediaId}.gif`,
  ]) {
    const uploaded = await objectRequest('catalog-media', path, SERVICE_KEY, {
      method: 'POST', body: png, headers: { 'Content-Type': 'image/png' },
    });
    expect(uploaded.ok).toBe(true);
    cleanup.defer(() => removeObject(path));
  }
  expected.sort((a, b) => a.id.localeCompare(b.id));
  const session = await mcpSession(new AdminBackend({ url: API, anonKey: ANON_KEY, accessToken: admin.token }));
  cleanup.defer(() => session.close());
  type Page = { items: typeof expected; next_cursor: string | null };
  let after: string | undefined;
  for (let i = 0; i < expected.length; i++) {
    const page = await toolData<Page>(session.client, 'list_admin_product_media', {
      product_id: productId.toUpperCase(), page_size: 1, ...(after ? { after_id: after } : {}),
    });
    expect(page).toEqual({ items: [expected[i]], next_cursor: i < expected.length - 1 ? expected[i].id : null });
    after = expected[i].id;
  }
  expect(await toolData<Page>(session.client, 'list_admin_product_media', {
    product_id: productId, after_id: after,
  })).toEqual({ items: [], next_cursor: null });
  expect(await toolData<Page>(session.client, 'list_admin_product_media', {
    product_id: crypto.randomUUID(),
  })).toEqual({ items: [], next_cursor: null });
  for (const token of [undefined, customer.token]) {
    expect((await rpc('list_admin_product_media', { product_id: productId }, token)).status).toBeGreaterThanOrEqual(400);
  }
  for (const invalid of [{ page_size: 0 }, { page_size: 101 }, { page_size: null }, { product_id: null }]) {
    expect((await rpc('list_admin_product_media', { product_id: productId, ...invalid }, admin.token)).data)
      .toMatchObject({ code: '22023' });
  }
});

test('bucket has the durable public 5 MiB JPEG/PNG/WebP configuration', async () => {
  const response = await fetch(`${API}/storage/v1/bucket/catalog-media`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    id: 'catalog-media', public: true, file_size_limit: 5 * 1024 * 1024,
    allowed_mime_types: ['image/jpeg', 'image/png', 'image/webp'],
  });
});

test('anonymous and customer uploads are denied; admin is confined to the exact key contract', async () => {
  const productId = crypto.randomUUID(), imageId = crypto.randomUUID();
  const validKey = `products/${productId}/${imageId}.png`;
  for (const [token, key] of [
    [undefined, validKey], [customer.token, validKey],
    [admin.token, `${productId}/${imageId}.png`],
    [admin.token, `products/${productId}/${imageId}.gif`],
    [admin.token, `products/not-a-uuid/${imageId}.png`],
  ] as const) {
    const response = await objectRequest('catalog-media', key, token, {
      method: 'POST', body: png, headers: { 'Content-Type': 'image/png', 'x-upsert': 'false' },
    });
    expect(response.ok).toBe(false);
  }
  const bucket = `outside-${crypto.randomUUID()}`;
  const createBucket = await fetch(`${API}/storage/v1/bucket`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: bucket, name: bucket, public: false }),
  });
  expect(createBucket.status).toBe(200);
  cleanup.defer(async () => {
    const response = await fetch(`${API}/storage/v1/bucket/${bucket}`, {
      method: 'DELETE', headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    });
    if (!response.ok) throw new Error(`Bucket cleanup failed: ${response.status} ${await response.text()}`);
  });
  const otherBucket = await objectRequest(bucket, validKey, admin.token, {
    method: 'POST', body: png, headers: { 'Content-Type': 'image/png', 'x-upsert': 'false' },
  });
  expect(otherBucket.ok).toBe(false);
});

test('admin cannot overwrite or delete, and server rejects disallowed MIME and oversized objects', async () => {
  const productId = crypto.randomUUID(), imageId = crypto.randomUUID();
  const key = `products/${productId}/${imageId}.png`;
  const upload = await objectRequest('catalog-media', key, admin.token, {
    method: 'POST', body: png, headers: { 'Content-Type': 'image/png', 'x-upsert': 'false' },
  });
  expect(upload.status).toBe(200);
  cleanup.defer(() => removeObject(key));

  const overwrite = await objectRequest('catalog-media', key, admin.token, {
    method: 'POST', body: png, headers: { 'Content-Type': 'image/png', 'x-upsert': 'true' },
  });
  expect(overwrite.ok).toBe(false);
  const deletion = await objectRequest('catalog-media', key, admin.token, { method: 'DELETE' });
  expect(deletion.ok).toBe(false);
  expect((await fetch(`${API}/storage/v1/object/public/catalog-media/${key}`)).status).toBe(200);

  const badMime = await objectRequest('catalog-media', `products/${productId}/${crypto.randomUUID()}.png`, admin.token, {
    method: 'POST', body: png, headers: { 'Content-Type': 'text/plain', 'x-upsert': 'false' },
  });
  expect(badMime.ok).toBe(false);
  expect(await badMime.text()).toMatch(/mime|type/i);
  const tooLarge = await objectRequest('catalog-media', `products/${productId}/${crypto.randomUUID()}.png`, admin.token, {
    method: 'POST', body: new Uint8Array(5 * 1024 * 1024 + 1),
    headers: { 'Content-Type': 'image/png', 'x-upsert': 'false' },
  });
  expect(tooLarge.ok).toBe(false);
  expect(await tooLarge.text()).toMatch(/size|large|limit/i);
});
