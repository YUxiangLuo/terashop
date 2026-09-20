import { afterAll, beforeAll, expect, test } from 'bun:test';
import { api, checked, makeAdmin, rpc, signup, stockOf, type TestUser } from './helpers';
import { fixtureOrder } from './payment-fixtures';
import { stockedProduct, type CatalogFixture } from './support/catalog';
import { Cleanup } from './support/cleanup';
import { heldTransactionRace, staleAfterCommit, testDatabase } from './database-concurrency';

const database = testDatabase(), cleanup = new Cleanup();
let admin: TestUser, other: TestUser, buyer: TestUser, product: CatalogFixture;
beforeAll(async () => {
  admin = await signup(); other = await signup(); buyer = await signup();
  await makeAdmin(admin.userId); await makeAdmin(other.userId);
  product = await stockedProduct(admin, { cleanup });
});
afterAll(async () => { try { await cleanup.run(); } finally { await database.close(); } });
async function shipment() {
  const order = await fixtureOrder(product, buyer, 2);
  await checked(rpc('mark_order_paid', { order_id: order.id, idempotency_key: crypto.randomUUID() }, admin.token));
  const fulfillment = await checked<{ id: string; version: number }>(rpc('create_fulfillment', {
    order_id: order.id, items: [{ order_item_id: order.itemId, quantity: 2 }],
    carrier: 'Original', tracking_number: 'OLD', tracking_url: 'https://example.test/old', idempotency_key: crypto.randomUUID(),
  }, admin.token));
  return { order, fulfillment };
}
const input = (id: string, changes: object, version = 1) => ({
  fulfillment_id: id, changes, expected_version: version, idempotency_key: crypto.randomUUID(),
});

test('并发同键跨管理员只更新一次；物流审计、Outbox 和版本一致，重放读取最新状态', async () => {
  const { order, fulfillment } = await shipment();
  expect(fulfillment.version).toBe(1);
  const body = input(fulfillment.id, { carrier: 'Corrected', tracking_url: null });
  const result = await heldTransactionRace(database, async tx => {
    await tx`select set_config('request.jwt.claims',${JSON.stringify({ role: 'authenticated', sub: admin.userId })},true)`;
    await tx`select public.update_fulfillment(${fulfillment.id}::uuid,1,${JSON.stringify(body.changes)}::text::jsonb,${body.idempotency_key})`;
  }, () => rpc('update_fulfillment', body, other.token));
  expect(await checked(Promise.resolve(result))).toMatchObject({ version: 2, carrier: 'Corrected', tracking_number: 'OLD', tracking_url: null });
  const events = await database`select actor_id,data from public.order_events where order_id=${order.id}::uuid and type='fulfillment_tracking_updated'`;
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ actor_id: admin.userId, data: {
    version: 2, before: { carrier: 'Original', tracking_url: 'https://example.test/old' }, after: { carrier: 'Corrected', tracking_url: null },
  } });
  expect(await database`select id from commerce.outbox_events where aggregate_id=${order.id}::uuid and event_type='fulfillment_tracking_updated'`).toHaveLength(1);
  const delivered = await checked(rpc('update_fulfillment', input(fulfillment.id, { status: 'delivered' }, 2), admin.token));
  expect(delivered).toMatchObject({ version: 3, status: 'delivered', delivered_at: expect.any(String) });
  expect(await checked(rpc('update_fulfillment', body, other.token))).toMatchObject({ version: 3, status: 'delivered' });
  expect((await rpc('update_fulfillment', { ...body, changes: { carrier: 'Wrong' } }, admin.token)).data).toMatchObject({ code: 'PT409' });
  expect((await rpc('update_fulfillment', input(fulfillment.id, { status: 'shipped' }, 3), admin.token)).status).toBe(400);
  expect(await checked(rpc('update_fulfillment', input(fulfillment.id, { status: 'delivered' }, 3), admin.token))).toMatchObject({ version: 3 });
  expect(await database`select id from public.order_events where order_id=${order.id}::uuid and type='fulfillment_delivered'`).toHaveLength(1);
});

test('不同键并发拒绝旧版本；service 写入也推进版本且记录物流事件', async () => {
  const { fulfillment } = await shipment();
  const body = input(fulfillment.id, { tracking_number: 'FIRST' });
  const result = await heldTransactionRace(database, async tx => {
    await tx`select set_config('request.jwt.claims',${JSON.stringify({ role: 'authenticated', sub: admin.userId })},true)`;
    await tx`select public.update_fulfillment(${fulfillment.id}::uuid,1,${JSON.stringify(body.changes)}::text::jsonb,${body.idempotency_key})`;
  }, () => rpc('update_fulfillment', input(fulfillment.id, { tracking_number: 'SECOND' }), other.token));
  expect(result.data).toMatchObject({ code: 'PT409' });
  await checked(api(`/rest/v1/fulfillments?id=eq.${fulfillment.id}`, { service: true, method: 'PATCH', body: { tracking_number: 'SERVICE' } }));
  expect((await rpc('update_fulfillment', input(fulfillment.id, { carrier: 'Stale' }, 2), admin.token)).data).toMatchObject({ code: 'PT409' });
  expect(await checked(rpc('update_fulfillment', body, admin.token))).toMatchObject({ version: 3, tracking_number: 'SERVICE' });
  expect(await database`select id from public.order_events where data->>'fulfillment_id'=${fulfillment.id} and type='fulfillment_tracking_updated'`).toHaveLength(2);
  expect((await api(`/rest/v1/fulfillments?id=eq.${fulfillment.id}`, { service: true, method: 'PATCH', body: { version: 1 } })).status).toBe(400);
});

test('取消重算订单但不回库；退货保护失败不消耗键且不留下版本和审计变更', async () => {
  const { order, fulfillment } = await shipment();
  const before = await stockOf(product.sku);
  const ret = await checked<{ id: string }>(rpc('create_return', { fulfillment_id: fulfillment.id,
    items: [{ order_item_id: order.itemId, quantity: 1 }], idempotency_key: crypto.randomUUID() }, admin.token));
  const body = input(fulfillment.id, { status: 'cancelled', tracking_number: 'CANCELLED' });
  expect((await rpc('update_fulfillment', body, admin.token)).status).toBe(400);
  expect(await database`select id from public.order_events where order_id=${order.id}::uuid and type in ('fulfillment_cancelled','fulfillment_tracking_updated')`).toHaveLength(0);
  await checked(rpc('close_return', { return_id: ret.id, cancel: true }, admin.token));
  expect(await checked(rpc('update_fulfillment', body, admin.token))).toMatchObject({ status: 'cancelled', version: 2 });
  expect(await stockOf(product.sku)).toBe(before);
  const rows = await checked<Array<{ status: string; fulfillment_status: string }>>(api(`/rest/v1/orders?id=eq.${order.id}&select=status,fulfillment_status`, { token: admin.token }));
  expect(rows[0]).toEqual({ status: 'open', fulfillment_status: 'unfulfilled' });
  const lines: { quantity: number; order_item_id: string }[] = await database`select quantity,order_item_id from commerce.fulfillment_lines where fulfillment_id=${fulfillment.id}::uuid`;
  expect(lines).toEqual([{ quantity: 2, order_item_id: order.itemId }]);
});

test('拒绝非法字段、越权、缺失资源；降级后不能重放', async () => {
  const { fulfillment } = await shipment();
  for (const changes of [{}, { items: [] }, { status: null }, { carrier: 12 }, { tracking_number: null }, { version: 2 }, []]) {
    expect((await rpc('update_fulfillment', input(fulfillment.id, changes), admin.token)).data).toMatchObject({ code: '22023' });
  }
  const body = { ...input(fulfillment.id, { tracking_number: 'AUTHORIZED' }), idempotency_key: crypto.randomUUID().padEnd(200, 'x') };
  for (const key of [null, '', ' ', 'x'.repeat(201)]) {
    expect((await rpc('update_fulfillment', { ...body, idempotency_key: key }, admin.token)).data).toMatchObject({ code: '22023' });
  }
  for (const version of [null, 0, -1]) {
    expect((await rpc('update_fulfillment', { ...body, expected_version: version }, admin.token)).data).toMatchObject({ code: '22023' });
  }
  expect((await rpc('update_fulfillment', body, buyer.token)).data).toMatchObject({ code: '42501' });
  expect((await rpc('update_fulfillment', body)).status).toBe(401);
  expect((await rpc('update_fulfillment', { ...body, fulfillment_id: crypto.randomUUID() }, admin.token)).data).toMatchObject({ code: 'PT404' });
  await checked(rpc('update_fulfillment', body, other.token));
  await checked(rpc('set_user_role', { user_id: other.userId, role: 'customer' }, admin.token));
  try { expect((await rpc('update_fulfillment', body, other.token)).data).toMatchObject({ code: '42501' }); }
  finally { await makeAdmin(other.userId); }
});

test('service 纯物流修改在订单锁竞争时 NOWAIT 拒绝，不能反向等待形成死锁', async () => {
  for (const field of ['carrier', 'tracking_number', 'tracking_url'] as const) {
    const { order, fulfillment } = await shipment();
    await database.begin(async tx => {
      await tx`select set_config('request.jwt.claims',${JSON.stringify({ role: 'authenticated', sub: admin.userId })},true)`;
      await tx`select id from public.orders where id=${order.id}::uuid for update`;
      // The order lock is already held. A blocking FK check would time out;
      // NOWAIT must instead reject before the audit INSERT acquires that lock.
      await expect(database.begin(async direct => {
        await direct`set local lock_timeout='300ms'`;
        await direct.unsafe(`update public.fulfillments set ${field}=$1 where id=$2::uuid`, ['https://example.test/review', fulfillment.id]);
      })).rejects.toThrow('could not obtain lock on row');
      const [updated] = await tx`select public.update_fulfillment(${fulfillment.id}::uuid,1,
        '{"carrier":"RPC"}'::jsonb,${crypto.randomUUID()}) result`;
      expect(updated.result).toMatchObject({ version: 2, carrier: 'RPC', tracking_number: 'OLD' });
    });
    await checked(api(`/rest/v1/fulfillments?id=eq.${fulfillment.id}`, {
      service: true, method: 'PATCH', body: { [field]: 'https://example.test/retry' },
    }));
    const [row] = await database`select version from public.fulfillments where id=${fulfillment.id}::uuid`;
    expect(Number(row.version)).toBe(3);
    expect(await database`select id from public.order_events where order_id=${order.id}::uuid and type='fulfillment_tracking_updated'`).toHaveLength(2);
  }
});

test('REPEATABLE READ 旧快照不能覆盖已提交更新', async () => {
  const { fulfillment } = await shipment();
  const body = input(fulfillment.id, { tracking_number: 'NEW' });
  const result = await staleAfterCommit(database, async tx => {
    await tx`select set_config('request.jwt.claims',${JSON.stringify({ role: 'authenticated', sub: admin.userId })},true)`;
    return tx`select public.update_fulfillment(${fulfillment.id}::uuid,1,'{"carrier":"STALE"}'::jsonb,${crypto.randomUUID()})`;
  }, () => checked(rpc('update_fulfillment', body, other.token)));
  expect(result.error).toMatchObject({ errno: '40001' });
  expect(await checked(rpc('update_fulfillment', body, admin.token))).toMatchObject({ version: 2, carrier: 'Original', tracking_number: 'NEW' });
});
