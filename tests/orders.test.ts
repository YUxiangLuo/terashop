import { describe, test, expect, beforeAll, beforeEach, afterAll, afterEach } from 'bun:test';
import { Cleanup } from './support/cleanup';
import { promotionFixture } from './support/promotions';
import {
  api, rpc, signup, variantBySku, shippingByName, stockOf,
  TEST_ADDRESS, installTestTax, checked, type TestUser,
} from './helpers';

// seed 基准：CABLE-1M 5 件 / KB87-RED 20 件 / MUG-350 200 件
// 本文件显式安装虚构的 US 13% 测试税率；运费和商品价格均为 USD。
// 注意：库存断言一律用相对增量（before/after），不假设绝对值

let buyer: TestUser;
let stranger: TestUser;
let cableId: string;
let kbRedId: string;
let mugId: string;

let removeTax: (() => Promise<void>) | undefined;
afterAll(async () => { await removeTax?.(); });
beforeAll(async () => {
  removeTax = await installTestTax();
  cableId = await variantBySku('CABLE-1M');
  kbRedId = await variantBySku('KB87-RED');
  mugId = await variantBySku('MUG-350');
});

const resources = new Cleanup();
beforeEach(async () => {
  [buyer, stranger] = await Promise.all([signup(), signup()]);
  for (const owner of [buyer, stranger]) resources.defer(async () => {
    const rows = await checked<Array<{ id: string }>>(api('/rest/v1/orders?status=eq.open&financial_status=eq.pending&select=id', { token: owner.token }));
    for (const order of rows) await checked(rpc('cancel_order', { order_id: order.id }, owner.token));
  });
});
afterEach(() => resources.run());

describe('用户与地址', () => {
  test('注册自动创建 profile（含 email）', async () => {
    const { data } = await api('/rest/v1/profiles?select=email,role', { token: buyer.token });
    const p = (data as Record<string, unknown>[])[0];
    expect(p.email).toBe(buyer.email);
    expect(p.role).toBe('customer');
  });

  test('买家不能自己改 role（列级权限）', async () => {
    const { data } = await api(`/rest/v1/profiles?id=eq.${buyer.userId}`, {
      token: buyer.token,
      method: 'PATCH',
      body: { role: 'admin' },
    });
    expect((data as { code: string }).code).toBe('42501');

    // 确认没被改掉
    const { data: check } = await api('/rest/v1/profiles?select=role', { token: buyer.token });
    expect((check as { role: string }[])[0].role).toBe('customer');
  });

  test('地址 CRUD + customer_id 自动填充', async () => {
    const { data } = await api('/rest/v1/addresses?select=recipient_name,customer_id,is_default', {
      token: buyer.token,
      method: 'POST',
      body: { ...TEST_ADDRESS, is_default: true },
    });
    const a = (data as Record<string, unknown>[])[0];
    expect(a.customer_id).toBe(buyer.customerId);
    expect(a.is_default).toBe(true);
  });

  test('同一客户只允许一个默认地址', async () => {
    await checked(api('/rest/v1/addresses', { token: buyer.token, method: 'POST', body: { ...TEST_ADDRESS, is_default: true } }));
    await api('/rest/v1/addresses', {
      token: buyer.token,
      method: 'POST',
      body: { ...TEST_ADDRESS, recipient_name: '公司', is_default: true },
    });
    const { data } = await api('/rest/v1/addresses?select=recipient_name,is_default', {
      token: buyer.token,
    });
    const rows = data as { recipient_name: string; is_default: boolean }[];
    expect(rows.filter((r) => r.is_default)).toEqual([{ recipient_name: '公司', is_default: true }]);
  });

  test('买家读不到别人的地址', async () => {
    await checked(api('/rest/v1/addresses', { token: buyer.token, method: 'POST', body: TEST_ADDRESS }));
    const { data } = await api('/rest/v1/addresses?select=id', { token: stranger.token });
    expect(data).toEqual([]);
  });
});

describe('下单：金额计算', () => {
  test('完整链路：折扣 + 运费 + 税，金额分毫不差', async () => {
    const cableBefore = await stockOf('CABLE-1M');
    const kbBefore = await stockOf('KB87-RED');

    // 89 + 4.9 = 93.90 → 9折 -9.39 → 84.51 + 运费 8 + 税 84.51*13%=10.99 → 103.50
    const ship = await shippingByName('Standard shipping');
    const { data } = await rpc(
      'create_order',
      {
        idempotency_key: crypto.randomUUID(),
        items: [
          { variant_id: kbRedId, quantity: 1 },
          { variant_id: cableId, quantity: 1 },
        ],
        address: TEST_ADDRESS,
        shipping_method_id: ship,
        discount_code: 'WELCOME10',
        note: '请尽快发货',
      },
      buyer.token
    );
    const o = data as Record<string, unknown>;
    expect(o.status).toBe('open');
    expect(o.financial_status).toBe('pending');
    expect(o.fulfillment_status).toBe('unfulfilled');
    expect(Number(o.subtotal)).toBeCloseTo(93.9);
    expect(Number(o.discount_total)).toBeCloseTo(9.39);
    expect(Number(o.shipping_total)).toBeCloseTo(8.0);
    expect(Number(o.tax_total)).toBeCloseTo(10.99);
    expect(Number(o.total)).toBeCloseTo(103.5);
    expect(o.discount_code).toBe('WELCOME10');
    expect(o.shipping_method_name).toBe('Standard shipping');

    // 未支付订单只预占，不提前改变 on_hand。
    expect(await stockOf('CABLE-1M')).toBe(cableBefore);
    expect(await stockOf('KB87-RED')).toBe(kbBefore);

    // 库存流水已记录
    const { data: moves } = await api(
      `/rest/v1/inventory_movements?order_id=eq.${o.id}&select=delta,reason&order=id`,
      { service: true }
    );
    expect(moves).toEqual([]);

    // 订单明细快照
    const { data: items } = await api(
      `/rest/v1/order_items?order_id=eq.${o.id}&select=sku,name,unit_price,quantity&order=sku`,
      { token: buyer.token }
    );
    const rows = items as Record<string, unknown>[];
    expect(rows[0].sku).toBe('CABLE-1M');
    expect(Number(rows[0].unit_price)).toBeCloseTo(4.9);
    expect(rows[1].sku).toBe('KB87-RED');
  });

  test('重复变体行会被合并（不能拆分绕过库存校验）', async () => {
    const before = await stockOf('CABLE-1M');
    const { data } = await rpc(
      'create_order',
      {
        idempotency_key: crypto.randomUUID(),
        items: [
          { variant_id: cableId, quantity: 2 },
          { variant_id: cableId, quantity: 2 },
        ],
        address: TEST_ADDRESS,
      },
      buyer.token
    );
    const o = data as Record<string, unknown>;
    expect(Number(o.subtotal)).toBeCloseTo(19.6);
    expect(await stockOf('CABLE-1M')).toBe(before);

    // 明细合并为一行
    const { data: items } = await api(
      `/rest/v1/order_items?order_id=eq.${o.id}&select=quantity`,
      { token: buyer.token }
    );
    expect(items).toEqual([{ quantity: 4 }]);
  });

  test('超卖拦截：合并后的总量超过库存会被拒绝', async () => {
    const remaining = await stockOf('CABLE-1M');
    const half = Math.floor(remaining / 2) + 1; // 两份各 half，合计 > remaining
    const { data } = await rpc(
      'create_order',
      {
        idempotency_key: crypto.randomUUID(),
        items: [
          { variant_id: cableId, quantity: half },
          { variant_id: cableId, quantity: half },
        ],
        address: TEST_ADDRESS,
      },
      buyer.token
    );
    expect((data as { message: string }).message).toContain('insufficient available stock');
    expect(await stockOf('CABLE-1M')).toBe(remaining); // 未扣
  });

  test('事务回滚：部分失败不产生任何订单', async () => {
    const mugBefore = await stockOf('MUG-350');
    const before = await api('/rest/v1/orders?select=id', { token: buyer.token });
    const count = (before.data as unknown[]).length;

    await rpc(
      'create_order',
      {
        idempotency_key: crypto.randomUUID(),
        items: [
          { variant_id: mugId, quantity: 1 },
          { variant_id: cableId, quantity: 999999 }, // 必失败，整单回滚
        ],
        address: TEST_ADDRESS,
      },
      buyer.token
    );

    const after = await api('/rest/v1/orders?select=id', { token: buyer.token });
    expect((after.data as unknown[]).length).toBe(count);
    expect(await stockOf('MUG-350')).toBe(mugBefore);
  });

  test('满额包邮：折后满 99 运费为 0', async () => {
    // KB ×2 = 178 ≥ 99 → 免运费；税 178*0.13 = 23.14
    const ship = await shippingByName('Standard shipping');
    const { data } = await rpc(
      'create_order',
      { idempotency_key: crypto.randomUUID(), items: [{ variant_id: kbRedId, quantity: 2 }], address: TEST_ADDRESS, shipping_method_id: ship },
      buyer.token
    );
    const o = data as Record<string, unknown>;
    expect(Number(o.shipping_total)).toBe(0);
    expect(Number(o.tax_total)).toBeCloseTo(23.14);
    expect(Number(o.total)).toBeCloseTo(201.14);
  });

  test('运费国家限制 + 未配置税率的地址返回零税额', async () => {
    const intl = await shippingByName('Regional shipping');
    const bad = await rpc(
      'create_order',
      { idempotency_key: crypto.randomUUID(), items: [{ variant_id: mugId, quantity: 1 }], address: TEST_ADDRESS, shipping_method_id: intl },
      buyer.token
    );
    expect((bad.data as { message: string }).message).toContain('not available for this country');

    // CA 地址可以用；本测试未配置 CA 税率，因此计算值为 0（不代表税务豁免）。
    const ok = await rpc(
      'create_order',
      {
        idempotency_key: crypto.randomUUID(),
        items: [{ variant_id: mugId, quantity: 1 }],
        address: { recipient_name: 'John', phone: '123', country: 'CA', line1: '1 Infinite Loop' },
        shipping_method_id: intl,
      },
      buyer.token
    );
    const o = ok.data as Record<string, unknown>;
    expect(Number(o.tax_total)).toBe(0);
    expect(Number(o.total)).toBeCloseTo(39.9); // 9.9 + 30
  });

  test('无效变体 / 空 items / 缺地址都被拒绝', async () => {
    const bad1 = await rpc('create_order', { idempotency_key: crypto.randomUUID(),
      items: [{ variant_id: '00000000-0000-0000-0000-000000000000', quantity: 1 }],
      address: TEST_ADDRESS,
    }, buyer.token);
    expect((bad1.data as { message: string }).message).toContain('variant not available');

    const bad2 = await rpc('create_order', { idempotency_key: crypto.randomUUID(), items: [], address: TEST_ADDRESS }, buyer.token);
    expect((bad2.data as { message: string }).message).toContain('non-empty');

    const bad3 = await rpc('create_order', { idempotency_key: crypto.randomUUID(),
      items: [{ variant_id: mugId, quantity: 1 }],
      address: { phone: '1', country: 'US' },
    }, buyer.token);
    expect((bad3.data as { message: string }).message).toContain('recipient_name');
  });
});

describe('下单：折扣码', () => {
  test('低于门槛', async () => {
    const code = `MIN-${crypto.randomUUID()}`;
    await promotionFixture(resources, { name: '门槛测试码', code, type: 'order_percentage', params: { percent: 10, threshold: 100 } });
    const { data } = await rpc(
      'create_order',
      { idempotency_key: crypto.randomUUID(), items: [{ variant_id: mugId, quantity: 1 }], address: TEST_ADDRESS, discount_code: code },
      buyer.token
    );
    expect((data as { message: string }).message).toContain('minimum subtotal');
  });

  test('同一买家重复使用被拒绝（大小写不敏感）', async () => {
    // 独立建立兑换事实；其他测试的未付款订单会在 afterEach 取消。
    expect((await rpc('create_order', { idempotency_key: crypto.randomUUID(),
      items: [{ variant_id: kbRedId, quantity: 1 }], address: TEST_ADDRESS, discount_code: 'WELCOME10',
    }, buyer.token)).status).toBe(200);
    const { data } = await rpc(
      'create_order',
      { idempotency_key: crypto.randomUUID(), items: [{ variant_id: kbRedId, quantity: 1 }], address: TEST_ADDRESS, discount_code: 'welcome10' },
      buyer.token
    );
    expect((data as { message: string }).message).toBe('discount code already used');
  });

  test('不存在 / 过期的折扣码', async () => {
    const fake = await rpc(
      'create_order',
      { idempotency_key: crypto.randomUUID(), items: [{ variant_id: mugId, quantity: 1 }], address: TEST_ADDRESS, discount_code: 'FAKE' },
      buyer.token
    );
    expect((fake.data as { message: string }).message).toContain('invalid or expired');

    const code = `EXPIRED-${crypto.randomUUID()}`;
    await promotionFixture(resources, { name: '过期码', code, type: 'order_percentage', params: { percent: 50 }, ends_at: '2020-01-01T00:00:00Z' });
    const expired = await rpc(
      'create_order',
      { idempotency_key: crypto.randomUUID(), items: [{ variant_id: mugId, quantity: 1 }], address: TEST_ADDRESS, discount_code: code },
      buyer.token
    );
    expect((expired.data as { message: string }).message).toContain('invalid or expired');
  });

  test('折扣码不对外公开（匿名/买家只能看到自动促销，看不到码）', async () => {
    const anon = await api('/rest/v1/promotions?select=code');
    const rows = anon.data as { code: string | null }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.code === null)).toBe(true);

    const asBuyer = await api('/rest/v1/promotions?select=code', { token: buyer.token });
    expect((asBuyer.data as { code: string | null }[]).every((r) => r.code === null)).toBe(true);
  });

  test('取消订单释放折扣：used_count 回落且可再次使用', async () => {
    const code = `REL-${crypto.randomUUID()}`.toUpperCase();
    await promotionFixture(resources, { name: '释放测试', code, type: 'order_fixed', params: { amount: 5 } });
    const kbBefore = await stockOf('KB87-RED');

    const { data: o } = await rpc(
      'create_order',
      { idempotency_key: crypto.randomUUID(), items: [{ variant_id: kbRedId, quantity: 1 }], address: TEST_ADDRESS, discount_code: code },
      stranger.token
    );
    expect(Number((o as Record<string, unknown>).discount_total)).toBeCloseTo(5);

    const { data: cancelled } = await rpc(
      'cancel_order',
      { order_id: (o as { id: string }).id, reason: '改变主意' },
      stranger.token
    );
    expect((cancelled as Record<string, unknown>).status).toBe('cancelled');

    // used_count 回落；取消只释放 reservation，不产生库存流水。
    const { data: d } = await api(`/rest/v1/promotions?code=eq.${code}&select=used_count`, { service: true });
    expect((d as { used_count: number }[])[0].used_count).toBe(0);
    expect(await stockOf('KB87-RED')).toBe(kbBefore);

    const { data: moves } = await api(
      `/rest/v1/inventory_movements?order_id=eq.${(o as { id: string }).id}&reason=eq.cancel&select=delta`,
      { service: true }
    );
    expect(moves).toEqual([]);

    // 再次使用成功
    const { data: o2 } = await rpc(
      'create_order',
      { idempotency_key: crypto.randomUUID(), items: [{ variant_id: kbRedId, quantity: 1 }], address: TEST_ADDRESS, discount_code: code },
      stranger.token
    );
    expect((o2 as Record<string, unknown>).status).toBe('open');
  });
});

describe('取消订单', () => {
  test('重复取消报错', async () => {
    const { data: o } = await rpc(
      'create_order',
      { idempotency_key: crypto.randomUUID(), items: [{ variant_id: mugId, quantity: 1 }], address: TEST_ADDRESS },
      stranger.token
    );
    const id = (o as { id: string }).id;
    await rpc('cancel_order', { order_id: id }, stranger.token);
    const again = await rpc('cancel_order', { order_id: id }, stranger.token);
    expect((again.data as { message: string }).message).toContain('not open');
  });

  test('不能取消别人的订单', async () => {
    const { data: o } = await rpc(
      'create_order',
      { idempotency_key: crypto.randomUUID(), items: [{ variant_id: mugId, quantity: 1 }], address: TEST_ADDRESS },
      buyer.token
    );
    const { data } = await rpc('cancel_order', { order_id: (o as { id: string }).id }, stranger.token);
    expect((data as { message: string }).message).toBe('not allowed');
  });
});

describe('修改收货地址', () => {
  test('pending 快照不可改；引用别人地址簿仍不会穿透归属', async () => {
    const { data: o } = await rpc(
      'create_order',
      { idempotency_key: crypto.randomUUID(), items: [{ variant_id: mugId, quantity: 1 }], address: TEST_ADDRESS },
      buyer.token
    );
    const orderId = (o as { id: string }).id;

    // 用陌生人的 address_id 应失败
    const { data: strangerAddr } = await api('/rest/v1/addresses', {
      token: stranger.token,
      method: 'POST',
      body: TEST_ADDRESS,
    });
    const bad = await rpc(
      'update_order_address',
      { order_id: orderId, address_id: (strangerAddr as { id: string }[])[0].id },
      buyer.token
    );
    expect((bad.data as { message: string }).message).toBe('address not found');

    // 即使没有支付意图，快照也不可变；应取消并重新结账。
    const ok = await rpc(
      'update_order_address',
      { order_id: orderId, address: { ...TEST_ADDRESS, line1: '新地址 666 号' } },
      buyer.token
    );
    expect(ok.status).toBe(400);
    expect((ok.data as { message: string }).message).toContain('immutable');

    // 事件已记录
    const { data: events } = await api(
      `/rest/v1/order_events?order_id=eq.${orderId}&type=eq.address_updated&select=type`,
      { token: buyer.token }
    );
    expect((events as unknown[]).length).toBe(0);
    const [snapshot] = await checked<Array<{ shipping_address: { line1: string } }>>(api(`/rest/v1/orders?id=eq.${orderId}&select=shipping_address`, { token: buyer.token }));
    expect(snapshot.shipping_address.line1).toBe(TEST_ADDRESS.line1);
  });
});

describe('RLS 权限', () => {
  test('匿名读订单为空；买家直插订单被拒', async () => {
    const anon = await api('/rest/v1/orders?select=id');
    expect(anon.data).toEqual([]);

    const ins = await api('/rest/v1/orders', {
      token: buyer.token,
      method: 'POST',
      body: { customer_id: buyer.customerId, email: 'x@x.com', subtotal: 1, total: 1, shipping_address: {} },
    });
    expect((ins.data as { code: string }).code).toBe('42501');
  });

  test('买家读不到别人的订单与明细', async () => {
    const mine = await checked<{ id: string }>(rpc('create_order', { idempotency_key: crypto.randomUUID(),
      items: [{ variant_id: mugId, quantity: 1 }], address: TEST_ADDRESS,
    }, buyer.token));
    const otherId = mine.id;
    const asStranger = await api(`/rest/v1/orders?id=eq.${otherId}&select=id`, { token: stranger.token });
    expect(asStranger.data).toEqual([]);
    const items = await api(`/rest/v1/order_items?order_id=eq.${otherId}&select=id`, { token: stranger.token });
    expect(items.data).toEqual([]);
  });

  test('admin_note 列不可读', async () => {
    const { data } = await api('/rest/v1/orders?select=id,admin_note&limit=1', { token: buyer.token });
    expect((data as { code: string }).code).toBe('42501');
  });

  test('库存明细对买家不可见（只能用 product_listing.in_stock）', async () => {
    const { data } = await api('/rest/v1/inventory_levels?select=on_hand', { token: buyer.token });
    expect(data).toEqual([]);
  });

  test('未登录不能下单', async () => {
    const { status, data } = await rpc('create_order', { idempotency_key: crypto.randomUUID(),
      items: [{ variant_id: mugId, quantity: 1 }],
      address: TEST_ADDRESS,
    });
    expect(status).toBe(401);
    expect((data as { code: string }).code).toBe('42501');
  });
});
