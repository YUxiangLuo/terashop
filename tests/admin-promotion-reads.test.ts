import { afterAll, beforeAll, expect, test } from 'bun:test';
import { AdminBackend } from '../mcp/src/backend';
import { API, ANON_KEY, api, checked, rpc, signup, makeAdmin, TEST_ADDRESS, type TestUser } from './helpers';
import { mcpSession, toolData } from './support/mcp';
import { Cleanup } from './support/cleanup';
import { stockedProduct } from './support/catalog';
import { promotionFixture } from './support/promotions';

interface Page<T> {
  items: T[];
  next_cursor: string | null;
}
interface Promotion {
  id: string;
  used_count: number;
  code: string | null;
  apply_scope: string;
  get_scope: string;
}
interface Target {
  id: string;
  role: string;
  product_id: string | null;
  category_id: string | null;
  variant_id: string | null;
}
interface Redemption {
  id: string;
  promotion_id: string;
  customer_id: string;
  order_id: string;
}
const cleanup = new Cleanup();
let admin: TestUser, buyer: TestUser, session: Awaited<ReturnType<typeof mcpSession>>;
beforeAll(async () => {
  admin = await signup();
  buyer = await signup();
  await makeAdmin(admin.userId);
  session = await mcpSession(new AdminBackend({ url: API, anonKey: ANON_KEY, accessToken: admin.token }));
});
afterAll(async () => {
  try {
    await cleanup.run();
  } finally {
    await session?.close();
  }
});
const read = (promotion_id: string) =>
  toolData<Promotion>(session.client, 'get_admin_promotion', { promotion_id });
const list = (args: Record<string, unknown>) =>
  toolData<Page<Promotion>>(session.client, 'list_admin_promotions', args);
const targets = (promotion_id: string, args: Record<string, unknown> = {}) =>
  toolData<Page<Target>>(session.client, 'list_admin_promotion_targets', { promotion_id, ...args });
const redemptions = (promotion_id: string, args: Record<string, unknown> = {}) =>
  toolData<Page<Redemption>>(session.client, 'list_admin_discount_redemptions', { promotion_id, ...args });

test('促销列表按 UUID 分页，组合过滤，字面名称/码搜索，active 不冒充生效状态', async () => {
  const marker = crypto.randomUUID(),
    ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()].sort();
  for (let i = 0; i < ids.length; i++)
    await promotionFixture(cleanup, {
      id: ids[i],
      name: `${marker}-${['0%_', '0XY', '2'][i]}`,
      code: i === 1 ? null : `CODE-${ids[i]}`,
      type: i === 1 ? 'free_shipping' : 'order_percentage',
      params: i === 1 ? {} : { percent: 17, threshold: 42 },
      is_active: i !== 0,
      starts_at: '2100-01-01T00:00:00Z',
      ends_at: '2100-02-01T00:00:00Z',
    });
  const first = await list({ search: marker, page_size: 2 });
  expect(first.items.map((p) => p.id)).toEqual(ids.slice(0, 2));
  expect(first.next_cursor).toBe(ids[1]);
  const last = await list({ search: marker, page_size: 2, after_id: first.next_cursor });
  expect(last.items.map((p) => p.id)).toEqual([ids[2]]);
  expect(last.next_cursor).toBeNull();
  expect(
    (
      await list({ search: marker, active: true, code_only: true, type_filter: 'order_percentage' })
    ).items.map((p) => p.id),
  ).toEqual([ids[2]]);
  expect((await list({ search: marker, code_only: false })).items.map((p) => p.id)).toEqual([ids[1]]);
  expect((await list({ search: marker, type_filter: 'free_shipping' })).items.map((p) => p.id)).toEqual([
    ids[1],
  ]);
  expect((await list({ search: marker, active: false })).items.map((p) => p.id)).toEqual([ids[0]]);
  expect((await list({ search: ` ${marker}-0%_ ` })).items.map((p) => p.id)).toEqual([ids[0]]);
  expect((await list({ search: `code-${ids[2]}` })).items.map((p) => p.id)).toEqual([ids[2]]);
  expect(await read(ids[0])).toEqual(first.items[0]);
  expect(await read(ids[0])).toMatchObject({
    params: { percent: 17, threshold: 42 },
    is_active: false,
    apply_scope: 'all',
    get_scope: 'same_as_apply',
    used_count: 0,
    usage_limit: null,
  });
  expect(await read(crypto.randomUUID())).toBeNull();
});

test('目标独立分页保留 apply/get 与三种引用；删除后 selected/empty 不变成全店', async () => {
  const product = await stockedProduct(admin, { onHand: 0, cleanup });
  const [category] = await checked<{ id: string }[]>(
    api('/rest/v1/categories?select=id&limit=1', { service: true }),
  );
  const promotion_id = await promotionFixture(cleanup, {
    name: 'Target reads',
    type: 'buy_x_get_y',
    params: { buy: 2, get: 1 },
    is_active: false,
  });
  const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()].sort();
  const rows = [
    { id: ids[0], role: 'apply', product_id: product.productId, category_id: null, variant_id: null },
    { id: ids[1], role: 'get', product_id: null, category_id: null, variant_id: product.variantId },
    { id: ids[2], role: 'apply', product_id: null, category_id: category.id, variant_id: null },
  ].map((row) => ({ ...row, promotion_id }));
  await checked(api('/rest/v1/promotion_targets', { service: true, method: 'POST', body: rows }));
  const first = await targets(promotion_id, { page_size: 2 });
  expect(first).toEqual({ items: rows.slice(0, 2), next_cursor: ids[1] });
  expect(await targets(promotion_id, { page_size: 2, after_id: first.next_cursor })).toEqual({
    items: [rows[2]],
    next_cursor: null,
  });
  expect(await targets(promotion_id, { role_filter: 'get' })).toEqual({
    items: [rows[1]],
    next_cursor: null,
  });
  expect((await targets(promotion_id, { role_filter: 'apply' })).items.map((r) => r.id)).toEqual([
    ids[0],
    ids[2],
  ]);
  await checked(
    api(`/rest/v1/promotion_targets?promotion_id=eq.${promotion_id}&role=eq.apply`, {
      service: true,
      method: 'DELETE',
    }),
  );
  expect(await read(promotion_id)).toMatchObject({ apply_scope: 'selected', get_scope: 'selected' });
  expect(await targets(promotion_id, { role_filter: 'apply' })).toEqual({ items: [], next_cursor: null });
  expect(await targets(crypto.randomUUID())).toEqual({ items: [], next_cursor: null });
});

test('真实订单优惠码占用分页/客户筛选，取消释放；自动促销只增加 used_count', async () => {
  const product = await stockedProduct(admin, { onHand: 10, cleanup });
  const code = `READ-${crypto.randomUUID()}`.toUpperCase();
  const promotion_id = await promotionFixture(cleanup, {
    name: 'Coupon reads',
    code,
    type: 'order_fixed',
    params: { amount: 3 },
    per_customer_limit: 5,
  });
  const customer_id = await checked<string>(rpc('current_customer_id', {}, buyer.token));
  const orders: string[] = [];
  const pending = new Set<string>();
  for (let i = 0; i < 2; i++) {
    const order = await checked<{ id: string; discount_total: number }>(
      rpc(
        'create_order',
        {
          items: [{ variant_id: product.variantId, quantity: 1 }],
          discount_code: code,
          address: TEST_ADDRESS,
          idempotency_key: crypto.randomUUID(),
        },
        buyer.token,
      ),
    );
    pending.add(order.id);
    cleanup.defer(async () => {
      if (pending.has(order.id)) await checked(rpc('cancel_order', { order_id: order.id }, buyer.token));
    });
    expect(order.discount_total).toBe(3);
    orders.push(order.id);
  }
  expect((await read(promotion_id)).used_count).toBe(2);
  const first = await redemptions(promotion_id, { page_size: 1 });
  expect(first.items).toHaveLength(1);
  expect(first.next_cursor).toBe(first.items[0].id);
  const last = await redemptions(promotion_id, { page_size: 1, after_id: first.next_cursor });
  expect(last.items).toHaveLength(1);
  expect(last.next_cursor).toBeNull();
  expect(first.items[0].id < last.items[0].id).toBe(true);
  expect([...first.items, ...last.items].map((r) => r.order_id).sort()).toEqual([...orders].sort());
  expect(first.items[0]).toMatchObject({ customer_id, promotion_id });
  expect(
    (await redemptions(promotion_id, { customer_id, order_id: orders[1] })).items.map((r) => r.order_id),
  ).toEqual([orders[1]]);
  expect(await redemptions(promotion_id, { customer_id: crypto.randomUUID(), order_id: orders[1] })).toEqual({
    items: [],
    next_cursor: null,
  });
  await checked(rpc('cancel_order', { order_id: orders[0] }, buyer.token));
  pending.delete(orders[0]);
  expect((await redemptions(promotion_id)).items.map((r) => r.order_id)).toEqual([orders[1]]);
  expect((await read(promotion_id)).used_count).toBe(1);
  const auto = await promotionFixture(cleanup, {
    name: 'Automatic reads',
    type: 'item_percentage',
    params: { percent: 13 },
    apply_scope: 'selected',
  });
  await checked(
    api('/rest/v1/promotion_targets', {
      service: true,
      method: 'POST',
      body: { promotion_id: auto, product_id: product.productId },
    }),
  );
  const order = await checked<{ id: string; discount_total: number }>(
    rpc(
      'create_order',
      {
        items: [{ variant_id: product.variantId, quantity: 1 }],
        address: TEST_ADDRESS,
        idempotency_key: crypto.randomUUID(),
      },
      buyer.token,
    ),
  );
  cleanup.defer(() => checked(rpc('cancel_order', { order_id: order.id }, buyer.token)));
  expect(order.discount_total).toBe(1.3);
  expect((await read(auto)).used_count).toBe(1);
  expect(await redemptions(auto)).toEqual({ items: [], next_cursor: null });
  expect(await redemptions(crypto.randomUUID())).toEqual({ items: [], next_cursor: null });
});

test('所有促销读取 RPC 独立拒绝非管理员；校验分页、类型、范围和必填父 ID', async () => {
  const id = crypto.randomUUID();
  for (const name of [
    'get_admin_promotion',
    'list_admin_promotions',
    'list_admin_promotion_targets',
    'list_admin_discount_redemptions',
  ]) {
    const args = name === 'list_admin_promotions' ? {} : { promotion_id: id };
    for (const token of [undefined, buyer.token])
      expect((await rpc(name, args, token)).data).toMatchObject({ code: '42501' });
    expect((await rpc(name, args, undefined, true)).status).toBe(200);
  }
  for (const name of [
    'list_admin_promotions',
    'list_admin_promotion_targets',
    'list_admin_discount_redemptions',
  ])
    for (const page_size of [0, 101, null])
      expect(
        (
          await rpc(
            name,
            { ...(name === 'list_admin_promotions' ? {} : { promotion_id: id }), page_size },
            admin.token,
          )
        ).data,
      ).toMatchObject({ code: '22023' });
  for (const args of [{ type_filter: 'bogus' }, { search: 'x'.repeat(201) }])
    expect((await rpc('list_admin_promotions', args, admin.token)).data).toMatchObject({ code: '22023' });
  expect(
    (await rpc('list_admin_promotion_targets', { promotion_id: id, role_filter: 'buy' }, admin.token)).data,
  ).toMatchObject({ code: '22023' });
  for (const name of ['list_admin_promotion_targets', 'list_admin_discount_redemptions'])
    expect((await rpc(name, { promotion_id: null }, admin.token)).data).toMatchObject({ code: '22023' });
});
