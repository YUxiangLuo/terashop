import { beforeAll, describe, expect, test } from 'bun:test';
import {
  api, rpc, signup, makeAdmin, variantBySku, stockOf, CN_ADDRESS,
  type TestUser,
} from './helpers';

let admin: TestUser;
let customer: TestUser;
let mugId: string;
let cableId: string;
let keyboardId: string;

beforeAll(async () => {
  admin = await signup();
  customer = await signup();
  await makeAdmin(admin.userId);
  mugId = await variantBySku('MUG-350');
  cableId = await variantBySku('CABLE-1M');
  keyboardId = await variantBySku('KB87-RED');
});

describe('关键完整性：输入与 Storefront 可见性', () => {
  test('国家码统一大写，不能通过 cn 绕过 CN 税率', async () => {
    const { data } = await rpc('create_order', {
      items: [{ variant_id: mugId, quantity: 1 }],
      address: { ...CN_ADDRESS, country: 'cn' },
    }, customer.token);
    const order = data as { shipping_address: { country: string }; tax_total: number; total: number };
    expect(order.shipping_address.country).toBe('CN');
    expect(Number(order.tax_total)).toBeCloseTo(1.29);
    expect(Number(order.total)).toBeCloseTo(11.19);
  });

  test('非法国家码被拒绝', async () => {
    const { data } = await rpc('price_checkout', {
      items: [{ variant_id: mugId, quantity: 1 }],
      address: { country: 'CHINA' },
    });
    expect((data as { message: string }).message).toContain('invalid ISO country code');
  });

  test('草稿商品的变体和图片不对匿名 Storefront 泄漏', async () => {
    const suffix = crypto.randomUUID();
    const { data: products } = await api('/rest/v1/products?select=id', {
      service: true,
      method: 'POST',
      body: { slug: `draft-${suffix}`, name: '未发布商品', status: 'draft' },
    });
    const productId = (products as { id: string }[])[0].id;

    try {
      await api('/rest/v1/product_variants', {
        service: true,
        method: 'POST',
        body: { product_id: productId, sku: `DRAFT-${suffix}`, price: 123.45 },
      });
      await api('/rest/v1/product_images', {
        service: true,
        method: 'POST',
        body: { product_id: productId, url: 'https://private.invalid/draft.jpg' },
      });

      const variants = await api(`/rest/v1/product_variants?product_id=eq.${productId}&select=id,sku`);
      const images = await api(`/rest/v1/product_images?product_id=eq.${productId}&select=id,url`);
      expect(variants.data).toEqual([]);
      expect(images.data).toEqual([]);
    } finally {
      await api(`/rest/v1/products?id=eq.${productId}`, { service: true, method: 'DELETE' });
    }
  });

  test('Metafield 的类型必须与 definition 一致', async () => {
    const namespace = `probe_${crypto.randomUUID().replaceAll('-', '')}`;
    const { data: definitions } = await api('/rest/v1/metafield_definitions?select=id', {
      service: true,
      method: 'POST',
      body: {
        owner_type: 'product', namespace, key: 'score', name: '评分', type: 'number',
      },
    });
    const definitionId = (definitions as { id: string }[])[0].id;
    const { data: products } = await api('/rest/v1/products?slug=eq.ceramic-mug-350&select=id');
    const productId = (products as { id: string }[])[0].id;

    try {
      const { data } = await api('/rest/v1/metafields', {
        service: true,
        method: 'POST',
        body: {
          owner_type: 'product', owner_id: productId, namespace, key: 'score',
          type: 'text', value: 'not-a-number',
        },
      });
      expect((data as { message: string }).message).toContain('does not match definition type number');
    } finally {
      await api(`/rest/v1/metafield_definitions?id=eq.${definitionId}`, {
        service: true, method: 'DELETE',
      });
    }
  });
});

describe('关键完整性：订单、支付、履约与退款', () => {
  test('没有正运费时，独占免邮不能阻断后续真正生效的促销', async () => {
    const suffix = crypto.randomUUID();
    const { data: promotions } = await api('/rest/v1/promotions?select=id,name', {
      service: true,
      method: 'POST',
      body: [
        {
          name: `无效免邮-${suffix}`, type: 'free_shipping', params: {},
          priority: -100, stackable: false,
        },
        {
          name: `有效折扣-${suffix}`, type: 'order_percentage', params: { percent: 50 },
          priority: -90, stackable: false,
        },
      ],
    });
    const ids = (promotions as { id: string; name: string }[]).map((row) => row.id);

    try {
      const { data } = await rpc('price_checkout', {
        items: [{ variant_id: mugId, quantity: 1 }], address: CN_ADDRESS,
      });
      const quote = data as { promotions: { name: string }[]; discount_total: number };
      expect(quote.promotions.map((promotion) => promotion.name)).toEqual([`有效折扣-${suffix}`]);
      expect(Number(quote.discount_total)).toBeCloseTo(4.95);
    } finally {
      await api(`/rest/v1/promotions?id=in.(${ids.join(',')})`, {
        service: true, method: 'DELETE',
      });
    }
  });

  test('客户订单 RPC 不返回 admin_note', async () => {
    const { data: created } = await rpc('create_order', {
      items: [{ variant_id: mugId, quantity: 1 }], address: CN_ADDRESS,
    }, customer.token);
    const orderId = (created as { id: string }).id;

    await api(`/rest/v1/orders?id=eq.${orderId}`, {
      service: true, method: 'PATCH', body: { admin_note: '内部敏感备注' },
    });
    const { data } = await rpc('update_order_address', {
      order_id: orderId, address: { ...CN_ADDRESS, detail: '新地址 1 号' },
    }, customer.token);

    expect(Object.prototype.hasOwnProperty.call(data as object, 'admin_note')).toBe(false);
  });

  test('已支付订单不能通过修改地址直接改变总额', async () => {
    const { data: created } = await rpc('create_order', {
      items: [{ variant_id: mugId, quantity: 1 }], address: CN_ADDRESS,
    }, customer.token);
    const order = created as { id: string; total: number };
    await rpc('mark_order_paid', { order_id: order.id }, admin.token);

    const { data } = await rpc('update_order_address', {
      order_id: order.id,
      address: { receiver: 'John', phone: '1', country: 'US', detail: '1 Main St' },
    }, customer.token);
    expect((data as { message: string }).message).toContain('order edit adjustment');

    const { data: stored } = await api(`/rest/v1/orders?id=eq.${order.id}&select=total,financial_status`, {
      service: true,
    });
    expect(Number((stored as { total: number }[])[0].total)).toBeCloseTo(Number(order.total));
    expect((stored as { financial_status: string }[])[0].financial_status).toBe('paid');
  });

  test('同一履约 payload 的重复订单项先合并，不能超发', async () => {
    const owner = await signup();
    const { data: created } = await rpc('create_order', {
      items: [{ variant_id: mugId, quantity: 1 }], address: CN_ADDRESS,
    }, owner.token);
    const orderId = (created as { id: string }).id;
    const { data: lines } = await api(`/rest/v1/order_items?order_id=eq.${orderId}&select=id`, {
      token: owner.token,
    });
    const orderItemId = (lines as { id: string }[])[0].id;

    const { data } = await rpc('create_fulfillment', {
      order_id: orderId,
      items: [
        { order_item_id: orderItemId, quantity: 1 },
        { order_item_id: orderItemId, quantity: 1 },
      ],
    }, admin.token);
    expect((data as { message: string }).message).toContain('exceeds remaining');

    const mixedSign = await rpc('create_fulfillment', {
      order_id: orderId,
      items: [
        { order_item_id: orderItemId, quantity: 2 },
        { order_item_id: orderItemId, quantity: -1 },
      ],
    }, admin.token);
    expect((mixedSign.data as { message: string }).message).toContain('positive integer');

    const { data: fulfillments } = await api(`/rest/v1/fulfillments?order_id=eq.${orderId}&select=id`, {
      service: true,
    });
    expect(fulfillments).toEqual([]);
  });

  test('按行退款也不能突破剩余可退的成功收款额', async () => {
    const owner = await signup();
    const { data: created } = await rpc('create_order', {
      items: [{ variant_id: keyboardId, quantity: 1 }], address: CN_ADDRESS,
    }, owner.token);
    const order = created as { id: string; total: number };
    await rpc('mark_order_paid', { order_id: order.id }, admin.token);

    const { data: lines } = await api(
      `/rest/v1/order_items?order_id=eq.${order.id}&select=id,refunded_quantity`,
      { token: owner.token },
    );
    const lineId = (lines as { id: string }[])[0].id;
    const firstRefund = Number((Number(order.total) - 1).toFixed(2));

    await rpc('refund_order', { order_id: order.id, amount: firstRefund }, admin.token);
    const second = await rpc('refund_order', {
      order_id: order.id,
      items: [{ order_item_id: lineId, quantity: 1 }],
    }, admin.token);
    expect((second.data as { message: string }).message).toContain('exceeds captured amount');

    const { data: payments } = await api(
      `/rest/v1/payments?order_id=eq.${order.id}&kind=eq.refund&status=eq.succeeded&select=amount`,
      { service: true },
    );
    const refunded = (payments as { amount: number }[])
      .reduce((sum, payment) => sum + Number(payment.amount), 0);
    expect(refunded).toBeCloseTo(firstRefund);

    const { data: storedLine } = await api(
      `/rest/v1/order_items?id=eq.${lineId}&select=refunded_quantity`, { service: true },
    );
    expect((storedLine as { refunded_quantity: number }[])[0].refunded_quantity).toBe(0);
  });

  test('退款回补同样以原始扣减流水为准，不受当前 track_inventory 影响', async () => {
    const owner = await signup();
    let before = await stockOf('CABLE-1M');
    if (before < 2) {
      await rpc('adjust_inventory', {
        variant_id: cableId, delta: 5 - before, reason: 'restock', note: '退款测试补货',
      }, admin.token);
      before = await stockOf('CABLE-1M');
    }

    const { data: created } = await rpc('create_order', {
      items: [{ variant_id: cableId, quantity: 1 }], address: CN_ADDRESS,
    }, owner.token);
    const orderId = (created as { id: string }).id;
    await rpc('mark_order_paid', { order_id: orderId }, admin.token);
    const { data: lines } = await api(`/rest/v1/order_items?order_id=eq.${orderId}&select=id`, {
      token: owner.token,
    });
    const lineId = (lines as { id: string }[])[0].id;
    expect(await stockOf('CABLE-1M')).toBe(before - 1);

    await api(`/rest/v1/product_variants?id=eq.${cableId}`, {
      service: true, method: 'PATCH', body: { track_inventory: false },
    });
    try {
      const refunded = await rpc('refund_order', {
        order_id: orderId,
        items: [{ order_item_id: lineId, quantity: 1 }],
        restock: true,
      }, admin.token);
      expect(refunded.status).toBe(200);
      expect(await stockOf('CABLE-1M')).toBe(before);
    } finally {
      await api(`/rest/v1/product_variants?id=eq.${cableId}`, {
        service: true, method: 'PATCH', body: { track_inventory: true },
      });
    }
  });

  test('0 元订单可标记 paid，但不会产生 0 元 payment', async () => {
    const suffix = crypto.randomUUID();
    const { data: products } = await api('/rest/v1/products?slug=eq.ceramic-mug-350&select=id');
    const productId = (products as { id: string }[])[0].id;
    const { data: promotions } = await api('/rest/v1/promotions?select=id', {
      service: true,
      method: 'POST',
      body: {
        name: `全免探针-${suffix}`, type: 'item_percentage', params: { percent: 100 },
        priority: 1, stackable: false,
      },
    });
    const promotionId = (promotions as { id: string }[])[0].id;
    await api('/rest/v1/promotion_targets', {
      service: true, method: 'POST', body: { promotion_id: promotionId, product_id: productId },
    });

    try {
      const owner = await signup();
      const { data: created } = await rpc('create_order', {
        items: [{ variant_id: mugId, quantity: 1 }], address: CN_ADDRESS,
      }, owner.token);
      const order = created as { id: string; total: number };
      expect(Number(order.total)).toBe(0);

      const { data: paid } = await rpc('mark_order_paid', { order_id: order.id }, admin.token);
      expect((paid as { financial_status: string }).financial_status).toBe('paid');

      const { data: payments } = await api(`/rest/v1/payments?order_id=eq.${order.id}&select=id`, {
        service: true,
      });
      expect(payments).toEqual([]);
    } finally {
      // 订单快照仍引用促销，停用而不是删除。
      await api(`/rest/v1/promotions?id=eq.${promotionId}`, {
        service: true, method: 'PATCH', body: { is_active: false },
      });
    }
  });
});

describe('关键完整性：并发、库存和审计', () => {
  test('取消以原始扣减流水为准，不受当前 track_inventory 影响', async () => {
    const owner = await signup();
    let before = await stockOf('CABLE-1M');
    if (before < 2) {
      await rpc('adjust_inventory', {
        variant_id: cableId, delta: 5 - before, reason: 'restock', note: '完整性测试补货',
      }, admin.token);
      before = await stockOf('CABLE-1M');
    }
    const { data: created } = await rpc('create_order', {
      items: [{ variant_id: cableId, quantity: 1 }], address: CN_ADDRESS,
    }, owner.token);
    expect(await stockOf('CABLE-1M')).toBe(before - 1);

    await api(`/rest/v1/product_variants?id=eq.${cableId}`, {
      service: true, method: 'PATCH', body: { track_inventory: false },
    });
    try {
      await rpc('cancel_order', { order_id: (created as { id: string }).id }, owner.token);
      expect(await stockOf('CABLE-1M')).toBe(before);
    } finally {
      await api(`/rest/v1/product_variants?id=eq.${cableId}`, {
        service: true, method: 'PATCH', body: { track_inventory: true },
      });
    }
  });

  test('admin JWT 不能直接伪造库存审计流水', async () => {
    const { data: locations } = await api('/rest/v1/locations?is_default=eq.true&select=id', {
      service: true,
    });
    const { status, data } = await api('/rest/v1/inventory_movements', {
      token: admin.token,
      method: 'POST',
      body: {
        variant_id: mugId,
        location_id: (locations as { id: string }[])[0].id,
        delta: 999,
        on_hand_after: 999999,
        reason: 'adjust',
      },
    });
    expect(status).toBe(403);
    expect((data as { code: string }).code).toBe('42501');
  });

  test('即使 service role 也不能改写或删除已有审计事实', async () => {
    const { data: movements } = await api('/rest/v1/inventory_movements?select=id,delta&limit=1', {
      service: true,
    });
    const movement = (movements as { id: number; delta: number }[])[0];
    const movementUpdate = await api(`/rest/v1/inventory_movements?id=eq.${movement.id}`, {
      service: true, method: 'PATCH', body: { delta: movement.delta + 1 },
    });
    expect(movementUpdate.status).toBe(400);
    expect((movementUpdate.data as { message: string }).message).toContain('append-only');

    const { data: events } = await api('/rest/v1/order_events?select=id&limit=1', { service: true });
    const eventId = (events as { id: number }[])[0].id;
    const eventDelete = await api(`/rest/v1/order_events?id=eq.${eventId}`, {
      service: true, method: 'DELETE',
    });
    expect(eventDelete.status).toBe(400);
    expect((eventDelete.data as { message: string }).message).toContain('append-only');
  });

  test('并发设置默认地址后数据库中仍只有一个默认地址', async () => {
    const owner = await signup();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) => api('/rest/v1/addresses', {
        token: owner.token,
        method: 'POST',
        body: {
          ...CN_ADDRESS,
          receiver: `并发${index}`,
          detail: `并发地址${index}`,
          is_default: true,
        },
      })),
    );
    expect(results.every((result) => result.status === 201)).toBe(true);

    const { data } = await api('/rest/v1/addresses?select=is_default', { token: owner.token });
    const defaults = (data as { is_default: boolean }[]).filter((row) => row.is_default);
    expect(defaults.length).toBe(1);
  });

  test('两个 admin 并发降级不能把管理员数量降为 0', async () => {
    const first = await signup();
    const second = await signup();
    await makeAdmin(first.userId);
    await makeAdmin(second.userId);

    const { data: originalAdmins } = await api('/rest/v1/profiles?role=eq.admin&select=id', {
      service: true,
    });
    const originalIds = (originalAdmins as { id: string }[])
      .map((row) => row.id)
      .filter((id) => id !== first.userId && id !== second.userId);

    try {
      for (const id of originalIds) {
        await api(`/rest/v1/profiles?id=eq.${id}`, {
          service: true, method: 'PATCH', body: { role: 'customer' },
        });
      }

      const [a, b] = await Promise.all([
        rpc('set_user_role', { user_id: first.userId, role: 'customer' }, first.token),
        rpc('set_user_role', { user_id: second.userId, role: 'customer' }, second.token),
      ]);
      expect([a.status, b.status].filter((status) => status < 300).length).toBe(1);

      const { data: remaining } = await api('/rest/v1/profiles?role=eq.admin&select=id', {
        service: true,
      });
      expect((remaining as unknown[]).length).toBe(1);
    } finally {
      for (const id of originalIds) {
        await api(`/rest/v1/profiles?id=eq.${id}`, {
          service: true, method: 'PATCH', body: { role: 'admin' },
        });
      }
      await api(`/rest/v1/profiles?id=in.(${first.userId},${second.userId})`, {
        service: true, method: 'PATCH', body: { role: 'customer' },
      });
    }
  });
});
