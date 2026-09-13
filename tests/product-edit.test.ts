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

test('原子创建可直接发布完整商品，重复 ID 不覆盖，失败不留下草稿或子资源', async () => {
  const id = crypto.randomUUID(), variant = crypto.randomUUID(), option = crypto.randomUUID(), value = crypto.randomUUID();
  cleanup.defer(() => checked(api(`/rest/v1/products?id=eq.${id}`, { service: true, method: 'DELETE' })));
  const changes = {
    product: { slug: id, name: 'Created together', status: 'active' },
    variants: [{ id: variant, price: 17, track_inventory: false }],
    options: [{ id: option, name: 'Size' }], option_values: [{ id: value, option_id: option, value: 'Small' }],
    variant_options: [{ id: variant, option_value_ids: [value] }],
    metafields: [{ variant_id: variant, namespace: 'custom', key: 'note', type: 'text', value: 'private' }],
  };
  const created = await checked<Catalog>(rpc('create_product', { product_id: id, changes }, admin.token));
  expect(created).toMatchObject({ id, name: 'Created together', status: 'active' });
  expect(created.variants[0]).toMatchObject({ id: variant, price: 17, option_value_ids: [value], metafields: [{ value: 'private' }] });
  expect(await read(id)).toEqual(created);
  expect((await rpc('create_product', { product_id: id, changes: { product: { slug: 'overwrite', name: 'overwrite' } } }, admin.token)).status).toBe(409);
  expect(await read(id)).toEqual(created);
  const failedId = crypto.randomUUID(), failedVariant = crypto.randomUUID();
  const failure = await rpc('create_product', { product_id: failedId, changes: {
    product: { slug: failedId, name: 'rollback' }, variants: [{ id: failedVariant, price: 4 }],
    metafields: [{ namespace: 'custom', key: 'bad', type: 'number', value: 'bad' }],
  } }, admin.token);
  expect(failure.status).toBe(400);
  expect(await read(failedId)).toBeNull();
  expect(await checked<unknown[]>(api(`/rest/v1/product_variants?id=eq.${failedVariant}`, { service: true }))).toEqual([]);
});

test('商品创建默认草稿且拒绝越权、缺少名称/slug、伪造归属和不完整发布', async () => {
  const id = crypto.randomUUID();
  cleanup.defer(() => checked(api(`/rest/v1/products?id=eq.${id}`, { service: true, method: 'DELETE' })));
  for (const token of [undefined, buyer.token]) {
    expect((await rpc('create_product', { product_id: id, changes: { product: { slug: id, name: 'Draft' } } }, token)).data)
      .toMatchObject({ code: '42501' });
  }
  for (const changes of [null, {}, { product: { slug: id } }, { product: { slug: id, name: null } },
    { product: { slug: id, name: 'Incomplete', status: 'active' } }, { product: { slug: id, name: 'Forged', id } }]) {
    expect((await rpc('create_product', { product_id: id, changes }, admin.token)).status).toBe(400);
    expect(await read(id)).toBeNull();
  }
  const draft = await checked<Catalog>(rpc('create_product', { product_id: id, changes: { product: { slug: id, name: 'Draft' } } }, undefined, true));
  expect(draft).toMatchObject({ status: 'draft', variants: [] });
  expect(await checked<unknown>(command('get_storefront_product', { product_id: id }))).toBeNull();
});

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

test('分类与商品/新变体扩展原子保存，省略保留、显式清空及删除，继续过滤公开 DTO', async () => {
  const p = await stockedProduct(admin, { cleanup, trackInventory: false });
  await withRollback(db, async sql => {
    const category = crypto.randomUUID(), variant = crypto.randomUUID();
    await sql`insert into public.categories(id,slug,name,is_active) values (${category}::uuid,${category},'Private category',false)`;
    await sql`insert into public.metafield_definitions(owner_type,namespace,key,name,type,access)
      values ('product',${p.productId},'public','Public text','text','public')`;
    const result = await sqlSave(sql, p.productId, (await read(p.productId)).revision, {
      product: { name: 'Complete edit' }, category_ids: [category],
      variants: [{ id: variant, price: 23, is_active: false }],
      metafields: [
        { namespace: p.productId, key: 'public', type: 'text', value: 'visible' },
        { namespace: p.productId, key: 'private', type: 'json', value: { supplier: 7 } },
        { variant_id: variant, namespace: p.productId, key: 'private', type: 'number', value: 9 },
      ],
    });
    expect(result).toMatchObject({ name: 'Complete edit', categories: [{ id: category }],
      metafields: [{ key: 'private', value: { supplier: 7 } }, { key: 'public', value: 'visible' }] });
    expect(result.variants.find(v => v.id === variant)).toMatchObject({ metafields: [{ value: 9 }] });
    const publicDto = (await sql`select public.get_storefront_product(${p.productId}::uuid) dto`)[0].dto;
    expect(publicDto.categories).toEqual([]);
    expect(publicDto.metafields).toEqual([{ namespace: p.productId, key: 'public', type: 'text', value: 'visible' }]);
    expect(await sqlSave(sql, p.productId, result.revision, { category_ids: [category], metafields: [] })).toEqual(result);
    const updated = await sqlSave(sql, p.productId, result.revision, {
      metafields: [{ namespace: p.productId, key: 'public', type: 'text', value: 'changed' }],
    });
    expect(updated).toMatchObject({ categories: [{ id: category }], metafields: [{ key: 'private' }, { value: 'changed' }] });
    const cleared = await sqlSave(sql, p.productId, updated.revision, { category_ids: [], metafields: [
      { namespace: p.productId, key: 'private', delete: true },
      { variant_id: variant, namespace: p.productId, key: 'private', delete: true },
    ] });
    expect(cleared).toMatchObject({ categories: [], metafields: [{ key: 'public', value: 'changed' }] });
    expect(cleared.variants.find(v => v.id === variant)).toMatchObject({ metafields: [] });
  });
});

test('扩展与分类非法输入或末项校验失败会回滚前面的商品修改', async () => {
  const p = await stockedProduct(admin, { cleanup, trackInventory: false });
  const other = await stockedProduct(admin, { cleanup, trackInventory: false });
  const before = await read(p.productId);
  const field = { namespace: 'custom', key: 'test', type: 'text', value: 'valid' };
  const missingCategory = await save(p.productId, before.revision, {
    product: { name: 'must rollback' }, category_ids: [crypto.randomUUID()],
  });
  expect(missingCategory.status).toBe(409);
  expect(missingCategory.data).toMatchObject({ code: '23503' });
  expect(await read(p.productId)).toEqual(before);
  for (const changes of [
    { category_ids: null }, { category_ids: [null] },
    { category_ids: [p.productId, p.productId.toUpperCase()] },
    { metafields: null }, { metafields: [{ ...field, owner_id: other.productId }] },
    { metafields: [{ ...field, variant_id: other.variantId }] },
    { metafields: [field, { ...field }] }, { metafields: [{ ...field, access: 'public' }] },
    { metafields: [field, { ...field, key: 'bad', type: 'number', value: 'not a number' }] },
    { metafields: [{ ...field, type: 'metaobject_reference', value: crypto.randomUUID() }] },
    { metafields: [{ namespace: 'custom', key: 'missing', delete: true }] },
  ]) {
    const result = await save(p.productId, before.revision, { product: { name: 'must rollback' }, ...changes });
    expect(result.status).toBe(400);
    expect(await read(p.productId)).toEqual(before);
  }
});

test('直接关联/扩展写入推进商品版本；扩展迁移同时使两边旧表单失效', async () => {
  const p = await stockedProduct(admin, { cleanup, trackInventory: false });
  const other = await stockedProduct(admin, { cleanup, trackInventory: false });
  await withRollback(db, async sql => {
    const category = crypto.randomUUID(), field = crypto.randomUUID();
    await sql`insert into public.categories(id,slug,name) values (${category}::uuid,${category},'Category')`;
    let revision = (await read(p.productId)).revision;
    for (const write of [
      () => sql`insert into public.product_categories(product_id,category_id) values (${p.productId}::uuid,${category}::uuid)`,
      () => sql`delete from public.product_categories where product_id=${p.productId}::uuid`,
      () => sql`insert into public.metafields(id,owner_type,owner_id,namespace,key,type,value)
        values (${field}::uuid,'variant',${p.variantId}::uuid,'custom','test','text','"first"')`,
      () => sql`update public.metafields set value='"second"' where id=${field}::uuid`,
      () => sql`update public.metafields set owner_type='product',owner_id=${other.productId}::uuid where id=${field}::uuid`,
    ]) {
      await write();
      const current = (await sql`select revision from public.products where id=${p.productId}::uuid`)[0].revision;
      expect(Number(current)).toBeGreaterThan(revision); revision = Number(current);
    }
    const otherRevision = (await sql`select revision from public.products where id=${other.productId}::uuid`)[0].revision;
    expect(Number(otherRevision)).toBeGreaterThan((await read(other.productId)).revision);
    await sql`delete from public.metafields where id=${field}::uuid`;
    expect(Number((await sql`select revision from public.products where id=${other.productId}::uuid`)[0].revision)).toBeGreaterThan(Number(otherRevision));
  });
});

test('分类/扩展并发保存拒绝旧版本，直接扩展写入也拒绝 RR 旧快照', async () => {
  const p = await stockedProduct(admin, { cleanup, trackInventory: false });
  const [category] = await db`select id from public.categories order by id limit 1`;
  const before = await read(p.productId);
  const winner = { category_ids: [category.id], metafields: [{ namespace: 'custom', key: 'concurrent', type: 'text', value: 'winner' }] };
  const race = await heldTransactionRace(db,
    sql => sqlSave(sql, p.productId, before.revision, winner),
    () => save(p.productId, before.revision, { category_ids: [], metafields: [] }, editor.token));
  expect(race.status).toBe(409);
  const after = await read(p.productId);
  expect(after).toMatchObject({ categories: [{ id: category.id }], metafields: [{ value: 'winner' }] });
  const stale = await staleAfterCommit(db,
    sql => sqlSave(sql, p.productId, after.revision, { category_ids: [] }),
    () => checked(api(`/rest/v1/metafields?owner_id=eq.${p.productId}&key=eq.concurrent`, {
      service: true, method: 'PATCH', body: { value: 'direct' },
    })));
  expect(stale.error).toMatchObject({ errno: '40001' });
  expect((await save(p.productId, after.revision, {})).status).toBe(409);
  expect(await read(p.productId)).toMatchObject({ categories: [{ id: category.id }], metafields: [{ value: 'direct' }] });
});

test('分类关联和 Metafield 子行锁竞争不会留下部分保存', async () => {
  const p = await stockedProduct(admin, { cleanup, trackInventory: false });
  const [category] = await db`select id from public.categories order by id limit 1`;
  const field = { namespace: 'custom', key: 'locked', type: 'text', value: 'before' };
  const before = await checked<Catalog>(save(p.productId, (await read(p.productId)).revision,
    { category_ids: [category.id], metafields: [field] }));
  for (const table of ['product_categories','metafields']) {
    await withRollback(db, async sql => {
      if (table === 'product_categories') await sql`select * from public.product_categories where product_id=${p.productId}::uuid for update`;
      else await sql`select * from public.metafields where owner_id=${p.productId}::uuid for update`;
      const result = await save(p.productId, before.revision, { product: { name: 'must rollback' }, category_ids: [],
        metafields: [{ ...field, value: 'after' }] });
      expect(result.data).toMatchObject({ code: '55P03' });
      expect(await read(p.productId)).toEqual(before);
    });
  }
});

test('REPEATABLE READ 的旧快照不能绕过已提交的目录编辑', async () => {
  const p = await stockedProduct(admin, { cleanup, trackInventory: false }), before = await read(p.productId);
  const result = await staleAfterCommit(db,
    sql => sqlSave(sql, p.productId, before.revision, { product: { name: 'stale' } }),
    () => checked(save(p.productId, before.revision, { variants: [{ id: p.variantId, price: 28 }] })));
  expect(result.error).toMatchObject({ errno: '40001' });
  expect((await read(p.productId)).variants[0].price).toBe(28);
});
