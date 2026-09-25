import { afterAll, beforeAll, expect, test } from 'bun:test';
import { checked, rpc, signup, makeAdmin, type TestUser } from './helpers';
import { fixtureOrder } from './payment-fixtures';
import { stockedProduct } from './support/catalog';
import { Cleanup } from './support/cleanup';
import { heldTransactionRace, testDatabase } from './database-concurrency';

const database = testDatabase();
const cleanup = new Cleanup();
let admin: TestUser, otherAdmin: TestUser, customer: TestUser;
beforeAll(async () => {
  admin = await signup(); otherAdmin = await signup(); customer = await signup();
  await makeAdmin(admin.userId); await makeAdmin(otherAdmin.userId);
});
afterAll(async () => { try { await cleanup.run(); } finally { await database.close(); } });

test('库存命令同键并发只应用一次，参数冲突拒绝，重放返回当前库存', async () => {
  const product = await stockedProduct(admin, { onHand: 13, cleanup });
  const input = { variant_id: product.variantId, delta: 7, idempotency_key: crypto.randomUUID(), note: 'retry' };
  const repeated = await heldTransactionRace(database, async tx => {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ role: 'authenticated', sub: admin.userId })}, true)`;
    await tx`select public.adjust_inventory(${product.variantId}::uuid,7,${input.idempotency_key},'adjust','retry')`;
  }, () => rpc('adjust_inventory', input, otherAdmin.token));
  expect(await checked(Promise.resolve(repeated))).toMatchObject({ variant_id: product.variantId, on_hand: 20 });
  expect((await rpc('adjust_inventory', { ...input, delta: 8 }, admin.token)).data)
    .toMatchObject({ code: 'PT409' });
  await checked(rpc('adjust_inventory', { ...input, delta: -3, idempotency_key: crypto.randomUUID() }, admin.token));
  expect(await checked(rpc('adjust_inventory', { ...input, idempotency_key: ` ${input.idempotency_key} ` }, admin.token)))
    .toMatchObject({ on_hand: 17 });
  const movements: { delta: number }[] = await database`select delta from public.inventory_movements
    where variant_id=${product.variantId}::uuid order by id`;
  expect(movements.map(row => row.delta)).toEqual([13, 7, -3]);
  expect((await rpc('adjust_inventory', input, customer.token)).data).toMatchObject({ code: '42501' });
});

test('库存重放沿用首次仓库，不重新解析当前默认仓；失败事务不占用幂等键', async () => {
  const product = await stockedProduct(admin, { onHand: 1, cleanup });
  const input = { variant_id: product.variantId, delta: -2, idempotency_key: crypto.randomUUID() };
  expect((await rpc('adjust_inventory', input, admin.token)).status).toBe(400);
  await checked(rpc('adjust_inventory', { ...input, delta: 5, idempotency_key: crypto.randomUUID() }, admin.token));
  const first = await checked<{ location_id: string; on_hand: number }>(rpc('adjust_inventory', input, admin.token));
  expect(first.on_hand).toBe(4);
  const locationId = crypto.randomUUID();
  await database.begin(async tx => {
    await tx`update public.locations set is_default=false where id=${first.location_id}::uuid`;
    await tx`insert into public.locations(id,code,name,is_default)
      values (${locationId}::uuid,${locationId},'Retry test warehouse',true)`;
  });
  try {
    expect(await checked<typeof first>(rpc('adjust_inventory', input, admin.token))).toEqual(first);
    expect(await database`select * from public.inventory_levels
      where variant_id=${product.variantId}::uuid and location_id=${locationId}::uuid`).toHaveLength(0);
    expect((await rpc('adjust_inventory', { ...input, location_id: locationId }, admin.token)).data)
      .toMatchObject({ code: 'PT409' });
  } finally {
    await database.begin(async tx => {
      await tx`delete from public.locations where id=${locationId}::uuid`;
      await tx`update public.locations set is_default=true where id=${first.location_id}::uuid`;
    });
  }
});

test('客户创建同键串行化，不按邮箱合并；匿名化后的重放不恢复旧 PII', async () => {
  const email = `retry-${crypto.randomUUID()}@example.test`;
  const input = { email, full_name: 'Original', phone: '+1 555', idempotency_key: crypto.randomUUID() };
  const repeated = await heldTransactionRace(database, async tx => {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ role: 'authenticated', sub: admin.userId })}, true)`;
    await tx`select public.create_customer(${input.idempotency_key},${email},'Original','+1 555')`;
  }, () => rpc('create_customer', { ...input, email: ` ${email} ` }, otherAdmin.token));
  const first = await checked<{ id: string }>(Promise.resolve(repeated));
  cleanup.defer(() => checked(rpc('anonymize_customer', { customer_id: first.id }, admin.token)));
  expect(await database`select id from public.customers where email=${email}`).toHaveLength(1);
  expect((await rpc('create_customer', { ...input, full_name: 'Different' }, admin.token)).data)
    .toMatchObject({ code: 'PT409' });
  const another = await checked<{ id: string }>(rpc('create_customer', { ...input, idempotency_key: crypto.randomUUID() }, admin.token));
  expect(another.id).not.toBe(first.id);
  cleanup.defer(() => checked(rpc('anonymize_customer', { customer_id: another.id }, admin.token)));
  await checked(rpc('anonymize_customer', { customer_id: first.id }, admin.token));
  expect(await checked(rpc('create_customer', input, admin.token)))
    .toMatchObject({ id: first.id, email: null, full_name: '', phone: null });
  expect((await rpc('create_customer', input, customer.token)).data).toMatchObject({ code: '42501' });
});

test('客户恢复只读已提交身份，未知/未提交请求不创建客户，权限与匿名化仍有效', async () => {
  const key = crypto.randomUUID();
  const lookup = (token = admin.token) => rpc('get_customer_creation_result', { idempotency_key: key }, token);
  expect(await checked(lookup())).toBeNull();
  let id = '';
  await database.begin(async tx => {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ role: 'authenticated', sub: admin.userId })}, true)`;
    const [row] = await tx`select (public.create_customer(${key},'recover@example.test','Original','555')).id`;
    id = row.id;
    // The HTTP reader has a different transaction: an absent receipt is not proof of failure.
    expect(await checked(lookup())).toBeNull();
  });
  cleanup.defer(() => checked(rpc('anonymize_customer', { customer_id: id }, admin.token)));
  expect(await checked<string | null>(lookup(otherAdmin.token))).toBe(id);
  expect(await checked<string | null>(rpc('get_customer_creation_result', { idempotency_key: ` ${key} ` }, undefined, true))).toBe(id);
  expect((await lookup(customer.token)).data).toMatchObject({ code: '42501' });
  expect((await rpc('get_customer_creation_result', { idempotency_key: key })).data).toMatchObject({ code: '42501' });
  for (const invalid of [null, '', ' ', 'x'.repeat(201)]) {
    expect((await rpc('get_customer_creation_result', { idempotency_key: invalid }, admin.token)).data).toMatchObject({ code: '22023' });
  }
  await checked(rpc('anonymize_customer', { customer_id: id }, admin.token));
  expect(await checked<string | null>(lookup())).toBe(id);
  expect(await checked(rpc('get_admin_customer', { customer_id: id }, admin.token)))
    .toMatchObject({ id, email: null, full_name: '', phone: null });
  const receipts: { resource_id: string }[] = await database`select resource_id from commerce.command_idempotency where scope='customer.create' and idempotency_key=${key}`;
  expect(receipts).toEqual([{ resource_id: id }]);
  await checked(rpc('set_user_role', { user_id: otherAdmin.userId, role: 'customer' }, admin.token));
  try { expect((await lookup(otherAdmin.token)).data).toMatchObject({ code: '42501' }); }
  finally { await makeAdmin(otherAdmin.userId); }
});

test('手工收款同键并发只记一次资金和库存，之后重放返回退款后的订单', async () => {
  const product = await stockedProduct(admin, { onHand: 11, price: 17, cleanup });
  const order = await fixtureOrder(product, customer, 2);
  const input = { order_id: order.id, provider_ref: 'manual-receipt', idempotency_key: crypto.randomUUID() };
  const repeated = await heldTransactionRace(database, async tx => {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ role: 'authenticated', sub: admin.userId })}, true)`;
    await tx`select public.mark_order_paid(${order.id}::uuid,${input.idempotency_key},'manual','manual-receipt')`;
  }, () => rpc('mark_order_paid', input, otherAdmin.token));
  expect(await checked(Promise.resolve(repeated))).toMatchObject({ id: order.id, financial_status: 'paid', total: 34 });
  expect((await rpc('mark_order_paid', { ...input, provider_ref: 'different' }, admin.token)).data)
    .toMatchObject({ code: 'PT409' });
  expect((await rpc('mark_order_paid', { ...input, idempotency_key: crypto.randomUUID() }, admin.token)).status).toBe(400);
  expect(await database`select id from commerce.payment_transactions where order_id=${order.id}::uuid`).toHaveLength(1);
  expect(await database`select id from public.order_events where order_id=${order.id}::uuid and type='payment_received'`).toHaveLength(1);
  const movements: { delta: number }[] = await database`select delta from public.inventory_movements where order_id=${order.id}::uuid`;
  expect(movements).toEqual([{ delta: -2 }]);
  await checked(rpc('refund_order', { order_id: order.id, idempotency_key: crypto.randomUUID() }, admin.token));
  expect(await checked(rpc('mark_order_paid', input, admin.token)))
    .toMatchObject({ id: order.id, financial_status: 'refunded' });
  expect((await rpc('mark_order_paid', input, customer.token)).data).toMatchObject({ code: '42501' });
});

test('三个管理命令拒绝空白、NULL 和过长幂等键，角色降级后不能重放', async () => {
  const product = await stockedProduct(admin, { cleanup });
  const order = await fixtureOrder(product, customer);
  const operations = [
    ['adjust_inventory', { variant_id: product.variantId, delta: 3 }],
    ['create_customer', { full_name: 'Validation' }],
    ['mark_order_paid', { order_id: order.id }],
  ] as const;
  for (const [name, body] of operations) {
    for (const key of [null, '', '  ', 'x'.repeat(201)]) {
      expect((await rpc(name, { ...body, idempotency_key: key }, admin.token)).data).toMatchObject({ code: '22023' });
    }
  }
  const input = { variant_id: product.variantId, delta: 3, idempotency_key: crypto.randomUUID().padEnd(200, 'x') };
  await checked(rpc('adjust_inventory', input, otherAdmin.token));
  await checked(rpc('set_user_role', { user_id: otherAdmin.userId, role: 'customer' }, admin.token));
  try {
    expect((await rpc('adjust_inventory', input, otherAdmin.token)).data).toMatchObject({ code: '42501' });
  } finally { await makeAdmin(otherAdmin.userId); }
  await checked(rpc('cancel_order', { order_id: order.id }, customer.token));
});
