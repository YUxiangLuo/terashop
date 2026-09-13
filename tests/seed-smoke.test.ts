import { expect, test } from 'bun:test';
import { API, ANON_KEY, api, checked, signup } from './helpers';

test("default seed is a complete women's fashion catalog", async () => {
  const products = await checked<Array<{ id: string; product_type: string }>>(api(
    '/rest/v1/products?vendor=eq.Atelier%20Tera&status=eq.active&select=id,product_type', { service: true },
  ));
  expect(products).toHaveLength(10);
  expect(new Set(products.map(product => product.product_type))).toEqual(
    new Set(['Dresses', 'Tops', 'Knitwear', 'Skirts', 'Trousers']),
  );
  const categories = await checked<Array<{ id: string; slug: string; parent_id: string | null }>>(api(
    '/rest/v1/categories?slug=in.(womens-fashion,dresses,tops,knitwear,skirts,trousers)&select=id,slug,parent_id',
    { service: true },
  ));
  expect(categories).toHaveLength(6);
  const parent = categories.find(category => category.slug === 'womens-fashion')!;
  expect(categories.filter(category => category.slug !== 'womens-fashion').map(category => category.parent_id))
    .toEqual(Array(5).fill(parent.id));
  const ids = products.map(product => product.id).join(',');
  const categoryLinks = await checked<Array<{ product_id: string; category_id: string }>>(api(
    `/rest/v1/product_categories?product_id=in.(${ids})&select=product_id,category_id`, { service: true },
  ));
  expect(categoryLinks).toHaveLength(20);
  for (const product of products) {
    const linked = categoryLinks.filter(link => link.product_id === product.id).map(link => link.category_id);
    expect(linked).toContain(parent.id);
    expect(linked).toContain(categories.find(category => category.slug === product.product_type.toLowerCase())!.id);
  }
  const images = await checked<Array<{ url: string }>>(api(
    `/rest/v1/product_images?product_id=in.(${ids})&select=url`, { service: true },
  ));
  expect(images).toHaveLength(10);
  for (const image of images) {
    const url = new URL(image.url);
    expect(url.origin).toBe(new URL(API).origin);
    expect(url.pathname).toMatch(/^\/storage\/v1\/object\/public\/catalog-media\/[a-z0-9-]+\/[a-f0-9]{64}\.webp$/);
    const slug = url.pathname.split('/').at(-2)!;
    const response = await fetch(image.url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('image/webp');
    expect(response.headers.get('cache-control')).toContain('max-age=31536000');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes).toEqual(await Bun.file(`supabase/seed-assets/${slug}.webp`).bytes());
    expect(url.pathname.endsWith(`${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}.webp`)).toBe(true);
  }
  const variants = await checked<Array<{ id: string }>>(api(
    `/rest/v1/product_variants?product_id=in.(${ids})&select=id`, { service: true },
  ));
  const stock = await checked<Array<{ on_hand: number }>>(api(
    `/rest/v1/inventory_levels?variant_id=in.(${variants.map(variant => variant.id).join(',')})&select=on_hand`,
    { service: true },
  ));
  expect(stock.some(level => level.on_hand === 0)).toBe(true);
  expect(stock.some(level => level.on_hand > 0)).toBe(true);
});

test('public catalog Storage does not grant anonymous or customer writes', async () => {
  const { token } = await signup();
  const images = await checked<Array<{ url: string }>>(api('/rest/v1/product_images?url=like.*%2Fcatalog-media%2F*&select=url&limit=1', { service: true }));
  const key = new URL(images[0].url).pathname.split('/catalog-media/')[1];
  const bytes = await Bun.file('supabase/seed-assets/linen-wrap-dress.webp').bytes();
  for (const credential of [ANON_KEY, token]) {
    for (const [method, path] of [
      ['POST', `catalog-media/forbidden-${crypto.randomUUID()}.webp`],
      ['PUT', `catalog-media/${key}`],
    ]) {
      const response = await fetch(`${API}/storage/v1/object/${path}`, {
        method, headers: { apikey: ANON_KEY, Authorization: `Bearer ${credential}`, 'Content-Type': 'image/webp' },
        body: bytes,
      });
      expect(response.ok).toBe(false);
      expect(JSON.stringify(await response.json())).toMatch(/row.level security|unauthorized/i);
    }
    // Storage may report a successful empty deletion when RLS hides the row.
    await fetch(`${API}/storage/v1/object/catalog-media`, {
      method: 'DELETE', headers: { apikey: ANON_KEY, Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: [key] }),
    });
    const download = await fetch(images[0].url, { cache: 'no-store' });
    expect(download.status).toBe(200);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(
      await Bun.file(`supabase/seed-assets/${key.split('/')[0]}.webp`).bytes(),
    );
  }
});
