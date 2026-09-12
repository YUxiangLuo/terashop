import { describe, test, expect, beforeAll } from 'bun:test';
import { api, rpc, signup, makeAdmin, variantBySku, stockOf, TEST_ADDRESS, type TestUser } from './helpers';

// 使用 TEE-BLK-S（库存 50）做管理端流程，不影响 orders.test.ts 的数据

let admin: TestUser;
let customer: TestUser;
let teeId: string;
let orderId: string;
let orderItemId: string;
let orderTotal: number;

beforeAll(async () => {
  admin = await signup();
  customer = await signup();
  await makeAdmin(admin.userId);
  teeId = await variantBySku('TEE-BLK-S');

  // 顾客下一单：T恤 ×3（会命中 seed 的“服饰分类8折”自动促销）
  const { data } = await rpc(
    'create_order',
    { items: [{ variant_id: teeId, quantity: 3 }], address: TEST_ADDRESS },
    customer.token
  );
  orderId = (data as { id: string }).id;
  orderTotal = Number((data as { total: number }).total);
  const { data: items } = await api(`/rest/v1/order_items?order_id=eq.${orderId}&select=id`, {
    token: customer.token,
  });
  orderItemId = (items as { id: string }[])[0].id;
});

describe('权限边界', () => {
  test('非 admin 不能 set_user_role', async () => {
    const { data } = await rpc(
      'set_user_role',
      { user_id: customer.userId, role: 'admin' },
      customer.token
    );
    expect((data as { message: string }).message).toBe('admin only');
  });

  test('admin 可用 set_user_role 管理角色', async () => {
    const { data } = await rpc(
      'set_user_role',
      { user_id: customer.userId, role: 'customer' },
      admin.token
    );
    expect((data as { role: string }).role).toBe('customer');
  });

  test('非 admin 不能 mark_order_paid / create_fulfillment / adjust_inventory', async () => {
    const p = await rpc('mark_order_paid', { order_id: orderId }, customer.token);
    expect((p.data as { message: string }).message).toBe('admin only');

    const f = await rpc(
      'create_fulfillment',
      { order_id: orderId, items: [{ order_item_id: orderItemId, quantity: 1 }] },
      customer.token
    );
    expect((f.data as { message: string }).message).toBe('admin only');

    const a = await rpc('adjust_inventory', { variant_id: teeId, delta: 10 }, customer.token);
    expect((a.data as { message: string }).message).toBe('admin only');
  });

  test('非 admin 不能写商品/折扣/运费', async () => {
    const r = await api('/rest/v1/products', {
      token: customer.token,
      method: 'POST',
      body: { slug: 'hack', name: 'hack' },
    });
    expect((r.data as { code: string }).code).toBe('42501');
  });
});

describe('发货（履约）', () => {
  test('即时订单也必须先支付再履约', async () => {
    const result = await rpc('create_fulfillment', { order_id: orderId, items: [{ order_item_id: orderItemId, quantity: 1 }] }, admin.token);
    expect(result.status).toBe(400);
    expect(result.data).toMatchObject({ message: 'order must be paid before fulfillment' });
  });

  test('mark_order_paid → paid + payments 记录 + 事件', async () => {
    const { data } = await rpc(
      'mark_order_paid',
      { order_id: orderId, provider: 'manual', provider_ref: 'CASH-001' },
      admin.token
    );
    expect((data as Record<string, unknown>).financial_status).toBe('paid');

    const { data: pays } = await api(
      `/rest/v1/payments?order_id=eq.${orderId}&select=provider,kind,status,amount`,
      { token: customer.token }
    );
    const p = (pays as Record<string, unknown>[])[0];
    expect(p.provider).toBe('manual');
    expect(p.kind).toBe('charge');
    expect(p.status).toBe('succeeded');
    expect(Number(p.amount)).toBeCloseTo(orderTotal);
  });

  test('超发被拒绝', async () => {
    const { data } = await rpc(
      'create_fulfillment',
      { order_id: orderId, items: [{ order_item_id: orderItemId, quantity: 4 }] }, // 只订了 3
      admin.token
    );
    expect((data as { message: string }).message).toContain('exceeds remaining');
  });

  test('不能发其他订单的 item', async () => {
    const { data: other } = await rpc(
      'create_order',
      { items: [{ variant_id: teeId, quantity: 1 }], address: TEST_ADDRESS },
      customer.token
    );
    const { data: otherItems } = await api(
      `/rest/v1/order_items?order_id=eq.${(other as { id: string }).id}&select=id`,
      { token: customer.token }
    );
    const otherItemId = (otherItems as { id: string }[])[0].id;

    const { data } = await rpc(
      'create_fulfillment',
      { order_id: orderId, items: [{ order_item_id: otherItemId, quantity: 1 }] },
      admin.token
    );
    expect((data as { message: string }).message).toContain('does not belong to this order');
  });

  test('部分发货 → partially_fulfilled', async () => {
    const { data } = await rpc(
      'create_fulfillment',
      {
        order_id: orderId,
        items: [{ order_item_id: orderItemId, quantity: 2 }],
        carrier: 'Example carrier',
        tracking_number: 'SF001',
      },
      admin.token
    );
    expect((data as Record<string, unknown>).status).toBe('shipped');

    const { data: o } = await api(`/rest/v1/orders?id=eq.${orderId}&select=fulfillment_status,status`, {
      token: customer.token,
    });
    expect((o as Record<string, unknown>[])[0].fulfillment_status).toBe('partially_fulfilled');
    expect((o as Record<string, unknown>[])[0].status).toBe('open'); // 尚未全部履约，不算完成
  });

  test('累计超发同样被拒绝（2 已发，再发 2 > 3）', async () => {
    const { data } = await rpc(
      'create_fulfillment',
      { order_id: orderId, items: [{ order_item_id: orderItemId, quantity: 2 }] },
      admin.token
    );
    expect((data as { message: string }).message).toContain('exceeds remaining');
  });

  test('已发货的订单不能取消、不能改地址', async () => {
    const c = await rpc('cancel_order', { order_id: orderId }, customer.token);
    expect((c.data as { message: string }).message).toContain('refund flow');

    const u = await rpc(
      'update_order_address',
      { order_id: orderId, address: TEST_ADDRESS },
      customer.token
    );
    expect((u.data as { message: string }).message).toContain('paid orders');
  });

  test('买家可读自己订单的物流信息', async () => {
    const { data } = await api(
      `/rest/v1/fulfillments?order_id=eq.${orderId}&select=carrier,tracking_number,status`,
      { token: customer.token }
    );
    const f = (data as Record<string, unknown>[])[0];
    expect(f.carrier).toBe('Example carrier');
    expect(f.tracking_number).toBe('SF001');
  });
});

describe('支付标记与订单完成', () => {
  test('payments.raw 对买家不可见', async () => {
    const { data } = await api(`/rest/v1/payments?order_id=eq.${orderId}&select=id,raw`, {
      token: customer.token,
    });
    expect((data as { code: string }).code).toBe('42501');
  });

  test('重复标记支付被拒绝', async () => {
    const { data } = await rpc('mark_order_paid', { order_id: orderId }, admin.token);
    expect((data as { message: string }).message).toContain('not pending');
  });

  test('已支付订单不能走 cancel，只能退款流程', async () => {
    const { data } = await rpc('cancel_order', { order_id: orderId }, customer.token);
    expect((data as { message: string }).message).toContain('refund flow');
  });

  test('发完剩余数量 → 已支付+已发完 → 自动 completed', async () => {
    await rpc(
      'create_fulfillment',
      { order_id: orderId, items: [{ order_item_id: orderItemId, quantity: 1 }], carrier: 'Example carrier', tracking_number: 'SF002' },
      admin.token
    );
    const { data } = await api(
      `/rest/v1/orders?id=eq.${orderId}&select=status,financial_status,fulfillment_status,completed_at`,
      { token: customer.token }
    );
    const o = (data as Record<string, unknown>[])[0];
    expect(o.fulfillment_status).toBe('fulfilled');
    expect(o.status).toBe('completed');
    expect(o.completed_at).not.toBeNull();
  });

  test('订单事件链完整', async () => {
    const { data } = await api(
      `/rest/v1/order_events?order_id=eq.${orderId}&select=type&order=id`,
      { token: customer.token }
    );
    expect((data as { type: string }[]).map((e) => e.type)).toEqual([
      'order_created',
      'payment_received',
      'fulfillment_created',
      'fulfillment_created',
    ]);
  });
});

describe('库存管理', () => {
  let teeStock = 0;

  test('adjust_inventory 入库并记流水', async () => {
    const before = await stockOf('TEE-BLK-S');
    teeStock = before + 10;
    const { data } = await rpc(
      'adjust_inventory',
      { variant_id: teeId, delta: 10, reason: 'restock', note: '补货' },
      admin.token
    );
    expect((data as { on_hand: number }).on_hand).toBe(teeStock);

    const { data: moves } = await api(
      `/rest/v1/inventory_movements?variant_id=eq.${teeId}&select=delta,on_hand_after,reason,note&order=id`,
      { service: true }
    );
    const rows = moves as Record<string, unknown>[];
    expect(rows.at(-1)).toMatchObject({ delta: 10, on_hand_after: teeStock, reason: 'restock', note: '补货' });
  });

  test('adjust_inventory 扣成负数被拒绝（约束兜底）', async () => {
    const { data } = await rpc(
      'adjust_inventory',
      { variant_id: teeId, delta: -99999, reason: 'adjust' },
      admin.token
    );
    expect((data as { code: string }).code).toBe('23514'); // check_violation
    expect(await stockOf('TEE-BLK-S')).toBe(teeStock); // 未变
  });

  test('delta 为 0 被拒绝', async () => {
    const { data } = await rpc(
      'adjust_inventory',
      { variant_id: teeId, delta: 0, reason: 'adjust' },
      admin.token
    );
    expect((data as { message: string }).message).toContain('non-zero');
  });
});
