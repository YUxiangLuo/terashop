import { afterAll, expect, test } from 'bun:test';
import type { TransactionSQL } from 'bun';
import { withRollback } from '../scripts/lib/transactions';
import { staleAfterCommit, testDatabase } from './database-concurrency';
import { api } from './helpers';

const database = testDatabase();
afterAll(() => database.close());

async function fixture(sql: TransactionSQL) {
  const ids = Array.from({ length: 13 }, () => crypto.randomUUID());
  const [p, q, a, b, c, color, size, other, red, blue, medium, foreign, green] = ids;
  await sql`insert into public.products(id,slug,name) values (${p}::uuid,${p},'catalog A'),(${q}::uuid,${q},'catalog B')`;
  await sql`insert into public.product_variants(id,product_id,sku,price) values
    (${a}::uuid,${p}::uuid,${a},10),(${b}::uuid,${p}::uuid,${b},10),(${c}::uuid,${q}::uuid,${c},10)`;
  await sql`insert into public.product_options(id,product_id,name) values
    (${color}::uuid,${p}::uuid,'Color'),(${size}::uuid,${p}::uuid,'Size'),(${other}::uuid,${q}::uuid,'Other')`;
  await sql`insert into public.product_option_values(id,option_id,value) values
    (${red}::uuid,${color}::uuid,'Red'),(${blue}::uuid,${color}::uuid,'Blue'),(${green}::uuid,${color}::uuid,'Green'),
    (${medium}::uuid,${size}::uuid,'M'),(${foreign}::uuid,${other}::uuid,'Foreign')`;
  await sql`insert into public.variant_option_values(variant_id,option_value_id) values
    (${a}::uuid,${red}::uuid),(${a}::uuid,${medium}::uuid),(${b}::uuid,${blue}::uuid),(${b}::uuid,${medium}::uuid),(${c}::uuid,${foreign}::uuid)`;
  return { p, q, a, b, c, color, size, other, red, blue, medium, foreign, green };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

for (const [name, message, mutate] of [
  ['跨商品选项', 'same product', (s: TransactionSQL, f: Fixture) => s`insert into public.variant_option_values values (${f.a}::uuid,${f.foreign}::uuid)`],
  ['同规格多值', 'only one value', (s: TransactionSQL, f: Fixture) => s`insert into public.variant_option_values values (${f.a}::uuid,${f.blue}::uuid)`],
  ['图片跨商品变体', 'same product', (s: TransactionSQL, f: Fixture) => s`insert into public.product_images(product_id,variant_id,url) values (${f.p}::uuid,${f.c}::uuid,'https://example.invalid/a.png')`],
  ['变体迁移商品', 'ownership are immutable', (s: TransactionSQL, f: Fixture) => s`update public.product_variants set product_id=${f.q}::uuid where id=${f.a}::uuid`],
  ['选项迁移商品', 'ownership are immutable', (s: TransactionSQL, f: Fixture) => s`update public.product_options set product_id=${f.q}::uuid where id=${f.color}::uuid`],
  ['选项值迁移规格', 'ownership are immutable', (s: TransactionSQL, f: Fixture) => s`update public.product_option_values set option_id=${f.other}::uuid where id=${f.red}::uuid`],
  ['关联迁移变体', 'ownership are immutable', (s: TransactionSQL, f: Fixture) => s`update public.variant_option_values set variant_id=${f.c}::uuid where variant_id=${f.a}::uuid and option_value_id=${f.red}::uuid`],
] as const) {
  test(`目录直接 SQL 写入拒绝${name}，包括草稿`, async () => {
    await expect(withRollback(database, async sql => {
      const f = await fixture(sql);
      await mutate(sql, f);
      await sql`set constraints all immediate`;
    })).rejects.toThrow(message);
  });
}

for (const [name, message, mutate] of [
  ['缺少规格', 'every option', (s: TransactionSQL, f: Fixture) => s`delete from public.variant_option_values where variant_id=${f.a}::uuid and option_value_id=${f.medium}::uuid`],
  ['重复完整组合', 'unique option combinations', (s: TransactionSQL, f: Fixture) => s`update public.variant_option_values set option_value_id=${f.red}::uuid where variant_id=${f.b}::uuid and option_value_id=${f.blue}::uuid`],
  ['多个默认变体', 'unique option combinations', (s: TransactionSQL, f: Fixture) => s`delete from public.product_options where product_id=${f.p}::uuid`],
  ['没有变体', 'requires a variant', (s: TransactionSQL, f: Fixture) => s`delete from public.product_variants where product_id=${f.p}::uuid`],
] as const) {
  test(`发布拒绝${name}，草稿允许分步构建`, async () => {
    await expect(withRollback(database, async sql => {
      const f = await fixture(sql);
      await mutate(sql, f);
      await sql`set constraints all immediate`; // draft is valid
      await sql`update public.products set status='active' where id=${f.p}::uuid`;
    })).rejects.toThrow(message);
  });
}

test('完整目录允许发布、原子互换规格；停用重复变体可保存，但不可重新启用', async () => {
  await withRollback(database, async sql => {
    const f = await fixture(sql);
    await sql`update public.products set status='active' where id in (${f.p}::uuid,${f.q}::uuid)`;
    await sql`set constraints all immediate`;
    await sql`set constraints all deferred`;
    await sql`update public.variant_option_values set option_value_id=${f.blue}::uuid where variant_id=${f.a}::uuid and option_value_id=${f.red}::uuid`;
    await sql`update public.variant_option_values set option_value_id=${f.red}::uuid where variant_id=${f.b}::uuid and option_value_id=${f.blue}::uuid`;
    await sql`set constraints all immediate`;
    const [row] = await sql`select count(*)::int n from public.variant_option_values where variant_id in (${f.a}::uuid,${f.b}::uuid)`;
    expect(row.n).toBe(4);
  });
  await expect(withRollback(database, async sql => {
    const f = await fixture(sql);
    await sql`update public.variant_option_values set option_value_id=${f.red}::uuid where variant_id=${f.b}::uuid and option_value_id=${f.blue}::uuid`;
    await sql`update public.product_variants set is_active=false where id=${f.b}::uuid`;
    await sql`update public.products set status='active' where id=${f.p}::uuid`;
    await sql`set constraints all immediate`;
    await sql`update public.product_variants set is_active=true where id=${f.b}::uuid`;
  })).rejects.toThrow('unique option combinations');
});

test('分类拒绝三节点环，并允许事务内先断开再重挂', async () => {
  const ids = Array.from({ length: 3 }, () => crypto.randomUUID());
  await expect(withRollback(database, async sql => {
    for (const id of ids) await sql`insert into public.categories(id,slug,name) values (${id}::uuid,${id},'tree')`;
    await sql`update public.categories set parent_id=${ids[1]}::uuid where id=${ids[0]}::uuid`;
    await sql`update public.categories set parent_id=${ids[2]}::uuid where id=${ids[1]}::uuid`;
    await sql`update public.categories set parent_id=${ids[0]}::uuid where id=${ids[2]}::uuid`;
    await sql`set constraints all immediate`;
  })).rejects.toThrow('cannot contain a cycle');
  await withRollback(database, async sql => {
    for (const id of ids) await sql`insert into public.categories(id,slug,name) values (${id}::uuid,${id},'tree')`;
    await sql`update public.categories set parent_id=${ids[1]}::uuid where id=${ids[0]}::uuid`;
    await sql`set constraints all immediate`;
    await sql`update public.categories set parent_id=null where id=${ids[0]}::uuid`;
    await sql`update public.categories set parent_id=${ids[0]}::uuid where id=${ids[1]}::uuid`;
    const [row] = await sql`select parent_id from public.categories where id=${ids[1]}::uuid`;
    expect(row.parent_id).toBe(ids[0]);
  });
});

// Acknowledged transaction barriers: no sleeps, test triggers or disabled constraints.
for (const publish of [false, true]) {
  test(`并发${publish ? '发布/修改' : '规格修改'}不会留下重复组合，冲突可重试`, async () => {
    const f = await database.begin(fixture);
    if (!publish) await database`update public.products set status='active' where id=${f.p}::uuid`;
    const ready = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holding = database.begin(async sql => {
      if (publish) await sql`update public.products set status='active' where id=${f.p}::uuid`;
      else await sql`update public.variant_option_values set option_value_id=${f.green}::uuid where variant_id=${f.a}::uuid and option_value_id=${f.red}::uuid`;
      ready.resolve(); await release.promise;
    });
    holding.catch(ready.reject);
    const value = publish ? f.red : f.green;
    try {
      await ready.promise;
      await expect(Promise.resolve(database`update public.variant_option_values set option_value_id=${value}::uuid where variant_id=${f.b}::uuid and option_value_id=${f.blue}::uuid`)).rejects.toMatchObject({ errno: '55P03' });
      // Unrelated products are not serialized by the product guard.
      await database`update public.product_option_values set value='Other' where id=${f.foreign}::uuid`;
      release.resolve(); await holding;
      await expect(Promise.resolve(database`update public.variant_option_values set option_value_id=${value}::uuid where variant_id=${f.b}::uuid and option_value_id=${f.blue}::uuid`)).rejects.toThrow('unique option combinations');
    } finally {
      release.resolve(); await holding;
      await database`delete from public.products where id in (${f.p}::uuid,${f.q}::uuid)`;
    }
  });
}

test('未提交的父变体不能让规格关联跳过商品结构锁后再等待外键', async () => {
  const f = await database.begin(fixture); const variant = crypto.randomUUID();
  await database`update public.products set status='active' where id=${f.p}::uuid`;
  const ready = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  const holding = database.begin(async sql => {
    await sql`insert into public.product_variants(id,product_id,price,is_active) values (${variant}::uuid,${f.p}::uuid,10,false)`;
    ready.resolve(); await release.promise;
  });
  holding.catch(ready.reject);
  try {
    await ready.promise;
    await expect(database.begin(async sql => {
      await sql`set local statement_timeout='1s'`;
      await sql`insert into public.variant_option_values values (${variant}::uuid,${f.red}::uuid)`;
    })).rejects.toMatchObject({ errno: '23503' });
    release.resolve(); await holding;
    await database`insert into public.variant_option_values values (${variant}::uuid,${f.red}::uuid)`;
    await expect(Promise.resolve(database`insert into public.variant_option_values values (${variant}::uuid,${f.blue}::uuid)`)).rejects.toThrow('only one value');
  } finally {
    release.resolve(); await holding;
    await database`delete from public.products where id in (${f.p}::uuid,${f.q}::uuid)`;
  }
});

test('分类并发反向挂载失败后重试仍拒绝环，内部同步表不授予应用角色', async () => {
  const [a, b] = [crypto.randomUUID(), crypto.randomUUID()];
  await database`insert into public.categories(id,slug,name) values (${a}::uuid,${a},'A'),(${b}::uuid,${b},'B')`;
  const ready = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  const holding = database.begin(async sql => {
    await sql`update public.categories set parent_id=${b}::uuid where id=${a}::uuid`;
    ready.resolve(); await release.promise;
  });
  holding.catch(ready.reject);
  try {
    await ready.promise;
    await expect(Promise.resolve(database`update public.categories set parent_id=${a}::uuid where id=${b}::uuid`)).rejects.toMatchObject({ errno: '55P03' });
    release.resolve(); await holding;
    await expect(Promise.resolve(database`update public.categories set parent_id=${a}::uuid where id=${b}::uuid`)).rejects.toThrow('cannot contain a cycle');
    for (const role of ['anon', 'authenticated', 'service_role']) {
      const [row] = await database`select has_table_privilege(${role},'private.category_tree_guard','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') allowed`;
      expect(row.allowed).toBe(false);
    }
  } finally {
    release.resolve(); await holding;
    await database`delete from public.categories where id in (${a}::uuid,${b}::uuid)`;
  }
});

for (const graph of ['product', 'category'] as const) {
  test(`${graph} 在 REPEATABLE READ 的旧快照上也不能绕过关联校验`, async () => {
    const f = await database.begin(fixture);
    const [a, b] = [crypto.randomUUID(), crypto.randomUUID()];
    await database`insert into public.categories(id,slug,name) values (${a}::uuid,${a},'A'),(${b}::uuid,${b},'B')`;
    await database`update public.products set status='active' where id=${f.p}::uuid`;
    try {
      const result = await staleAfterCommit(database, async sql => {
        if (graph === 'product') await sql`update public.variant_option_values set option_value_id=${f.green}::uuid where variant_id=${f.b}::uuid and option_value_id=${f.blue}::uuid`;
        else await sql`update public.categories set parent_id=${a}::uuid where id=${b}::uuid`;
      }, async () => {
        if (graph === 'product') await database`update public.variant_option_values set option_value_id=${f.green}::uuid where variant_id=${f.a}::uuid and option_value_id=${f.red}::uuid`;
        else await database`update public.categories set parent_id=${b}::uuid where id=${a}::uuid`;
      });
      expect(result.error).toMatchObject({ errno: '40001' });
    } finally {
      await database`delete from public.products where id in (${f.p}::uuid,${f.q}::uuid)`;
      await database`delete from public.categories where id in (${a}::uuid,${b}::uuid)`;
    }
  });
}

// Retained from the original review; grouped by business domain.
test('分类不允许自环', async () => {
    const id = crypto.randomUUID();
    const { data } = await api('/rest/v1/categories', {
      service: true, method: 'POST',
      body: { id, slug: `self-loop-${id}`, name: '自环', parent_id: id },
    });
    expect((data as { code: string }).code).toBe('23514');  // check_violation
  });
