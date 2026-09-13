import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { TransactionSQL } from 'bun';
import { withRollback } from '../scripts/lib/transactions';
import { testDatabase } from './database-concurrency';
import { makeAdmin, signup, TEST_ADDRESS, type TestUser } from './helpers';

const database = testDatabase();
let admin: TestUser;
beforeAll(async () => { admin = await signup(); await makeAdmin(admin.userId); });
afterAll(() => database.close());

async function product(sql: TransactionSQL) {
  const p = crypto.randomUUID(), v = crypto.randomUUID();
  await sql`insert into public.products(id,slug,name) values (${p}::uuid,${p},'Design review')`;
  await sql`insert into public.product_variants(id,product_id,price,track_inventory) values (${v}::uuid,${p}::uuid,10,false)`;
  return { p, v };
}
async function actor(sql: TransactionSQL) {
  await sql`select set_config('request.jwt.claims',${JSON.stringify({ sub: admin.userId, role: 'authenticated' })},true)`;
  await sql`set local role authenticated`;
}

for (const owner of ['category', 'product', 'variant', 'association'] as const) {
  test(`删除最后一个 ${owner} 促销目标不会把定向优惠扩大到其他商品`, async () => {
    await withRollback(database, async sql => {
      const f = await product(sql), target = await product(sql);
      const category = crypto.randomUUID(), promo = crypto.randomUUID(), code = promo.toUpperCase();
      await sql`update public.products set status='active' where id=${f.p}::uuid`;
      await sql`insert into public.categories(id,slug,name) values (${category}::uuid,${category},'Restricted category')`;
      await actor(sql);
      await sql`insert into public.promotions(id,name,code,type,params) values (${promo}::uuid,'Restricted',${code},'item_percentage','{"percent":50}')`;
      const field = owner === 'category' ? 'category_id' : owner === 'product' ? 'product_id' : 'variant_id';
      const id = owner === 'category' ? category : owner === 'product' ? target.p : target.v;
      await sql.unsafe(`insert into public.promotion_targets(promotion_id,${field}) values ($1::uuid,$2::uuid)`, [promo, id]);
      const price = async () => {
        const [row] = await sql`select public.price_checkout(jsonb_build_array(jsonb_build_object('variant_id',${f.v}::uuid,'quantity',1)),discount_code=>${code}) as pricing`;
        return row.pricing;
      };
      expect((await price()).discount_total).toBe(0);
      if (owner === 'association') await sql`delete from public.promotion_targets where promotion_id=${promo}::uuid`;
      else await sql.unsafe(`delete from public.${owner === 'category' ? 'categories' : owner === 'product' ? 'products' : 'product_variants'} where id=$1::uuid`, [id]);
      expect((await price()).discount_total).toBe(0);
    });
  });
}

test('买赠最后一个 get 目标被删除后不能回退为买同款赠同款', async () => {
  await withRollback(database, async sql => {
    const f = await product(sql), target = await product(sql), promo = crypto.randomUUID(), code = promo.toUpperCase();
    await sql`update public.products set status='active' where id=${f.p}::uuid`;
    await actor(sql);
    await sql`insert into public.promotions(id,name,code,type,params) values (${promo}::uuid,'Restricted gift',${code},'buy_x_get_y','{"buy":1,"get":1}')`;
    await sql`insert into public.promotion_targets(promotion_id,role,product_id) values (${promo}::uuid,'apply',${f.p}::uuid),(${promo}::uuid,'get',${target.p}::uuid)`;
    const price = async () => (await sql`select public.price_checkout(jsonb_build_array(jsonb_build_object('variant_id',${f.v}::uuid,'quantity',2)),discount_code=>${code}) p`)[0].p;
    expect((await price()).discount_total).toBe(0);
    await sql`delete from public.products where id=${target.p}::uuid`;
    expect((await price()).discount_total).toBe(0);
  });
});

test('未知 metafield 类型被数据库拒绝，json 仍是显式的任意结构类型', async () => {
  await expect(withRollback(database, async sql => {
    const f = await product(sql); await actor(sql);
    await sql`insert into public.metafields(owner_type,owner_id,key,type,value) values ('product',${f.p}::uuid,'unknown','not_a_type','{"anything":true}')`;
  })).rejects.toThrow('unsupported metafield type');
  await withRollback(database, async sql => {
    const f = await product(sql); await actor(sql);
    const [row] = await sql`insert into public.metafields(owner_type,owner_id,key,type,value) values ('product',${f.p}::uuid,'json','json','{"anything":true}') returning value`;
    expect(row.value).toEqual({ anything: true });
  });
});

for (const owner of ['product', 'variant', 'category'] as const) test(`删除 ${owner} 会清理所属 metafields，不留下多态孤儿`, async () => {
  await withRollback(database, async sql => {
    const f = await product(sql), c = crypto.randomUUID(), m = crypto.randomUUID();
    await sql`insert into public.categories(id,slug,name) values (${c}::uuid,${c},'Metadata owner')`;
    const id = owner === 'product' ? f.p : owner === 'variant' ? f.v : c;
    await actor(sql);
    await sql`insert into public.metafields(id,owner_type,owner_id,key,type,value) values (${m}::uuid,${owner},${id}::uuid,'text','text','"value"')`;
    await sql.unsafe(`delete from public.${owner === 'product' ? 'products' : owner === 'variant' ? 'product_variants' : 'categories'} where id=$1::uuid`, [id]);
    expect(await sql`select id from public.metafields where id=${m}::uuid`).toHaveLength(0);
  });
});

test('selected 空范围失败关闭，添加目标自动进入 selected；扩大到 all 必须显式操作', async () => {
  await withRollback(database, async sql => {
    const f = await product(sql), promo = crypto.randomUUID(), code = promo.toUpperCase();
    await sql`update public.products set status='active' where id=${f.p}::uuid`; await actor(sql);
    await sql`insert into public.promotions(id,name,code,type,params,apply_scope) values (${promo}::uuid,'Explicit scope',${code},'item_percentage','{"percent":50}','selected')`;
    const price = async () => (await sql`select public.price_checkout(jsonb_build_array(jsonb_build_object('variant_id',${f.v}::uuid,'quantity',1)),discount_code=>${code}) p`)[0].p;
    expect((await price()).discount_total).toBe(0);
    await sql`insert into public.promotion_targets(promotion_id,product_id) values (${promo}::uuid,${f.p}::uuid)`;
    const selected = await price(); expect(selected.discount_total).toBe(5);
    expect(selected.promotions[0].snapshot).toMatchObject({ apply_scope: 'selected', get_scope: 'same_as_apply' });
    await sql`savepoint reset_scope`;
    await expect(Promise.resolve(sql`update public.promotions set apply_scope='all' where id=${promo}::uuid`)).rejects.toThrow('remove selected targets');
    await sql`rollback to savepoint reset_scope`; await sql`release savepoint reset_scope`;
    await sql`delete from public.promotion_targets where promotion_id=${promo}::uuid`;
    expect((await price()).discount_total).toBe(0);
    await sql`update public.promotions set apply_scope='all' where id=${promo}::uuid`;
    expect((await price()).discount_total).toBe(5);
    await sql`insert into public.promotion_targets(promotion_id,product_id) values (${promo}::uuid,${f.p}::uuid)`;
    expect((await price()).promotions[0].snapshot.apply_scope).toBe('selected');
  });
});

test('metafield FK 路由列不可伪造，且五种持久 owner 均有真实外键', async () => {
  const rows: Array<{ attname: string }> = await database`select att.attname from pg_constraint c
    join pg_attribute att on att.attrelid=c.conrelid and att.attnum=any(c.conkey)
    where c.conrelid='public.metafields'::regclass and c.contype='f' order by att.attname`;
  expect(rows.map(r => r.attname)).toEqual(['owner_category_id','owner_customer_id','owner_order_id','owner_product_id','owner_variant_id']);
  await expect(withRollback(database, async sql => {
    const f = await product(sql);
    await sql`insert into public.metafields(owner_type,owner_id,owner_product_id,key,type,value)
      values ('product',${f.p}::uuid,${crypto.randomUUID()}::uuid,'forged','text','"value"')`;
  })).rejects.toMatchObject({ errno: '428C9' });
});

test('已创建订单的对外订单号不可修改，包括零元已付订单', async () => {
  await expect(withRollback(database, async sql => {
    const f = await product(sql);
    await sql`update public.product_variants set price=0 where id=${f.v}::uuid`;
    await sql`update public.products set status='active' where id=${f.p}::uuid`;
    await sql`select set_config('request.jwt.claims',${JSON.stringify({ sub: admin.userId, role: 'authenticated' })},true)`;
    const [row] = await sql`select public.create_order(jsonb_build_array(jsonb_build_object('variant_id',${f.v}::uuid,'quantity',1)),${crypto.randomUUID()},address=>${JSON.stringify(TEST_ADDRESS)}::text::jsonb) o`;
    await sql`select public.mark_order_paid(${row.o.id}::uuid)`;
    await sql`update public.orders set order_number=default where id=${row.o.id}::uuid`;
  })).rejects.toThrow('order identity and number are immutable');
});

test('订单号在受信导入 OVERRIDING SYSTEM VALUE 时仍必须唯一', async () => {
  await expect(withRollback(database, async sql => {
    const f = await product(sql); await sql`update public.products set status='active' where id=${f.p}::uuid`;
    await sql`select set_config('request.jwt.claims',${JSON.stringify({ sub: admin.userId, role: 'authenticated' })},true)`;
    const [row] = await sql`select public.create_order(jsonb_build_array(jsonb_build_object('variant_id',${f.v}::uuid,'quantity',1)),${crypto.randomUUID()},address=>${JSON.stringify(TEST_ADDRESS)}::text::jsonb) o`;
    await sql`insert into public.orders(order_number,customer_id,email,subtotal,total,shipping_address) overriding system value
      values (${row.o.order_number},${admin.customerId}::uuid,'review@example.invalid',0,0,${JSON.stringify(TEST_ADDRESS)}::text::jsonb)`;
  })).rejects.toMatchObject({ errno: '23505' });
});
