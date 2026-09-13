import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { TransactionSQL } from 'bun';
import { withRollback } from '../scripts/lib/transactions';
import { testDatabase } from './database-concurrency';
import { checked, command, makeAdmin, rpc, signup, TEST_ADDRESS, type TestUser } from './helpers';

const database = testDatabase();
let admin: TestUser, buyer: TestUser, other: TestUser;
beforeAll(async () => {
  [admin, buyer, other] = await Promise.all([signup(), signup(), signup()]);
  await makeAdmin(admin.userId);
});
afterAll(() => database.close());

async function actor(sql: TransactionSQL, user?: TestUser) {
  await sql`reset role`;
  await sql`select set_config('request.jwt.claims',${JSON.stringify(user ? { sub: user.userId, role: 'authenticated' } : { role: 'anon' })},true)`;
  if (user) await sql`set local role authenticated`;
  else await sql`set local role anon`;
}

async function product(sql: TransactionSQL) {
  const id = crypto.randomUUID(), variant = crypto.randomUUID();
  await sql`insert into public.products(id,slug,name) values (${id}::uuid,${id},'API fixture')`;
  await sql`insert into public.product_variants(id,product_id,price,cost,track_inventory)
    values (${variant}::uuid,${id}::uuid,17,4,false)`;
  await sql`update public.products set status='active' where id=${id}::uuid`;
  return { id, variant };
}

test('Storefront DTO 不随调用者升权；Admin DTO 独立验证身份并包含成本/草稿', async () => {
  await withRollback(database, async sql => {
    const p = await product(sql), hidden = crypto.randomUUID();
    await sql`insert into public.product_variants(id,product_id,price,cost,is_active)
      values (${hidden}::uuid,${p.id}::uuid,1,0.5,false)`;
    await sql`insert into public.product_images(product_id,variant_id,url) values (${p.id}::uuid,${hidden}::uuid,'https://example.invalid/private.png')`;
    await sql`insert into public.metafield_definitions(owner_type,namespace,key,name,type)
      values ('product',${p.id},'internal','Supplier note','text')`;
    await sql`insert into public.metafields(owner_type,owner_id,namespace,key,type,value)
      values ('product',${p.id}::uuid,${p.id},'internal','text','"do not publish"')`;
    await actor(sql);
    const [anonymous] = await sql`select public.get_storefront_product(${p.id}::uuid) as dto`;
    expect(anonymous.dto.variants).toHaveLength(1);
    expect(anonymous.dto.variants[0]).toMatchObject({ id: p.variant, price: 17, in_stock: true });
    expect(anonymous.dto.variants[0]).not.toHaveProperty('cost');
    expect(anonymous.dto).not.toHaveProperty('status');
    expect(anonymous.dto.images).toEqual([]);
    expect(anonymous.dto.metafields).toEqual([]);
    for (const user of [buyer, admin]) {
      await actor(sql, user);
      expect((await sql`select public.get_storefront_product(${p.id}::uuid) as dto`)[0]).toEqual(anonymous);
    }
    const [managed] = await sql`select public.get_admin_product(${p.id}::uuid) as dto`;
    expect(managed.dto.status).toBe('active');
    expect(managed.dto.variants).toHaveLength(2);
    expect(managed.dto.variants.find((v: { id: string }) => v.id === p.variant).cost).toBe(4);
    expect(managed.dto.metafields[0].value).toBe('do not publish');
    await sql`update public.products set status='draft' where id=${p.id}::uuid`;
    expect((await sql`select public.get_storefront_product(${p.id}::uuid) as dto`)[0].dto).toBeNull();
    expect((await sql`select public.get_admin_product(${p.id}::uuid) as dto`)[0].dto.status).toBe('draft');
  });
  const id = crypto.randomUUID();
  for (const token of [undefined, buyer.token]) {
    const result = await rpc('get_admin_product', { product_id: id }, token);
    expect([401, 403]).toContain(result.status);
    expect(result.data).toMatchObject({ code: '42501' });
  }
  expect(await checked(command('get_admin_product', { product_id: id }, admin.token))).toBeNull();
  expect(await checked(command('get_storefront_product', { product_id: id }))).toBeNull();
});

test('商品列表按 UUID 游标分页并精确过滤分类；非法 page_size 拒绝', async () => {
  await withRollback(database, async sql => {
    const category = crypto.randomUUID();
    await sql`insert into public.categories(id,slug,name) values (${category}::uuid,${category},'API category')`;
    const ids: string[] = [];
    for (let n = 0; n < 3; n++) {
      const p = await product(sql); ids.push(p.id);
      await sql`insert into public.product_categories(product_id,category_id) values (${p.id}::uuid,${category}::uuid)`;
    }
    await product(sql); // Must not enter the category-filtered result.
    ids.sort();
    await actor(sql, admin);
    const first = (await sql`select public.list_storefront_products(2,null,${category}::uuid) dto`)[0].dto;
    expect(first.items.map((p: { id: string }) => p.id)).toEqual(ids.slice(0, 2));
    expect(first.next_cursor).toBe(ids[1]);
    expect(first.items[0]).toMatchObject({ price_from: 17, currency: 'USD', in_stock: true });
    const last = (await sql`select public.list_storefront_products(2,${first.next_cursor}::uuid,${category}::uuid) dto`)[0].dto;
    expect(last.items.map((p: { id: string }) => p.id)).toEqual(ids.slice(2));
    expect(last.next_cursor).toBeNull();
    await sql`update public.categories set is_active=false where id=${category}::uuid`;
    expect((await sql`select public.list_storefront_products(2,null,${category}::uuid) dto`)[0].dto).toEqual({ items: [], next_cursor: null });
  });
  for (const page_size of [0, 101, null]) {
    const result = await rpc('list_storefront_products', { page_size });
    expect(result.status).toBe(400);
    expect(result.data).toMatchObject({ code: '22023' });
  }
  expect(await checked(command('list_storefront_products', { page_size: 1 }))).toHaveProperty('items');
});

test('Admin 列表使用时间和 UUID 复合游标，保留微秒且空页/末页无游标', async () => {
  await withRollback(database, async sql => {
    const marker = crypto.randomUUID();
    const ids = Array.from({ length: 4 }, () => crypto.randomUUID()).sort();
    const times = ['2026-01-01T00:00:00.123457Z', '2026-01-01T00:00:00.123456Z',
      '2026-01-01T00:00:00.123456Z', '2025-01-01T00:00:00Z'];
    for (const [i, id] of ids.entries()) {
      await sql`insert into public.products(id,slug,name,updated_at) values (${id}::uuid,${id},${marker},${times[i]}::timestamptz)`;
    }
    await actor(sql, admin);
    const first = (await sql`select public.list_admin_products(page_size=>2,search=>${marker}) dto`)[0].dto;
    expect(first.items.map((p: { id: string }) => p.id)).toEqual([ids[0], ids[2]]);
    expect(first.next_cursor.id).toBe(ids[2]);
    expect(first.next_cursor.updated_at).toContain('.123456');
    const second = (await sql.unsafe('select public.list_admin_products(page_size=>2,search=>$1,after_cursor=>$2::text::jsonb) dto',
      [marker, JSON.stringify(first.next_cursor)]))[0].dto;
    expect(second.items.map((p: { id: string }) => p.id)).toEqual([ids[1], ids[3]]);
    expect(second.next_cursor).toBeNull();
    expect(first.items[0]).toMatchObject({ variant_count: 0, price_from: null, price_to: null, primary_image: null, revision: 1 });
    expect((await sql`select public.list_admin_products(search=>${crypto.randomUUID()}) dto`)[0].dto)
      .toEqual({ items: [], next_cursor: null });
  });
});

test('Admin 列表组合筛选全部状态、精确分类、字面名称/SKU，并只返回摘要', async () => {
  await withRollback(database, async sql => {
    const p = await product(sql), category = crypto.randomUUID(), child = crypto.randomUUID();
    const inactive = crypto.randomUUID(), marker = crypto.randomUUID();
    await sql`update public.products set name=${marker + ' 100%_Cotton'} where id=${p.id}::uuid`;
    await sql`insert into public.product_variants(id,product_id,price,is_active,sku)
      values (${inactive}::uuid,${p.id}::uuid,3,false,${marker + '-SecretSKU'})`;
    await sql`insert into public.product_images(product_id,variant_id,url,position)
      values (${p.id}::uuid,null,'later',9),(${p.id}::uuid,${inactive}::uuid,'first',1)`;
    await sql`insert into public.categories(id,slug,name,is_active) values (${category}::uuid,${category},'Hidden',false)`;
    await sql`insert into public.categories(id,slug,name,parent_id) values (${child}::uuid,${child},'Child',${category}::uuid)`;
    await sql`insert into public.product_categories(product_id,category_id) values (${p.id}::uuid,${category}::uuid)`;
    await actor(sql, admin);
    for (const status of ['active', 'draft', 'archived']) {
      await sql`update public.products set status=${status} where id=${p.id}::uuid`;
      const result = (await sql`select public.list_admin_products(status_filter=>${status},category_id=>${category}::uuid,
        search=>${' ' + marker.toUpperCase() + '-secretsku '}) dto`)[0].dto;
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({ id: p.id, status, variant_count: 2, price_from: 3, price_to: 17, primary_image: 'first' });
      expect(Object.keys(result.items[0]).sort()).toEqual(['id','slug','name','status','updated_at','revision','currency',
        'price_from','price_to','variant_count','primary_image'].sort());
    }
    expect((await sql`select public.list_admin_products(search=>${marker + ' 100%_cotton'}) dto`)[0].dto.items).toHaveLength(1);
    expect((await sql`select public.list_admin_products(search=>${marker + '%Cotton'}) dto`)[0].dto.items).toEqual([]);
    expect((await sql`select public.list_admin_products(status_filter=>'active',search=>${marker}) dto`)[0].dto.items).toEqual([]);
    expect((await sql`select public.list_admin_products(category_id=>${child}::uuid,search=>${marker}) dto`)[0].dto.items).toEqual([]);
    expect((await sql`select public.list_admin_products(search=>${marker}) dto`)[0].dto.items).toHaveLength(1);
    expect((await sql`select public.get_storefront_product(${p.id}::uuid) dto`)[0].dto).toBeNull();
  });
});

test('Admin 列表拒绝匿名/客户以及非法筛选或游标，service 可读取', async () => {
  for (const token of [undefined, buyer.token]) {
    expect((await rpc('list_admin_products', {}, token)).data).toMatchObject({ code: '42501' });
  }
  const cursor = { id: crypto.randomUUID(), updated_at: '2026-01-01T00:00:00Z' };
  for (const args of [{ page_size: 0 }, { page_size: 101 }, { page_size: null }, { status_filter: 'unknown' },
    { search: 'x'.repeat(201) }, { after_cursor: [] }, { after_cursor: {} }, { after_cursor: { ...cursor, extra: 1 } },
    { after_cursor: { ...cursor, id: null } }, { after_cursor: { ...cursor, updated_at: 'infinity' } },
    { after_cursor: { ...cursor, updated_at: 'bad date' } }]) {
    expect((await rpc('list_admin_products', args, admin.token)).status).toBe(400);
  }
  expect(await checked<{ items: unknown[]; next_cursor: null }>(rpc('list_admin_products', { search: 'x'.repeat(200), page_size: 100 }, admin.token)))
    .toEqual({ items: [], next_cursor: null });
  await withRollback(database, async sql => {
    await sql`select set_config('request.jwt.claims','{"role":"service_role"}',true)`;
    await sql`set local role service_role`;
    expect((await sql`select public.list_admin_products(page_size=>1) dto`)[0].dto.items).toHaveLength(1);
  });
});

test('新建/未定义扩展默认私有；公开必须显式，定义收紧立即影响旧表及 Storefront DTO', async () => {
  await withRollback(database, async sql => {
    const p = await product(sql);
    await sql`insert into public.metafield_definitions(owner_type,namespace,key,name,type)
      values ('product',${p.id},'declared','Internal','text')`;
    await sql`insert into public.metafields(owner_type,owner_id,namespace,key,type,value)
      values ('product',${p.id}::uuid,${p.id},'declared','text','"declared secret"'),
      ('product',${p.id}::uuid,${p.id},'undefined','text','"undefined secret"')`;
    await actor(sql, buyer);
    expect(await sql`select * from public.metafields where namespace=${p.id}`).toHaveLength(0);
    expect(await sql`select * from public.metafield_definitions where namespace=${p.id}`).toHaveLength(0);
    expect(await sql`update public.metafield_definitions set access='public' where namespace=${p.id} returning id`).toHaveLength(0);
    await actor(sql, admin);
    expect((await sql`select access from public.metafield_definitions where namespace=${p.id}`)[0].access).toBe('admin');
    expect(await sql`select * from public.metafields where namespace=${p.id}`).toHaveLength(2);
    await sql`update public.metafield_definitions set access='public' where namespace=${p.id}`;
    await actor(sql);
    expect((await sql`select key from public.metafields where namespace=${p.id}`).map((v: { key: string }) => v.key)).toEqual(['declared']);
    expect((await sql`select public.get_storefront_product(${p.id}::uuid) dto`)[0].dto.metafields).toEqual([
      { namespace: p.id, key: 'declared', type: 'text', value: 'declared secret' },
    ]);
    await actor(sql, admin);
    await sql`update public.metafield_definitions set access='admin' where namespace=${p.id}`;
    expect((await sql`select public.get_storefront_product(${p.id}::uuid) dto`)[0].dto.metafields).toEqual([]);
    await actor(sql);
    expect(await sql`select * from public.metafields where namespace=${p.id}`).toHaveLength(0);
  });
});

test('客户可见字段仍限定本人；非法 owner/access 组合与客户提权均被拒绝', async () => {
  await withRollback(database, async sql => {
    const namespace = crypto.randomUUID();
    await sql`insert into public.metafield_definitions(owner_type,namespace,key,name,type,access) values
      ('customer',${namespace},'visible','Visible','text','customer'), ('customer',${namespace},'internal','Internal','text','admin')`;
    await sql`insert into public.metafields(owner_type,owner_id,namespace,key,type,value) values
      ('customer',${buyer.customerId}::uuid,${namespace},'visible','text','"buyer message"'),
      ('customer',${buyer.customerId}::uuid,${namespace},'internal','text','"risk label"')`;
    for (const user of [undefined, other, buyer, admin]) {
      await actor(sql, user);
      const values = await sql`select key from public.metafields where namespace=${namespace} order by key`;
      expect(values.map((v: { key: string }) => v.key)).toEqual(user === admin ? ['internal', 'visible'] : user === buyer ? ['visible'] : []);
    }
  });
  for (const [owner_type, access] of [['customer', 'public'], ['order', 'public'], ['product', 'customer']]) {
    await expect(withRollback(database, async sql => {
      await sql`insert into public.metafield_definitions(owner_type,key,name,type,access)
        values (${owner_type},${crypto.randomUUID()},'Invalid','text',${access})`;
    })).rejects.toMatchObject({ constraint: 'metafield_definitions_access_owner_check' });
  }
});

test('私有/草稿/停用 Metaobject 不经引用穿透；重新公开恢复，UUID 大小写不改变引用', async () => {
  await withRollback(database, async sql => {
    const p = await product(sql), definition = crypto.randomUUID(), object = crypto.randomUUID();
    await sql`insert into public.metaobject_definitions(id,type,name,fields) values (${definition}::uuid,${definition},'Private object','[]')`;
    await sql`insert into public.metaobjects(id,definition_id,handle,values) values (${object}::uuid,${definition}::uuid,'entry','{"note":"content"}')`;
    await sql`insert into public.metafield_definitions(owner_type,namespace,key,name,type,access)
      values ('product',${p.id},'reference','Reference','metaobject_reference','public')`;
    await sql`insert into public.metafields(owner_type,owner_id,namespace,key,type,value)
      values ('product',${p.id}::uuid,${p.id},'reference','metaobject_reference',to_jsonb(${object.toUpperCase()}::text))`;
    for (const state of ['private', 'public', 'draft', 'inactive', 'public']) {
      await actor(sql, admin);
      await sql`update public.metaobject_definitions set access=${state === 'private' ? 'admin' : 'public'},is_active=${state !== 'inactive'} where id=${definition}::uuid`;
      await sql`update public.metaobjects set status=${state === 'draft' ? 'draft' : 'active'} where id=${object}::uuid`;
      await actor(sql);
      expect(await sql`select id from public.metaobjects where id=${object}::uuid`).toHaveLength(state === 'public' ? 1 : 0);
      expect(await sql`select key from public.metafields where namespace=${p.id}`).toHaveLength(state === 'public' ? 1 : 0);
      expect((await sql`select public.get_storefront_product(${p.id}::uuid) dto`)[0].dto.metafields).toHaveLength(state === 'public' ? 1 : 0);
    }
  });
});

test('Storefront 库存只看默认仓并扣除 Quote 预占，取消后恢复且不泄露数量', async () => {
  await withRollback(database, async sql => {
    const p = await product(sql), otherLocation = crypto.randomUUID(), category = crypto.randomUUID();
    await sql`update public.product_variants set track_inventory=true where id=${p.variant}::uuid`;
    await sql`insert into public.locations(id,code,name) values (${otherLocation}::uuid,${otherLocation},'Not checkout location')`;
    await sql`insert into public.inventory_levels(variant_id,location_id,on_hand) values (${p.variant}::uuid,${otherLocation}::uuid,50)`;
    await sql`insert into public.categories(id,slug,name) values (${category}::uuid,${category},'Stock test')`;
    await sql`insert into public.product_categories(product_id,category_id) values (${p.id}::uuid,${category}::uuid)`;
    const stock = async (expected: boolean) => {
      const dto = (await sql`select public.get_storefront_product(${p.id}::uuid) dto`)[0].dto;
      expect(dto.variants[0].in_stock).toBe(expected);
      expect(dto.variants[0]).not.toHaveProperty('on_hand');
      expect((await sql`select public.list_storefront_products(1,null,${category}::uuid) dto`)[0].dto.items[0].in_stock).toBe(expected);
    };
    await actor(sql, buyer);
    await stock(false);
    await actor(sql, admin);
    await sql`select public.adjust_inventory(${p.variant}::uuid,1,'restock')`;
    await actor(sql, buyer);
    await stock(true);
    const [quote] = await sql`select public.create_checkout_quote(
      items=>jsonb_build_array(jsonb_build_object('variant_id',${p.variant}::uuid,'quantity',1)),
      address=>jsonb_build_object('recipient_name',${TEST_ADDRESS.recipient_name}::text,
        'line1',${TEST_ADDRESS.line1}::text,'country',${TEST_ADDRESS.country}::text),idempotency_key=>${crypto.randomUUID()}) dto`;
    await stock(false);
    await sql`select public.cancel_checkout_quote(${quote.dto.id}::uuid)`;
    await stock(true);
  });
});
