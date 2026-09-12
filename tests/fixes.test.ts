import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  api, rpc, signup, makeAdmin, variantBySku, shippingByName, stockOf,
  TEST_ADDRESS, installTestTax, ANON_KEY, API, type TestUser,
} from './helpers';

// 深度审查修复的回归测试（20260829170005_fixes.sql）
// 注意：本文件在 orders/promotions 之前执行（字母序），所有副作用必须清理或恢复

let admin: TestUser;
let mugId: string;
let cableId: string;
let teeId: string;
let kbRedId: string;
let kbBrownId: string;

// 不带 Prefer: return=representation 的原生请求（列级权限收紧后，RETURNING * 会 403）
async function rawApi(path: string, opts: { token?: string; method: string; body?: unknown }) {
  const res = await fetch(`${API}${path}`, {
    method: opts.method,
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${opts.token ?? ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

async function createPromo(body: Record<string, unknown>): Promise<string> {
  const { data } = await api('/rest/v1/promotions?select=id', { service: true, method: 'POST', body });
  if (!Array.isArray(data)) throw new Error(`createPromo failed: ${JSON.stringify(data)}`);
  return (data as { id: string }[])[0].id;
}

async function deletePromo(id: string) {
  await api(`/rest/v1/promotions?id=eq.${id}`, { service: true, method: 'DELETE' });
}

async function promoUsedCount(code: string): Promise<number> {
  const { data } = await api(`/rest/v1/promotions?code=eq.${code}&select=used_count`, { service: true });
  return (data as { used_count: number }[])[0].used_count;
}

let removeTax: (() => Promise<void>) | undefined;
afterAll(async () => { await removeTax?.(); });
beforeAll(async () => {
  removeTax = await installTestTax();
  admin = await signup();
  await makeAdmin(admin.userId);
  mugId = await variantBySku('MUG-350');
  cableId = await variantBySku('CABLE-1M');
  teeId = await variantBySku('TEE-BLK-S');
  kbRedId = await variantBySku('KB87-RED');
  kbBrownId = await variantBySku('KB87-BROWN');
});

describe('修复：促销引擎边界与并发', () => {
  test('行级折扣钳制：60%+60% 叠加不超过行金额，税额不为负', async () => {
    const a = await createPromo({ name: '钳制A', type: 'item_percentage', params: { percent: 60 }, priority: 10, stackable: true });
    const b = await createPromo({ name: '钳制B', type: 'item_percentage', params: { percent: 60 }, priority: 11, stackable: true });
    const { data: prod } = await api('/rest/v1/products?slug=eq.ceramic-mug-350&select=id');
    for (const pid of [a, b]) {
      await api('/rest/v1/promotion_targets', {
        service: true, method: 'POST',
        body: { promotion_id: pid, product_id: (prod as { id: string }[])[0].id },
      });
    }

    const { data } = await rpc('price_checkout', {
      items: [{ variant_id: mugId, quantity: 1 }], address: { country: 'US' },
    });
    const p = data as {
      lines: { discount_total: number; line_total: number }[];
      discount_total: number; tax_total: number; total: number;
      promotions: { name: string; amount: number }[];
    };
    expect(Number(p.lines[0].discount_total)).toBeCloseTo(9.9);   // 钳制到行金额
    expect(Number(p.lines[0].line_total)).toBe(0);
    expect(Number(p.tax_total)).toBe(0);                            // 不再出现负税
    expect(Number(p.total)).toBe(0);
    // 第二个促销落账金额被修正为实际分摊（5.94 → 3.96）
    const amounts = p.promotions.map((x) => Number(x.amount)).sort();
    expect(amounts).toEqual([3.96, 5.94]);

    await deletePromo(a);
    await deletePromo(b);
  });

  test('BOGO 钳制：行已被其他促销折近满时，赠品折算不击穿行金额', async () => {
    const pid = await createPromo({
      name: '数据线8折', type: 'item_percentage', params: { percent: 80 }, priority: 50, stackable: true,
    });
    const { data: prod } = await api('/rest/v1/products?slug=eq.usb-c-cable-1m&select=id');
    await api('/rest/v1/promotion_targets', {
      service: true, method: 'POST',
      body: { promotion_id: pid, product_id: (prod as { id: string }[])[0].id },
    });

    // 数据线×2：8折后行余 1.96，BOGO 免 1 件需 4.90 → 免不起，不击穿
    const { data } = await rpc('price_checkout', {
      items: [{ variant_id: cableId, quantity: 2 }], address: { country: 'US' },
    });
    const p = data as {
      lines: { discount_total: number; line_total: number }[];
      promotions: { name: string }[];
    };
    expect(Number(p.lines[0].discount_total)).toBeCloseTo(7.84);
    expect(Number(p.lines[0].line_total)).toBeCloseTo(1.96);
    expect(p.promotions.map((x) => x.name)).toEqual(['数据线8折']);

    await deletePromo(pid);
  });

  test('buy_x_get_y 的 get_percent 超界被拒', async () => {
    const { data } = await api('/rest/v1/promotions', {
      service: true, method: 'POST',
      body: { name: 'bad-bogo', type: 'buy_x_get_y', params: { buy: 1, get: 1, get_percent: 150 } },
    });
    expect((data as { message: string }).message).toContain('get_percent');
  });

  test('促销码统一大写归一化：小写创建的码可用任意大小写命中', async () => {
    const pid = await createPromo({
      name: '大小写测试', code: 'mixcase25', type: 'order_percentage', params: { percent: 25 },
    });
    const { data: row } = await api(`/rest/v1/promotions?id=eq.${pid}&select=code`, { service: true });
    expect((row as { code: string }[])[0].code).toBe('MIXCASE25');

    const { data } = await rpc('price_checkout', {
      items: [{ variant_id: mugId, quantity: 1 }], address: { country: 'US' }, discount_code: 'MiXcAsE25',
    });
    expect(Number((data as { discount_total: number }).discount_total)).toBeCloseTo(2.48);

    await deletePromo(pid);
  });

  test('free_shipping(stackable=false) 是完整独占：阻止后续独占促销', async () => {
    const fs = await createPromo({ name: '独占免邮', type: 'free_shipping', params: {}, priority: 1, stackable: false });
    const ship = await shippingByName('Standard shipping');

    const { data } = await rpc('price_checkout', {
      items: [{ variant_id: teeId, quantity: 1 }], address: { country: 'US' }, shipping_method_id: ship,
    });
    const p = data as {
      promotions: { name: string }[]; discount_total: number; shipping_total: number;
    };
    // 服饰8折（同为独占）被免邮阻断
    expect(p.promotions.map((x) => x.name)).toEqual(['独占免邮']);
    expect(Number(p.discount_total)).toBe(0);
    expect(Number(p.shipping_total)).toBe(0);

    await deletePromo(fs);
  });

  test('free_shipping 反向：先算的独占促销也会阻断免邮', async () => {
    const fs = await createPromo({ name: '迟到的免邮', type: 'free_shipping', params: {}, priority: 200, stackable: false });
    const ship = await shippingByName('Standard shipping');

    const { data } = await rpc('price_checkout', {
      items: [{ variant_id: teeId, quantity: 1 }], address: { country: 'US' }, shipping_method_id: ship,
    });
    const p = data as {
      promotions: { name: string }[]; discount_total: number; shipping_total: number;
    };
    // 服饰8折（priority 100）先生效且独占 → 免邮被跳过，运费照收
    expect(p.promotions.map((x) => x.name)).toEqual(['服饰分类8折']);
    expect(Number(p.discount_total)).toBeCloseTo(3.98);
    expect(Number(p.shipping_total)).toBeCloseTo(8);

    await deletePromo(fs);
  });

  test('并发抢 usage_limit=1 的码：恰好一人成功', async () => {
    const pid = await createPromo({
      name: '并发抢码', code: 'RACE1', type: 'order_percentage', params: { percent: 10 }, usage_limit: 1,
    });
    const u1 = await signup();
    const u2 = await signup();
    // 关键：两人买【不同商品】，变体行锁不构成串行，考验的是促销行锁
    const [r1, r2] = await Promise.all([
      rpc('create_order', { items: [{ variant_id: kbRedId, quantity: 1 }], address: TEST_ADDRESS, discount_code: 'RACE1' }, u1.token),
      rpc('create_order', { items: [{ variant_id: mugId, quantity: 1 }], address: TEST_ADDRESS, discount_code: 'RACE1' }, u2.token),
    ]);
    const ok = [r1, r2].filter((r) => r.status < 300);
    const fail = [r1, r2].filter((r) => r.status >= 400);
    expect(ok.length).toBe(1);
    expect(fail.length).toBe(1);
    expect((fail[0].data as { message: string }).message).toContain('invalid or expired');
    expect(await promoUsedCount('RACE1')).toBe(1);

    await deletePromo(pid);
  });

  test('同用户并发用同码（每客限1）：恰好一单成功', async () => {
    const u = await signup();
    const [r1, r2] = await Promise.all([
      rpc('create_order', { items: [{ variant_id: kbRedId, quantity: 1 }], address: TEST_ADDRESS, discount_code: 'WELCOME10' }, u.token),
      rpc('create_order', { items: [{ variant_id: kbBrownId, quantity: 1 }], address: TEST_ADDRESS, discount_code: 'WELCOME10' }, u.token),
    ]);
    const ok = [r1, r2].filter((r) => r.status < 300);
    const fail = [r1, r2].filter((r) => r.status >= 400);
    expect(ok.length).toBe(1);
    expect((fail[0].data as { message: string }).message).toBe('discount code already used');
  });
});

describe('修复：管理端写路径收拢', () => {
  let orderId: string;

  beforeAll(async () => {
    const u = await signup();
    const { data: o } = await rpc('create_order', {
      items: [{ variant_id: mugId, quantity: 1 }], address: TEST_ADDRESS,
    }, u.token);
    orderId = (o as { id: string }).id;
  });

  test('admin 不能直改 orders 的金额/状态字段（42501）', async () => {
    const r = await rawApi(`/rest/v1/orders?id=eq.${orderId}`, {
      token: admin.token, method: 'PATCH', body: { total: 0.01, financial_status: 'paid' },
    });
    expect(r.status).toBe(403);
    expect((r.data as { code: string }).code).toBe('42501');

    // 未被改掉
    const { data } = await api(`/rest/v1/orders?id=eq.${orderId}&select=total,financial_status`, { service: true });
    const o = (data as { total: number; financial_status: string }[])[0];
    expect(Number(o.total)).toBeGreaterThan(1);
    expect(o.financial_status).toBe('pending');
  });

  test('admin 可以直改 admin_note（备注是允许直改的列）', async () => {
    const r = await rawApi(`/rest/v1/orders?id=eq.${orderId}`, {
      token: admin.token, method: 'PATCH', body: { admin_note: '客户要求延迟发货' },
    });
    expect(r.status).toBe(204);
    const { data } = await api(`/rest/v1/orders?id=eq.${orderId}&select=admin_note`, { service: true });
    expect((data as { admin_note: string }[])[0].admin_note).toBe('客户要求延迟发货');
  });

  test('admin 直插 payments / fulfillments 被拒（必须走 RPC）', async () => {
    const p = await rawApi('/rest/v1/payments', {
      token: admin.token, method: 'POST',
      body: { order_id: orderId, kind: 'charge', status: 'succeeded', amount: 1 },
    });
    expect(p.status).toBe(403);

    const f = await rawApi('/rest/v1/fulfillments', {
      token: admin.token, method: 'POST',
      body: { order_id: orderId, items: [{ order_item_id: '00000000-0000-0000-0000-000000000000', quantity: 999 }] },
    });
    expect(f.status).toBe(403);
  });

  test('admin 直改 inventory_levels 被拒（必须走 adjust_inventory 记流水）', async () => {
    const r = await rawApi(`/rest/v1/inventory_levels?variant_id=eq.${mugId}`, {
      token: admin.token, method: 'PATCH', body: { on_hand: 9999 },
    });
    expect(r.status).toBe(403);
  });
});

describe('修复：改地址重算税与运法校验', () => {
  test('有测试税率的 US → 未配置税率的 CA：税与 total 同步更新', async () => {
    const u = await signup();
    const { data: o } = await rpc('create_order', {
      items: [{ variant_id: mugId, quantity: 1 }], address: TEST_ADDRESS,
    }, u.token);
    const order = o as { id: string; tax_total: number; total: number };
    expect(Number(order.tax_total)).toBeCloseTo(1.29);   // 9.9 × 13%

    const { data: after } = await rpc('update_order_address', {
      order_id: order.id,
      address: { recipient_name: 'John', phone: '1', country: 'CA', line1: '1 Infinite Loop, CA' },
    }, u.token);
    const updated = after as { shipping_address: { country: string }; tax_total: number; total: number };
    expect(updated.shipping_address.country).toBe('CA');
    expect(Number(updated.tax_total)).toBe(0);           // 本测试未配置 CA 税率
    expect(Number(updated.total)).toBeCloseTo(9.9);      // 9.9 - 0 + 0 + 0
  });

  test('改地址后原运法不支持新国家 → 拒绝', async () => {
    const u = await signup();
    const intl = await shippingByName('Regional shipping');       // 仅 CA/JP/SG
    const { data: o } = await rpc('create_order', {
      items: [{ variant_id: mugId, quantity: 1 }],
      address: { recipient_name: 'John', phone: '1', country: 'CA', line1: '1 Infinite Loop' },
      shipping_method_id: intl,
    }, u.token);

    const { data } = await rpc('update_order_address', {
      order_id: (o as { id: string }).id, address: TEST_ADDRESS,
    }, u.token);
    expect((data as { message: string }).message).toBe('shipping method not available for this country');
  });

  test('税率可配置对运费计税（include_shipping）', async () => {
    const { data: created } = await api('/rest/v1/tax_rates?select=id', {
      service: true, method: 'POST',
      body: { name: '德国增值税', country: 'DE', rate: 0.19, include_shipping: true },
    });
    const rateId = (created as { id: string }[])[0].id;
    const ship = await shippingByName('Standard shipping');

    const { data } = await rpc('price_checkout', {
      items: [{ variant_id: mugId, quantity: 1 }],
      address: { recipient_name: 'Max', phone: '1', country: 'DE', line1: 'Berliner Str. 1' },
      shipping_method_id: ship,
    });
    const p = data as { shipping_total: number; tax_total: number; total: number };
    expect(Number(p.shipping_total)).toBeCloseTo(8);       // 9.9 < 99 不包邮
    expect(Number(p.tax_total)).toBeCloseTo(3.4);          // (9.9 + 8) × 19% = 3.40
    expect(Number(p.total)).toBeCloseTo(21.3);

    await api(`/rest/v1/tax_rates?id=eq.${rateId}`, { service: true, method: 'DELETE' });
  });
});

describe('修复：退款闭环', () => {
  let owner: TestUser;
  let orderId: string;
  let orderItemId: string;

  beforeAll(async () => {
    owner = await signup();
    // 马克杯×3：满3件7折 → line_total 20.79，税 2.70，total 23.49
    const { data: o } = await rpc('create_order', {
      items: [{ variant_id: mugId, quantity: 3 }], address: TEST_ADDRESS,
    }, owner.token);
    orderId = (o as { id: string }).id;
    const { data: items } = await api(`/rest/v1/order_items?order_id=eq.${orderId}&select=id`, { token: owner.token });
    orderItemId = (items as { id: string }[])[0].id;
    await rpc('mark_order_paid', { order_id: orderId, provider: 'manual' }, admin.token);
  });

  test('非 admin 不能退款', async () => {
    const { data } = await rpc('refund_order', { order_id: orderId }, owner.token);
    expect((data as { message: string }).message).toBe('admin only');
  });

  test('按行部分退款：金额按 line_total 比例，推進 partially_refunded', async () => {
    const { data } = await rpc('refund_order', {
      order_id: orderId, items: [{ order_item_id: orderItemId, quantity: 1 }], reason: '破损一件',
    }, admin.token);
    expect((data as { financial_status: string }).financial_status).toBe('partially_refunded');

    const { data: pays } = await api(
      `/rest/v1/payments?order_id=eq.${orderId}&kind=eq.refund&select=amount,status`, { service: true });
    expect(Number((pays as { amount: number }[])[0].amount)).toBeCloseTo(6.93);  // 20.79/3

    const { data: items } = await api(
      `/rest/v1/order_items?id=eq.${orderItemId}&select=refunded_quantity,refunded_amount`, { service: true });
    const it = (items as { refunded_quantity: number; refunded_amount: number }[])[0];
    expect(it.refunded_quantity).toBe(1);
    expect(Number(it.refunded_amount)).toBeCloseTo(6.93);
  });

  test('超量退同一行被拒', async () => {
    const { data } = await rpc('refund_order', {
      order_id: orderId, items: [{ order_item_id: orderItemId, quantity: 3 }], // 已退1，最多再退2
    }, admin.token);
    expect((data as { message: string }).message).toContain('exceeds refundable');
  });

  test('退完该行取剩余全部（无舍入误差）', async () => {
    await rpc('refund_order', {
      order_id: orderId, items: [{ order_item_id: orderItemId, quantity: 2 }],
    }, admin.token);
    const { data: items } = await api(
      `/rest/v1/order_items?id=eq.${orderItemId}&select=refunded_quantity,refunded_amount`, { service: true });
    const it = (items as { refunded_quantity: number; refunded_amount: number }[])[0];
    expect(it.refunded_quantity).toBe(3);
    expect(Number(it.refunded_amount)).toBeCloseTo(20.79);  // 6.93 + 13.86，行净额退尽
  });

  test('自定义金额超额被拒；退剩余差额 → refunded', async () => {
    const over = await rpc('refund_order', { order_id: orderId, amount: 999 }, admin.token);
    expect((over.data as { message: string }).message).toContain('exceeds refundable');

    // 行退款共 20.79，订单总额 23.49（含税 2.70）→ 剩余 2.70
    const { data } = await rpc('refund_order', { order_id: orderId, reason: '税费随退' }, admin.token);
    expect((data as { financial_status: string }).financial_status).toBe('refunded');

    // 已全额退款的订单不再可退（状态守卫先于余额检查触发）
    const again = await rpc('refund_order', { order_id: orderId }, admin.token);
    expect((again.data as { message: string }).message).toContain('not refundable');
  });

  test('restock=true 按原仓回补库存并记 return 流水', async () => {
    const before = await stockOf('MUG-350');
    const u = await signup();
    const { data: o } = await rpc('create_order', {
      items: [{ variant_id: mugId, quantity: 2 }], address: TEST_ADDRESS,
    }, u.token);
    const oid = (o as { id: string }).id;
    await rpc('mark_order_paid', { order_id: oid }, admin.token);
    const { data: items } = await api(`/rest/v1/order_items?order_id=eq.${oid}&select=id`, { token: u.token });

    await rpc('refund_order', {
      order_id: oid, items: [{ order_item_id: (items as { id: string }[])[0].id, quantity: 2 }],
      restock: true, reason: '七天无理由',
    }, admin.token);

    expect(await stockOf('MUG-350')).toBe(before);   // 下单扣2 → 退回补2
    const { data: moves } = await api(
      `/rest/v1/inventory_movements?order_id=eq.${oid}&reason=eq.return&select=delta`, { service: true });
    expect((moves as { delta: number }[])[0].delta).toBe(2);
  });

  test('未支付订单不能退款', async () => {
    const u = await signup();
    const { data: o } = await rpc('create_order', {
      items: [{ variant_id: mugId, quantity: 1 }], address: TEST_ADDRESS,
    }, u.token);
    const { data } = await rpc('refund_order', { order_id: (o as { id: string }).id }, admin.token);
    expect((data as { message: string }).message).toContain('not refundable');
  });
});

describe('修复：库存口径与回补仓', () => {
  test('in_stock 只看默认仓：非默认仓有货不算有货', async () => {
    // 探针商品：无任何库存行
    const { data: prod } = await api('/rest/v1/products?select=id', {
      service: true, method: 'POST',
      body: { slug: 'stock-probe', name: '库存探针', status: 'draft' },
    });
    const productId = (prod as { id: string }[])[0].id;
    const { data: variant } = await api('/rest/v1/product_variants?select=id', {
      service: true, method: 'POST',
      body: { product_id: productId, sku: 'PROBE-1', price: 1 },
    });
    const probeVariant = (variant as { id: string }[])[0].id;
    const published = await api(`/rest/v1/products?id=eq.${productId}`, {
      service: true, method: 'PATCH', body: { status: 'active' },
    });
    expect(published.status).toBe(200);

    const listing = async () => {
      const { data } = await api('/rest/v1/product_listing?slug=eq.stock-probe&select=in_stock');
      return (data as { in_stock: boolean }[])[0].in_stock;
    };
    expect(await listing()).toBe(false);

    // 非默认仓有货 → 仍 false（口径与下单扣减一致）
    const { data: loc } = await api('/rest/v1/locations?select=id', {
      service: true, method: 'POST', body: { code: 'WH-PROBE', name: '探针仓' },
    });
    const locId = (loc as { id: string }[])[0].id;
    await api('/rest/v1/inventory_levels', {
      service: true, method: 'POST', body: { variant_id: probeVariant, location_id: locId, on_hand: 10 },
    });
    expect(await listing()).toBe(false);

    // 默认仓有货 → true
    const { data: defLoc } = await api('/rest/v1/locations?is_default=eq.true&select=id', { service: true });
    await api('/rest/v1/inventory_levels', {
      service: true, method: 'POST',
      body: { variant_id: probeVariant, location_id: (defLoc as { id: string }[])[0].id, on_hand: 1 },
    });
    expect(await listing()).toBe(true);

    // 清理
    await api(`/rest/v1/inventory_levels?variant_id=eq.${probeVariant}`, { service: true, method: 'DELETE' });
    await api(`/rest/v1/locations?id=eq.${locId}`, { service: true, method: 'DELETE' });
    await api(`/rest/v1/products?id=eq.${productId}`, { service: true, method: 'DELETE' });
  });

  test('取消订单回补到【原始扣减仓】而非当前默认仓', async () => {
    const u = await signup();
    const { data: locs } = await api('/rest/v1/locations?select=id,code,is_default', { service: true });
    const whSh = (locs as { id: string; code: string }[]).find((l) => l.code === 'WH-SH')!;

    // 建仓 B 并放马克杯库存 10
    const { data: locB } = await api('/rest/v1/locations?select=id', {
      service: true, method: 'POST', body: { code: 'WH-B', name: '仓B' },
    });
    const locBId = (locB as { id: string }[])[0].id;
    await api('/rest/v1/inventory_levels', {
      service: true, method: 'POST', body: { variant_id: mugId, location_id: locBId, on_hand: 10 },
    });

    const levelAt = async (locId: string) => {
      const { data } = await api(
        `/rest/v1/inventory_levels?variant_id=eq.${mugId}&location_id=eq.${locId}&select=on_hand`,
        { service: true });
      return Number((data as { on_hand: number }[])[0].on_hand);
    };
    const setDefault = async (locId: string, on: boolean) => {
      await api(`/rest/v1/locations?id=eq.${locId}`, {
        service: true, method: 'PATCH', body: { is_default: on },
      });
    };

    try {
      // 切换默认仓到 B 后下单：从 B 扣减
      await setDefault(whSh.id, false);
      await setDefault(locBId, true);
      const { data: o } = await rpc('create_order', {
        items: [{ variant_id: mugId, quantity: 2 }], address: TEST_ADDRESS,
      }, u.token);
      expect(await levelAt(locBId)).toBe(8);

      // 默认仓切回 WH-SH 后取消：库存必须回补到 B 而不是 WH-SH
      await setDefault(locBId, false);
      await setDefault(whSh.id, true);
      await rpc('cancel_order', { order_id: (o as { id: string }).id }, u.token);
      expect(await levelAt(locBId)).toBe(10);

      const { data: moves } = await api(
        `/rest/v1/inventory_movements?order_id=eq.${(o as { id: string }).id}&reason=eq.cancel&select=location_id`,
        { service: true });
      expect((moves as { location_id: string }[])[0].location_id).toBe(locBId);
    } finally {
      // 无论成败都恢复默认仓，保护后续测试文件
      await setDefault(locBId, false);
      await setDefault(whSh.id, true);
    }

    // 清理仓 B
    await api(`/rest/v1/inventory_levels?location_id=eq.${locBId}`, { service: true, method: 'DELETE' });
    await api(`/rest/v1/locations?id=eq.${locBId}`, { service: true, method: 'DELETE' });
  });

  test('同一时刻只能有一个默认仓', async () => {
    const { data } = await api('/rest/v1/locations', {
      service: true, method: 'POST', body: { code: 'WH-DUP', name: '重复默认仓', is_default: true },
    });
    expect((data as { code: string }).code).toBe('23505');  // unique_violation
  });
});

describe('修复：扩展体系与账号安全', () => {
  test('metafield：list_text 元素类型校验', async () => {
    const { data } = await api('/rest/v1/metafields', {
      service: true, method: 'POST',
      body: { owner_type: 'shop', owner_id: '00000000-0000-0000-0000-000000000000',
              namespace: 'probe', key: 'bad_list', type: 'list_text', value: [1, 2, true] },
    });
    expect((data as { message: string }).message).toContain('elements must be strings');
  });

  test('metafield：date 格式校验', async () => {
    const bad = await api('/rest/v1/metafields', {
      service: true, method: 'POST',
      body: { owner_type: 'shop', owner_id: '00000000-0000-0000-0000-000000000000',
              namespace: 'probe', key: 'bad_date', type: 'date', value: 'not-a-date' },
    });
    expect((bad.data as { message: string }).message).toContain('invalid value');

    const ok = await api('/rest/v1/metafields', {
      service: true, method: 'POST',
      body: { owner_type: 'shop', owner_id: '00000000-0000-0000-0000-000000000000',
              namespace: 'probe', key: 'good_date', type: 'date', value: '2026-01-01' },
    });
    expect(Array.isArray(ok.data)).toBe(true);
    await api("/rest/v1/metafields?namespace=eq.probe&key=eq.good_date", { service: true, method: 'DELETE' });
  });

  test('metafield：definition.validations 真正执行（min/max/choices）', async () => {
    const { data: def } = await api('/rest/v1/metafield_definitions?select=id', {
      service: true, method: 'POST',
      body: { owner_type: 'variant', namespace: 'probe', key: 'score', name: '评分',
              type: 'number', validations: { min: 0, max: 10 } },
    });
    const defId = (def as { id: string }[])[0].id;

    const over = await api('/rest/v1/metafields', {
      service: true, method: 'POST',
      body: { owner_type: 'variant', owner_id: mugId, namespace: 'probe', key: 'score', type: 'number', value: 15 },
    });
    expect((over.data as { message: string }).message).toContain('must be <= 10');

    const ok = await api('/rest/v1/metafields', {
      service: true, method: 'POST',
      body: { owner_type: 'variant', owner_id: mugId, namespace: 'probe', key: 'score', type: 'number', value: 8 },
    });
    expect(Array.isArray(ok.data)).toBe(true);

    // choices 白名单
    await api('/rest/v1/metafield_definitions', {
      service: true, method: 'POST',
      body: { owner_type: 'product', namespace: 'probe', key: 'color_note', name: '颜色备注',
              type: 'text', validations: { choices: ['红', '蓝'] } },
    });
    const { data: prod } = await api('/rest/v1/products?slug=eq.ceramic-mug-350&select=id');
    const productId = (prod as { id: string }[])[0].id;
    const offList = await api('/rest/v1/metafields', {
      service: true, method: 'POST',
      body: { owner_type: 'product', owner_id: productId, namespace: 'probe', key: 'color_note', type: 'text', value: '绿' },
    });
    expect((offList.data as { message: string }).message).toContain('must be one of');

    // 清理（definition 删除不影响 metafield 行，先删值再删定义）
    await api('/rest/v1/metafields?namespace=eq.probe', { service: true, method: 'DELETE' });
    await api(`/rest/v1/metafield_definitions?id=eq.${defId}`, { service: true, method: 'DELETE' });
    await api("/rest/v1/metafield_definitions?namespace=eq.probe&key=eq.color_note", { service: true, method: 'DELETE' });
  });

  test('anonymize_user：清 PII、删地址与 customer 域 metafield', async () => {
    const u = await signup();
    await api('/rest/v1/addresses', { token: u.token, method: 'POST', body: TEST_ADDRESS });
    await api('/rest/v1/metafields', {
      token: admin.token, method: 'POST',
      body: { owner_type: 'customer', owner_id: u.userId, namespace: 'custom', key: 'vip', type: 'number', value: 1 },
    });

    // 非 admin 拒绝
    const deny = await rpc('anonymize_user', { p_user_id: u.userId }, u.token);
    expect((deny.data as { message: string }).message).toBe('admin only');

    const { data } = await rpc('anonymize_user', { p_user_id: u.userId }, admin.token);
    const p = data as { email: string; full_name: string; phone: string | null };
    expect(p.email).toBe('');
    expect(p.full_name).toBe('');
    expect(p.phone).toBeNull();

    const { data: addrs } = await api(
      `/rest/v1/addresses?customer_id=eq.${u.userId}&select=id`, { service: true });
    expect(addrs).toEqual([]);
    const { data: mfs } = await api(
      `/rest/v1/metafields?owner_type=eq.customer&owner_id=eq.${u.userId}&select=id`, { service: true });
    expect(mfs).toEqual([]);
  });

  // 放在本 describe 最后：会把其他 admin 降级，结束前恢复
  test('不能降级最后一个 admin', async () => {
    const solo = await signup();
    await makeAdmin(solo.userId);

    // 把除 solo 外的 admin 全部降级（service role 直改，不受 RPC 保护限制）
    const { data: admins } = await api('/rest/v1/profiles?role=eq.admin&select=id', { service: true });
    for (const a of admins as { id: string }[]) {
      if (a.id !== solo.userId) {
        await api(`/rest/v1/profiles?id=eq.${a.id}`, {
          service: true, method: 'PATCH', body: { role: 'customer' },
        });
      }
    }

    const { data } = await rpc('set_user_role', { user_id: solo.userId, role: 'customer' }, solo.token);
    expect((data as { message: string }).message).toBe('cannot demote the last admin');

    // 恢复本文件的 admin，保护同文件/跨文件后续测试
    const restore = await rpc('set_user_role', { user_id: admin.userId, role: 'admin' }, solo.token);
    expect((restore.data as { role: string }).role).toBe('admin');
  });
});

describe('修复：完整性约束', () => {
  test('分类不允许自环', async () => {
    const id = crypto.randomUUID();
    const { data } = await api('/rest/v1/categories', {
      service: true, method: 'POST',
      body: { id, slug: 'self-loop', name: '自环', parent_id: id },
    });
    expect((data as { code: string }).code).toBe('23514');  // check_violation
  });

  test('payments.amount 不允许负数（方向由 kind 表达）', async () => {
    const u = await signup();
    const { data: o } = await rpc('create_order', {
      items: [{ variant_id: mugId, quantity: 1 }], address: TEST_ADDRESS,
    }, u.token);
    const { data } = await api('/rest/v1/payments', {
      service: true, method: 'POST',
      body: { order_id: (o as { id: string }).id, kind: 'refund', status: 'succeeded', amount: -5 },
    });
    expect((data as { code: string }).code).toBe('23514');
  });
});
