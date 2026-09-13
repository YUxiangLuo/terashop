import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import type { TransactionSQL } from 'bun';
import { withRollback } from '../scripts/lib/transactions';
import { heldTransactionRace, staleAfterCommit, testDatabase } from './database-concurrency';
import { api, checked, command, makeAdmin, rpc, signup, type TestUser } from './helpers';
import { stockedProduct } from './support/catalog';
import { Cleanup } from './support/cleanup';

const db = testDatabase(), cleanup = new Cleanup();
let admin: TestUser, editor: TestUser, buyer: TestUser;
beforeAll(async () => {
  [admin, editor, buyer] = await Promise.all([signup(), signup(), signup()]);
  await makeAdmin(admin.userId); await makeAdmin(editor.userId);
});
afterEach(() => cleanup.run());
afterAll(() => db.close());
interface Catalog {
  id: string; revision: number; name: string; status: string; description: string;
  variants: { id: string; price: number; cost: number | null; option_value_ids: string[] }[];
  options: { id: string; name: string; values: { id: string; value: string }[] }[];
  images: { id: string; url: string; alt: string }[];
}
const read = (id: string) => checked<Catalog>(command('get_admin_product', { product_id: id }, admin.token));
const save = (id: string, revision: number, changes: unknown, token = admin.token) =>
  rpc('update_product', { product_id: id, expected_revision: revision, changes }, token);
async function sqlSave(sql: TransactionSQL, id: string, revision: number, changes: unknown) {
  await sql`select set_config('request.jwt.claims',${JSON.stringify({ sub: admin.userId, role: 'authenticated' })},true)`;
  await sql`set local role authenticated`;
  return (await sql.unsafe('select public.update_product($1::uuid,$2::bigint,$3::text::jsonb) dto',
    [id, revision, JSON.stringify(changes)]))[0].dto as Catalog;
}

test('原子编辑在售商品、规格、变体和图片，保留省略字段并返回最新版本', async () => {
  const p = await stockedProduct(admin, { cleanup, trackInventory: false });
  const before = await read(p.productId);
  const option = crypto.randomUUID(), value = crypto.randomUUID(), image = crypto.randomUUID();
  const result = await checked<Catalog>(save(p.productId, before.revision, {
    product: { name: 'Edited live product', seo_title: 'SEO title' },
    options: [{ id: option, name: 'Size' }],
    option_values: [{ id: value, option_id: option, value: 'Medium' }],
    variants: [{ id: p.variantId, price: 19.75, cost: 3.5 }],
    variant_options: [{ id: p.variantId, option_value_ids: [value] }],
    images: [{ id: image, variant_id: p.variantId, url: 'https://example.invalid/new.png' }],
  }));
  expect(result).toMatchObject({ name: 'Edited live product', status: 'active', description: before.description });
  expect(result.revision).toBeGreaterThan(before.revision);
  expect(result.variants[0]).toMatchObject({ id: p.variantId, price: 19.75, cost: 3.5, option_value_ids: [value] });
  expect(result.options[0]).toMatchObject({ id: option, name: 'Size', values: [{ id: value, value: 'Medium', position: 0 }] });
  expect(result.images[0]).toMatchObject({ id: image, alt: '' });
  expect(await read(p.productId)).toEqual(result);
  expect((await save(p.productId, before.revision, { product: { name: 'stale' } })).status).toBe(409);
  const deleted = await checked<Catalog>(save(p.productId, result.revision, {
    options: [{ id: option, delete: true }], images: [{ id: image, delete: true }],
    variants: [{ id: p.variantId, cost: null }],
  }));
  expect(deleted.options).toEqual([]); expect(deleted.images).toEqual([]);
  expect(deleted.variants[0]).toMatchObject({ cost: null, option_value_ids: [] });
});

test('后段失败或最终发布校验失败会回滚全部编辑和版本；拒绝跨商品修改/删除', async () => {
  const p = await stockedProduct(admin, { cleanup, trackInventory: false });
  const foreign = await stockedProduct(admin, { cleanup, trackInventory: false });
  const before = await read(p.productId), other = await read(foreign.productId);
  for (const changes of [
    { product: { name: 'must rollback' }, variants: [{ id: p.variantId, price: -1 }] },
    { product: { name: 'must rollback' }, options: [{ id: crypto.randomUUID(), name: 'Incomplete' }] },
    { product: { name: 'must rollback' }, variants: [{ id: foreign.variantId, price: 20 }] },
    { variants: [{ id: foreign.variantId, delete: true }] },
    { images: [{ id: crypto.randomUUID(), variant_id: foreign.variantId, url: 'https://example.invalid/cross.png' }] },
    { variants: [{ id: p.variantId, delete: true }] },
  ]) {
    const result = await save(p.productId, before.revision, changes);
    expect(result.status).toBe(400);
    expect(await read(p.productId)).toEqual(before);
    expect(await read(foreign.productId)).toEqual(other);
  }
});

test('拒绝越权、伪造版本/库存/归属及未知字段，空 changes 是无写入读取', async () => {
  const p = await stockedProduct(admin, { cleanup, trackInventory: false }), before = await read(p.productId);
  for (const token of [undefined, buyer.token]) {
    const result = await rpc('update_product', { product_id: p.productId, expected_revision: before.revision, changes: {} }, token);
    expect([401, 403]).toContain(result.status);
  }
  for (const changes of [null, [], { product: null }, { revision: 1 }, { product: { revision: 1 } },
    { variants: [{ id: p.variantId, on_hand: 9 }] }, { variants: [{ id: p.variantId, product_id: p.productId }] },
    { variants: [{ id: p.variantId, delete: 'true' }] }, { variants: [{ id: p.variantId }, { id: p.variantId.toUpperCase() }] },
    { images: [{ id: crypto.randomUUID(), delete: true, url: 'x' }] }, { product: { name: 'x'.repeat(262144) } }]) {
    expect((await save(p.productId, before.revision, changes)).status).toBe(400);
    expect(await read(p.productId)).toEqual(before);
  }
  expect(await checked<Catalog>(save(p.productId, before.revision, {}))).toEqual(before);
  await expect(withRollback(db, async sql => {
    await sql`update public.products set revision=revision+100 where id=${p.productId}::uuid`;
  })).rejects.toThrow('assigned by the database');
});

test('旧直接写表路径的商品字段、变体价格和 SKU 写入也使旧表单失效', async () => {
  const p = await stockedProduct(admin, { cleanup, trackInventory: false });
  for (const [path, body] of [
    [`products?id=eq.${p.productId}`, { description: 'direct change' }],
    [`product_variants?id=eq.${p.variantId}`, { price: 21 }],
    [`product_variants?id=eq.${p.variantId}`, { sku: `EDIT-${crypto.randomUUID()}` }],
  ] as const) {
    const before = await read(p.productId);
    await checked(api(`/rest/v1/${path}`, { service: true, method: 'PATCH', body }));
    const changed = await read(p.productId);
    expect(changed.revision).toBeGreaterThan(before.revision);
    expect((await save(p.productId, before.revision, { product: { name: 'stale' } })).status).toBe(409);
    expect(await read(p.productId)).toEqual(changed);
  }
});

test('在售商品可新增变体并原子互换规格；直接规格与图片编辑使版本失效', async () => {
  const p = await stockedProduct(admin, { cleanup, trackInventory: false });
  const option = crypto.randomUUID(), small = crypto.randomUUID(), large = crypto.randomUUID();
  const variant = crypto.randomUUID(), image = crypto.randomUUID();
  const created = await checked<Catalog>(save(p.productId, (await read(p.productId)).revision, {
    options: [{ id: option, name: 'Size' }],
    option_values: [{ id: small, option_id: option, value: 'Small' }, { id: large, option_id: option, value: 'Large' }],
    variants: [{ id: variant, sku: `NEW-${variant}`, price: 17, track_inventory: false }],
    variant_options: [{ id: p.variantId, option_value_ids: [small] }, { id: variant, option_value_ids: [large] }],
    images: [{ id: image, url: 'https://example.invalid/test.png' }],
  }));
  const swapped = await checked<Catalog>(save(p.productId, created.revision, {
    variant_options: [{ id: p.variantId, option_value_ids: [large] }, { id: variant, option_value_ids: [small] }],
  }));
  expect(swapped.variants.find(v => v.id === p.variantId)?.option_value_ids).toEqual([large]);
  expect(swapped.variants.find(v => v.id === variant)).toMatchObject({ price: 17, option_value_ids: [small] });
  for (const [path, body] of [
    [`product_options?id=eq.${option}`, { name: 'Fit' }],
    [`product_option_values?id=eq.${small}`, { value: 'Slim' }],
    [`product_images?id=eq.${image}`, { alt: 'Updated image' }],
  ] as const) {
    const before = await read(p.productId);
    await checked(api(`/rest/v1/${path}`, { service: true, method: 'PATCH', body }));
    expect((await read(p.productId)).revision).toBeGreaterThan(before.revision);
    expect((await save(p.productId, before.revision, {})).status).toBe(409);
  }
  const foreign = await stockedProduct(admin, { cleanup, trackInventory: false });
  for (const changes of [
    { option_values: [{ id: crypto.randomUUID(), option_id: option, value: 'Foreign' }] },
    { variant_options: [{ id: foreign.variantId, option_value_ids: [small] }] },
    { variant_options: [{ id: p.variantId, option_value_ids: [] }] },
  ]) {
    const before = await read(foreign.productId);
    expect((await save(foreign.productId, before.revision, changes)).status).toBe(400);
    expect(await read(foreign.productId)).toEqual(before);
  }
});

test('两个管理员保存同一版本仅先提交者成功，提交前 Storefront 继续读取旧完整版本', async () => {
  const p = await stockedProduct(admin, { cleanup, trackInventory: false }), before = await read(p.productId);
  const result = await heldTransactionRace(db, async sql => {
    await sqlSave(sql, p.productId, before.revision, { product: { name: 'winner' }, variants: [{ id: p.variantId, price: 25 }] });
    const publicBefore = await checked<Catalog>(command('get_storefront_product', { product_id: p.productId }));
    expect(publicBefore.name).toBe(before.name); expect(publicBefore.variants[0].price).toBe(10);
  }, () => save(p.productId, before.revision, { product: { name: 'loser' } }, editor.token));
  expect(result.status).toBe(409);
  const after = await read(p.productId);
  expect(after.name).toBe('winner'); expect(after.variants[0].price).toBe(25);
});

test('子行被其他事务锁定时保存快速失败并回滚，不反向等待造成死锁', async () => {
  const p = await stockedProduct(admin, { cleanup, trackInventory: false }), before = await read(p.productId);
  await withRollback(db, async sql => {
    await sql`select id from public.product_variants where id=${p.variantId}::uuid for no key update`;
    const result = await save(p.productId, before.revision, {
      product: { name: 'must rollback' }, variants: [{ id: p.variantId, price: 31 }],
    });
    expect(result.data).toMatchObject({ code: '55P03' });
    expect(await read(p.productId)).toEqual(before);
  });
});

test('REPEATABLE READ 的旧快照不能绕过已提交的目录编辑', async () => {
  const p = await stockedProduct(admin, { cleanup, trackInventory: false }), before = await read(p.productId);
  const result = await staleAfterCommit(db,
    sql => sqlSave(sql, p.productId, before.revision, { product: { name: 'stale' } }),
    () => checked(save(p.productId, before.revision, { variants: [{ id: p.variantId, price: 28 }] })));
  expect(result.error).toMatchObject({ errno: '40001' });
  expect((await read(p.productId)).variants[0].price).toBe(28);
});
