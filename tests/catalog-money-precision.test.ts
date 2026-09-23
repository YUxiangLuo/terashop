import { afterAll, expect, test } from 'bun:test';
import { api, checked, rpc } from './helpers';

interface Product {
  id: string;
  revision: number;
  name: string;
  variants: Array<{ id: string; price: number; compare_at_price: number | null; cost: number | null }>;
}

const productIds: string[] = [];
const read = (id: string) => checked<Product>(rpc('get_admin_product', { product_id: id }, undefined, true));

afterAll(async () => {
  for (const id of productIds)
    await checked(api(`/rest/v1/products?id=eq.${id}`, { service: true, method: 'DELETE' }));
});

test('catalog RPC rejects fractional cents on create without leaving rounded rows', async () => {
  for (const field of ['price', 'compare_at_price', 'cost'] as const) {
    const productId = crypto.randomUUID(),
      variantId = crypto.randomUUID();
    const variant = { id: variantId, price: 1, [field]: 1.005 };
    const result = await rpc(
      'create_product',
      {
        product_id: productId,
        changes: {
          product: { slug: productId, name: `precision-${field}` },
          variants: [variant],
        },
      },
      undefined,
      true,
    );
    expect(result.status).toBe(400);
    expect(await read(productId)).toBeNull();
  }
});

test('catalog RPC rejects fractional cents on update and rolls back product and revision', async () => {
  const productId = crypto.randomUUID(),
    variantId = crypto.randomUUID();
  productIds.push(productId);
  const created = await checked<Product>(
    rpc(
      'create_product',
      {
        product_id: productId,
        changes: {
          product: { slug: productId, name: 'precision-update' },
          variants: [{ id: variantId, price: 1, compare_at_price: 2, cost: 0.5 }],
        },
      },
      undefined,
      true,
    ),
  );

  for (const field of ['price', 'compare_at_price', 'cost'] as const) {
    const result = await rpc(
      'update_product',
      {
        product_id: productId,
        expected_revision: created.revision,
        changes: { product: { name: 'must rollback' }, variants: [{ id: variantId, [field]: 1.005 }] },
      },
      undefined,
      true,
    );
    expect(result.status).toBe(400);
    expect(await read(productId)).toEqual(created);
  }
});

test('catalog money accepts nullable optional amounts and exact boundaries', async () => {
  const productId = crypto.randomUUID(),
    variantId = crypto.randomUUID();
  productIds.push(productId);
  const created = await checked<Product>(
    rpc(
      'create_product',
      {
        product_id: productId,
        changes: {
          product: { slug: productId, name: 'money-boundaries' },
          variants: [{ id: variantId, price: 0.01, compare_at_price: null, cost: null }],
        },
      },
      undefined,
      true,
    ),
  );
  expect(created.variants[0]).toMatchObject({ price: 0.01, compare_at_price: null, cost: null });

  const updated = await checked<Product>(
    rpc(
      'update_product',
      {
        product_id: productId,
        expected_revision: created.revision,
        changes: {
          variants: [
            { id: variantId, price: '9999999999.99', compare_at_price: 9999999999.99, cost: '9999999999.99' },
          ],
        },
      },
      undefined,
      true,
    ),
  );
  expect(updated.revision).toBe(created.revision + 1);
  expect(updated.variants[0]).toMatchObject({
    price: 9999999999.99,
    compare_at_price: 9999999999.99,
    cost: 9999999999.99,
  });

  for (const changes of [
    { variants: [{ id: variantId, price: null }] },
    { variants: [{ id: variantId, price: '1.005' }] },
    { variants: [{ id: variantId, compare_at_price: '1.005' }] },
    { variants: [{ id: variantId, cost: 'NaN' }] },
    { variants: [{ id: variantId, cost: 'invalid' }] },
    { variants: [{ id: variantId, cost: -0.01 }] },
    { variants: [{ id: variantId, price: 10000000000 }] },
  ]) {
    const result = await rpc(
      'update_product',
      {
        product_id: productId,
        expected_revision: updated.revision,
        changes,
      },
      undefined,
      true,
    );
    expect(result.status).toBe(400);
    expect(await read(productId)).toEqual(updated);
  }
});
