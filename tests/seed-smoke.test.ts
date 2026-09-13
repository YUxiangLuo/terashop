import { expect, test } from 'bun:test';
import { api, checked } from './helpers';

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
    expect(image.url).toMatch(/^\/images\/[a-z0-9-]+\.webp$/);
    expect(await Bun.file(`storefront/static${image.url}`).exists()).toBe(true);
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
