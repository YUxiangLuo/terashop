import { afterAll, beforeAll, expect, test } from 'bun:test';
import { testDatabase, heldTransactionRace } from './database-concurrency';
import { withRollback } from '../scripts/lib/transactions';
import { signup, makeAdmin, type TestUser } from './helpers';

const db = testDatabase();
let admin: TestUser;
beforeAll(async () => {
  admin = await signup();
  await makeAdmin(admin.userId);
});
afterAll(() => db.close());

test('catalog commands and direct writes maintain exact URL edges atomically without changing DTOs', async () => {
  await withRollback(db, async (sql) => {
    const product = crypto.randomUUID(),
      image = crypto.randomUUID(),
      other = crypto.randomUUID();
    const category = crypto.randomUUID();
    const url = `https://shop.example/storage/v1/object/public/catalog-media/products/${product}/${image}.png`;
    const external = url.replace('shop.example', 'external.example') + '?size=200#view';
    await sql`select set_config('request.jwt.claims',${JSON.stringify({ role: 'authenticated', sub: admin.userId })},true)`;
    await sql`set local role authenticated`;
    const created = (
      await sql`select public.create_product(${product}::uuid,
      ${JSON.stringify({
        product: { name: 'Media refs', slug: product },
        images: [
          { id: image, url },
          { id: other, url },
        ],
      })}::text::jsonb) dto`
    )[0].dto;
    expect(created.images).toHaveLength(2);
    expect(created.images[0]).not.toHaveProperty('media_reference_id');
    await sql`select public.create_category(${category}::uuid,
      ${JSON.stringify({ name: 'Media category', slug: category, image_url: url })}::text::jsonb)`;
    await sql`reset role`;
    expect(
      (await sql`select count(*)::int n from private.catalog_media_url_refs where url=${url}`)[0].n,
    ).toBe(3);
    await sql`set local role authenticated`;
    await sql`select public.update_product(${product}::uuid,${created.revision}::bigint,
      ${JSON.stringify({
        images: [
          { id: image, url: external },
          { id: other, delete: true },
        ],
      })}::text::jsonb)`;
    // Legacy direct-table updates are covered too, with no canonicalization or URL fetching.
    await sql`update public.categories set image_url='' where id=${category}::uuid`;
    await sql`reset role`;
    expect(
      await sql<{ url: string }[]>`select url from private.catalog_media_url_refs where product_image_id=${image}::uuid`,
    ).toEqual([{ url: external }]);
    expect(
      await sql`select url from private.catalog_media_url_refs where product_image_id=${other}::uuid`,
    ).toHaveLength(0);
    expect(
      await sql<{ url: string }[]>`select url from private.catalog_media_url_refs where category_id=${category}::uuid`,
    ).toEqual([{ url: '' }]);
    await sql`set local role authenticated`;
    await sql`update public.categories set image_url=null where id=${category}::uuid`;
    await sql`reset role`;
    expect(
      await sql`select url from private.catalog_media_url_refs where category_id=${category}::uuid`,
    ).toHaveLength(0);
    // A failed transaction must restore the old edge as well as the source URL.
    await expect(
      sql.savepoint(async (tx) => {
        await tx`update public.product_images set url='https://rollback.example/image.png' where id=${image}::uuid`;
        expect(
          await tx<{ url: string }[]>`select url from private.catalog_media_url_refs where product_image_id=${image}::uuid`,
        ).toEqual([{ url: 'https://rollback.example/image.png' }]);
        throw new Error('rollback edge');
      }),
    ).rejects.toThrow('rollback edge');
    expect(
      await sql<{ url: string }[]>`select url from private.catalog_media_url_refs where product_image_id=${image}::uuid`,
    ).toEqual([{ url: external }]);
    await sql`update public.categories set image_url=${url} where id=${category}::uuid`;
    await sql`delete from public.categories where id=${category}::uuid`;
    await sql`delete from public.products where id=${product}::uuid`;
    expect(
      await sql`select * from private.catalog_media_url_refs where product_image_id in (${image}::uuid,${other}::uuid) or category_id=${category}::uuid`,
    ).toHaveLength(0);
  });
});

test('media edge registry and trigger are not client/service writable or directly callable', async () => {
  for (const role of ['anon', 'authenticated', 'service_role']) {
    const [permissions] = await db`select
      has_table_privilege(${role},'private.catalog_media_url_refs','SELECT') as readable,
      has_table_privilege(${role},'private.catalog_media_url_refs','INSERT') as insertable,
      has_table_privilege(${role},'private.catalog_media_url_refs','UPDATE') as updatable,
      has_table_privilege(${role},'private.catalog_media_url_refs','DELETE') as deletable,
      has_function_privilege(${role},'private.sync_catalog_media_url_ref()','EXECUTE') as callable`;
    expect(permissions).toEqual({
      readable: false,
      insertable: false,
      updatable: false,
      deletable: false,
      callable: false,
    });
  }
});

test('source-row update/delete competition cannot leave a stale media edge', async () => {
  const product = crypto.randomUUID(),
    image = crypto.randomUUID();
  try {
    await db`insert into public.products(id,slug,name,status) values (${product}::uuid,${product},'Media race','draft')`;
    await db`insert into public.product_images(id,product_id,url) values (${image}::uuid,${product}::uuid,'https://before.example/a.png')`;
    await heldTransactionRace(
      db,
      async (sql) => {
        await sql`select id from public.product_images where id=${image}::uuid for update`;
      },
      () => db`delete from public.product_images where id=${image}::uuid returning id`.execute(),
      async (sql) => {
        await sql`update public.product_images set url='https://after.example/b.png' where id=${image}::uuid`;
        expect(
          await sql<{ url: string }[]>`select url from private.catalog_media_url_refs where product_image_id=${image}::uuid`,
        ).toEqual([{ url: 'https://after.example/b.png' }]);
      },
    );
    expect(
      await db`select * from private.catalog_media_url_refs where product_image_id=${image}::uuid`,
    ).toHaveLength(0);
  } finally {
    await db`delete from public.products where id=${product}::uuid`;
  }
});
