import { localSupabase } from './lib/local-supabase';

// Local demonstration assets only. Never accept remote credentials or targets.
const { API_URL, SERVICE_ROLE_KEY } = localSupabase();
const bucket = 'catalog-media';
async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      ...init.headers },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Media seed: ${init.method ?? 'GET'} ${path} returned ${response.status}`);
  return response;
}
const json = (method: string, body: unknown): RequestInit => ({
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const products: Array<{ id: string; slug: string; name: string }> = await (await request(
  '/rest/v1/products?vendor=eq.Atelier%20Tera&select=id,slug,name',
)).json();
const files = [...new Bun.Glob('*.webp').scanSync('supabase/seed-assets')].sort();
if (files.length !== 10 || products.length !== files.length ||
    products.some(product => !files.includes(`${product.slug}.webp`))) {
  throw new Error('Media seed requires the default Atelier Tera catalog; run bun run setup');
}
const buckets: Array<{ id: string }> = await (await request('/storage/v1/bucket')).json();
const settings = { public: true, file_size_limit: 1048576, allowed_mime_types: ['image/webp'] };
if (buckets.some(item => item.id === bucket)) {
  await request(`/storage/v1/bucket/${bucket}`, json('PUT', settings));
} else {
  await request('/storage/v1/bucket', json('POST', { id: bucket, name: bucket, ...settings }));
}
// A public bucket permits downloads, not writes. No client write policies are added.
for (const product of products) {
  const bytes = await Bun.file(`supabase/seed-assets/${product.slug}.webp`).bytes();
  const hash = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
  const key = `${product.slug}/${hash}.webp`;
  await request(`/storage/v1/object/${bucket}/${key}`, {
    method: 'POST', body: bytes,
    headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'max-age=31536000', 'x-upsert': 'true' },
  });
  const url = `${API_URL}/storage/v1/object/public/${bucket}/${key}`;
  const path = `/rest/v1/product_images?product_id=eq.${product.id}&position=eq.1&variant_id=is.null`;
  const existing: Array<{ id: string }> = await (await request(`${path}&select=id`)).json();
  if (existing.length > 1) throw new Error(`Ambiguous demonstration image for ${product.slug}`);
  if (existing.length) {
    await request(`/rest/v1/product_images?id=eq.${existing[0].id}`, json('PATCH', { url }));
  } else {
    await request('/rest/v1/product_images', json('POST', {
      product_id: product.id, url, alt: product.name, position: 1,
    }));
  }
}
console.log(`Uploaded ${products.length} demonstration images to local Storage and saved public URLs.`);
