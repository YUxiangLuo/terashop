import { describe, test, expect, beforeAll } from 'bun:test';
import { api, rpc, signup, variantBySku, stockOf, CN_ADDRESS, type TestUser } from './helpers';

// seed 促销：
//   WELCOME10  输码 满50打9折（独占）
//   SAVE20     输码 满100减20（独占，限100次）
//   服饰分类8折      自动 item_percentage 20%，target=apparel 分类（独占）
//   马克杯满3件7折   自动 item_percentage 30% min_quantity=3，target=马克杯（独占）
//   数据线买一送一   自动 buy_x_get_y 1+1 free，target=数据线（独占）

let user: TestUser;
let cableId: string;
let mugId: string;
let teeId: string;
let kbId: string;

const preview = (items: unknown, extra: Record<string, unknown> = {}, token?: string) =>
  rpc('price_checkout', { items, ...extra }, token);

interface PriceResult {
  lines: { sku: string; quantity: number; unit_price: number; discount_total: number; line_total: number }[];
  subtotal: number;
  discount_total: number;
  promotions: { promotion_id: string; name: string; code: string | null; amount: number }[];
  shipping_total: number;
  tax_total: number;
  total: number;
}

async function createPromo(body: Record<string, unknown>): Promise<string> {
  const { data } = await api('/rest/v1/promotions?select=id', { service: true, method: 'POST', body });
  return (data as { id: string }[])[0].id;
}

async function deletePromo(id: string) {
  await api(`/rest/v1/promotions?id=eq.${id}`, { service: true, method: 'DELETE' });
}

async function promoUsedCount(name: string): Promise<number> {
  const { data } = await api(
    `/rest/v1/promotions?name=eq.${encodeURIComponent(name)}&select=used_count`,
    { service: true }
  );
  return (data as { used_count: number }[])[0].used_count;
}

beforeAll(async () => {
  user = await signup();
  cableId = await variantBySku('CABLE-1M');
  mugId = await variantBySku('MUG-350');
  teeId = await variantBySku('TEE-BLK-M');
  kbId = await variantBySku('KB87-RED');
});

describe('预览 price_checkout', () => {
  test('匿名可预览；只读——不建单、不扣库存、不占促销用量', async () => {
    const stockBefore = await stockOf('CABLE-1M');
    const usedBefore = await promoUsedCount('数据线买一送一');

    const { data } = (await preview([{ variant_id: cableId, quantity: 4 }])) as { data: PriceResult };
    expect(Number(data.discount_total)).toBeCloseTo(9.8);

    expect(await stockOf('CABLE-1M')).toBe(stockBefore);
    expect(await promoUsedCount('数据线买一送一')).toBe(usedBefore);
    const { data: orders } = await api('/rest/v1/orders?select=id', { token: user.token });
    expect(orders).toEqual([]);
  });

  test('买一送一阶梯：1件无优惠 / 3件免1 / 4件免2', async () => {
    const q1 = (await preview([{ variant_id: cableId, quantity: 1 }])).data as PriceResult;
    expect(Number(q1.discount_total)).toBe(0);
    expect(q1.promotions).toEqual([]);

    const q3 = (await preview([{ variant_id: cableId, quantity: 3 }])).data as PriceResult;
    expect(Number(q3.discount_total)).toBeCloseTo(4.9);
    expect(q3.promotions[0].name).toBe('数据线买一送一');

    const q4 = (await preview([{ variant_id: cableId, quantity: 4 }])).data as PriceResult;
    expect(Number(q4.discount_total)).toBeCloseTo(9.8);
  });

  test('满3件7折：2件不生效，3件生效（8.91 = 29.7×0.3）', async () => {
    const q2 = (await preview([{ variant_id: mugId, quantity: 2 }])).data as PriceResult;
    expect(q2.promotions).toEqual([]);

    const q3 = (await preview([{ variant_id: mugId, quantity: 3 }])).data as PriceResult;
    expect(Number(q3.discount_total)).toBeCloseTo(8.91);
    expect(q3.promotions[0].name).toBe('马克杯满3件7折');
    // 税基于折后金额：(29.7-8.91)*0.13 = 2.70
    expect(Number(q3.tax_total)).toBeCloseTo(2.7);
    expect(Number(q3.total)).toBeCloseTo(23.49);
  });

  test('分类促销命中 + 行级折扣分摊', async () => {
    const { data } = await preview([{ variant_id: teeId, quantity: 2 }]);
    const p = data as PriceResult;
    expect(Number(p.discount_total)).toBeCloseTo(7.96);
    expect(p.lines[0].discount_total).toBeCloseTo(7.96);
    expect(p.lines[0].line_total).toBeCloseTo(31.84);
  });

  test('分类促销对子分类商品生效（类目闭包）', async () => {
    // electronics 是 accessories 的父分类；数据线在 accessories
    const { data: cat } = await api("/rest/v1/categories?slug=eq.electronics&select=id");
    const pid = await createPromo({
      name: '数码半价', type: 'item_percentage', params: { percent: 50 }, stackable: true,
    });
    await api('/rest/v1/promotion_targets', {
      service: true, method: 'POST',
      body: { promotion_id: pid, category_id: (cat as { id: string }[])[0].id },
    });

    const { data } = await preview([{ variant_id: cableId, quantity: 1 }]);
    const p = data as PriceResult;
    // 数据线 qty=1 不触发 BOGO；数码半价命中
    expect(p.promotions.map((x) => x.name)).toEqual(['数码半价']);
    expect(Number(p.discount_total)).toBeCloseTo(2.45);

    await deletePromo(pid);
  });

  test('自动满减：按原始小计判断门槛', async () => {
    const pid = await createPromo({
      name: '满200减20', type: 'order_fixed', params: { threshold: 200, amount: 20 }, stackable: true,
    });

    const under = (await preview([{ variant_id: kbId, quantity: 2 }])).data as PriceResult; // 178
    expect(under.promotions).toEqual([]);

    const over = (await preview([{ variant_id: kbId, quantity: 3 }])).data as PriceResult; // 267
    expect(over.promotions.map((x) => x.name)).toEqual(['满200减20']);
    expect(Number(over.discount_total)).toBeCloseTo(20);

    await deletePromo(pid);
  });

  test('独占规则：先算的独占促销阻止后续促销', async () => {
    // TEE×3=59.7：WELCOME10（seed 更早）先算 → 5.97；服饰8折被阻止
    const { data } = await preview([{ variant_id: teeId, quantity: 3 }], { discount_code: 'WELCOME10' }, user.token);
    const p = data as PriceResult;
    expect(p.promotions.map((x) => x.code)).toEqual(['WELCOME10']);
    expect(Number(p.discount_total)).toBeCloseTo(5.97);
  });

  test('独占规则：低优先级输码促销被自动独占促销压制', async () => {
    const pid = await createPromo({
      name: '迟到的7折码', code: 'LATE30', type: 'order_percentage',
      params: { percent: 30 }, priority: 300, stackable: false,
    });
    // 数据线×4：BOGO（priority 100，独占）先生效 → LATE30 被跳过且不报错
    const { data } = await preview([{ variant_id: cableId, quantity: 4 }], { discount_code: 'LATE30' }, user.token);
    const p = data as PriceResult;
    expect(p.promotions.map((x) => x.name)).toEqual(['数据线买一送一']);
    expect(Number(p.discount_total)).toBeCloseTo(9.8);
    await deletePromo(pid);
  });

  test('可叠加促销按顺序累计：范围折后再算整单折', async () => {
    const a = await createPromo({
      name: '杯子9折', type: 'item_percentage', params: { percent: 10 }, priority: 50, stackable: true,
    });
    await api('/rest/v1/promotion_targets', {
      service: true,
      method: 'POST',
      body: {
        promotion_id: a,
        product_id: ((await api('/rest/v1/products?slug=eq.ceramic-mug-350&select=id')).data as { id: string }[])[0].id,
      },
    });
    const b = await createPromo({
      name: '全场95折', type: 'order_percentage', params: { percent: 5 }, priority: 60, stackable: true,
    });

    const { data } = await preview([{ variant_id: mugId, quantity: 1 }]);
    const p = data as PriceResult;
    // 9.9 → 9折 0.99 → 折后 8.91 → 95折 0.45
    expect(p.promotions.map((x) => x.name)).toEqual(['杯子9折', '全场95折']);
    expect(Number(p.discount_total)).toBeCloseTo(1.44);

    await deletePromo(a);
    await deletePromo(b);
  });

  test('无效码在预览中就报错；参数校验兜底', async () => {
    const bad = await preview([{ variant_id: mugId, quantity: 1 }], { discount_code: 'NOPE' }, user.token);
    expect((bad.data as { message: string }).message).toContain('invalid or expired');

    // params 校验：percent 超界
    const { data } = await api('/rest/v1/promotions', {
      service: true, method: 'POST',
      body: { name: 'bad', type: 'order_percentage', params: { percent: 120 } },
    });
    expect((data as { message: string }).message).toContain('percent');
  });

  test('BOGO 支持不同赠品范围（买A送B）', async () => {
    // 买键盘送数据线：buy 范围=键盘，get 范围=数据线
    const kbProduct = (
      (await api('/rest/v1/products?slug=eq.mechanical-keyboard-87&select=id')).data as { id: string }[]
    )[0].id;
    const cableProduct = (
      (await api('/rest/v1/products?slug=eq.usb-c-cable-1m&select=id')).data as { id: string }[]
    )[0].id;
    const pid = await createPromo({
      name: '买键盘送数据线', type: 'buy_x_get_y',
      params: { buy: 1, get: 1, get_percent: 100 }, stackable: true,
    });
    await api('/rest/v1/promotion_targets', {
      service: true, method: 'POST', body: { promotion_id: pid, role: 'apply', product_id: kbProduct },
    });
    await api('/rest/v1/promotion_targets', {
      service: true, method: 'POST', body: { promotion_id: pid, role: 'get', product_id: cableProduct },
    });

    const { data } = await preview([
      { variant_id: kbId, quantity: 1 },
      { variant_id: cableId, quantity: 1 },
    ]);
    const p = data as PriceResult;
    // 键盘 89 触发赠品资格，数据线 4.9 全免
    expect(p.promotions.map((x) => x.name)).toContain('买键盘送数据线');
    const cableLine = p.lines.find((l) => l.sku === 'CABLE-1M')!;
    expect(Number(cableLine.discount_total)).toBeCloseTo(4.9);
    const kbLine = p.lines.find((l) => l.sku === 'KB87-RED')!;
    expect(Number(kbLine.discount_total)).toBeCloseTo(0);

    await deletePromo(pid);
  });
});

describe('下单落账', () => {
  test('create_order 与预览价格一致，促销落账到 order_promotions 与行级分摊', async () => {
    // CABLE 被 orders.test.ts 消耗，落账测试用库存充足的马克杯（满3件7折）
    const usedBefore = await promoUsedCount('马克杯满3件7折');

    const previewRes = (await preview(
      [{ variant_id: mugId, quantity: 3 }], { address: CN_ADDRESS }, user.token
    )).data as PriceResult;

    const { data: order } = await rpc(
      'create_order',
      { items: [{ variant_id: mugId, quantity: 3 }], address: CN_ADDRESS },
      user.token
    );
    const o = order as Record<string, unknown>;

    // 预览价 = 实付价
    expect(Number(o.discount_total)).toBeCloseTo(Number(previewRes.discount_total));
    expect(Number(o.total)).toBeCloseTo(Number(previewRes.total));
    expect(Number(o.total)).toBeCloseTo(23.49); // 29.7 - 8.91 + 税2.70

    // order_promotions 快照
    const { data: ops } = await api(
      `/rest/v1/order_promotions?order_id=eq.${o.id}&select=name,amount`,
      { token: user.token }
    );
    expect(ops).toEqual([{ name: '马克杯满3件7折', amount: 8.91 }]);

    // 行级分摊 + generated line_total
    const { data: items } = await api(
      `/rest/v1/order_items?order_id=eq.${o.id}&select=quantity,total,discount_total,line_total`,
      { token: user.token }
    );
    expect(items).toEqual([{ quantity: 3, total: 29.7, discount_total: 8.91, line_total: 20.79 }]);

    // 自动促销用量 +1
    expect(await promoUsedCount('马克杯满3件7折')).toBe(usedBefore + 1);

    // 事件带促销快照
    const { data: events } = await api(
      `/rest/v1/order_events?order_id=eq.${o.id}&type=eq.order_created&select=data`,
      { token: user.token }
    );
    expect((events as { data: { promotions: unknown[] } }[])[0].data.promotions.length).toBe(1);

    // 取消后用量回落
    await rpc('cancel_order', { order_id: o.id, reason: '测试' }, user.token);
    expect(await promoUsedCount('马克杯满3件7折')).toBe(usedBefore);
  });

  test('输码型促销落账：redemption + 每客限一次仍然生效', async () => {
    const items = [{ variant_id: kbId, quantity: 2 }]; // 178 ≥ 100
    const { data: order } = await rpc(
      'create_order',
      { items, address: CN_ADDRESS, discount_code: 'SAVE20' },
      user.token
    );
    expect(Number((order as Record<string, unknown>).discount_total)).toBeCloseTo(20);

    // 再次使用被拒
    const again = await rpc(
      'create_order',
      { items, address: CN_ADDRESS, discount_code: 'SAVE20' },
      user.token
    );
    expect((again.data as { message: string }).message).toBe('discount code already used');
  });
});
