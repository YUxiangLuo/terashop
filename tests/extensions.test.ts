import { describe, test, expect, beforeAll } from 'bun:test';
import { api, rpc, signup, makeAdmin, variantBySku, TEST_ADDRESS, type TestUser } from './helpers';

let admin: TestUser;
let userA: TestUser;
let userB: TestUser;

beforeAll(async () => {
  admin = await signup();
  userA = await signup();
  userB = await signup();
  await makeAdmin(admin.userId);
});

describe('Metafields', () => {
  test('商品 metafield 公开可读（含定义）', async () => {
    const defs = await api('/rest/v1/metafield_definitions?owner_type=eq.product&select=namespace,key,name,type&order=position');
    expect((defs.data as unknown[]).length).toBe(3);

    const vals = await api(
      "/rest/v1/metafields?owner_type=eq.product&namespace=eq.specs&key=eq.size_guide&select=value"
    );
    const v = (vals.data as { value: string[] }[])[0];
    expect(v.value.length).toBe(3); // 引用 S/M/L 三条尺码表
  });

  test('类型校验：number 不能写字符串', async () => {
    const variantId = await variantBySku('MUG-350');
    const { data } = await api('/rest/v1/metafields', {
      service: true,
      method: 'POST',
      body: { owner_type: 'variant', owner_id: variantId, namespace: 'custom', key: 'weight_g', type: 'number', value: 'abc' },
    });
    expect((data as { message: string }).message).toContain('must be a number');
  });

  test('metaobject 引用校验：不存在的引用被拒绝', async () => {
    const { data: products } = await api('/rest/v1/products?slug=eq.ceramic-mug-350&select=id');
    const pid = (products as { id: string }[])[0].id;

    const { data } = await api('/rest/v1/metafields', {
      service: true,
      method: 'POST',
      body: {
        owner_type: 'product', owner_id: pid, namespace: 'specs', key: 'size_guide',
        type: 'list_metaobject_reference',
        value: ['00000000-0000-0000-0000-000000000000'],
      },
    });
    expect((data as { message: string }).message).toContain('metaobject not found');
  });

  test('非 uuid 的引用同样被拒绝', async () => {
    const { data: products } = await api('/rest/v1/products?slug=eq.ceramic-mug-350&select=id');
    const pid = (products as { id: string }[])[0].id;
    const { data } = await api('/rest/v1/metafields', {
      service: true,
      method: 'POST',
      body: {
        owner_type: 'product', owner_id: pid, namespace: 'specs', key: 'size_guide',
        type: 'list_metaobject_reference', value: ['not-a-uuid'],
      },
    });
    expect((data as { message: string }).message).toContain('invalid metaobject reference');
  });

  test('customer 域 metafield 仅本人和 admin 可见', async () => {
    await api('/rest/v1/metafields', {
      token: admin.token,
      method: 'POST',
      body: { owner_type: 'customer', owner_id: userA.customerId, namespace: 'custom', key: 'vip_level', type: 'number', value: 3 },
    });

    const asA = await api(
      `/rest/v1/metafields?owner_type=eq.customer&owner_id=eq.${userA.customerId}&select=value`,
      { token: userA.token }
    );
    expect((asA.data as { value: number }[])[0].value).toBe(3);

    const asB = await api(
      `/rest/v1/metafields?owner_type=eq.customer&owner_id=eq.${userA.customerId}&select=value`,
      { token: userB.token }
    );
    expect(asB.data).toEqual([]);

    const anon = await api(
      `/rest/v1/metafields?owner_type=eq.customer&owner_id=eq.${userA.customerId}&select=value`
    );
    expect(anon.data).toEqual([]);
  });

  test('order 域 metafield 仅订单归属人可见', async () => {
    const { data: o } = await rpc(
      'create_order',
      { items: [{ variant_id: await variantBySku('MUG-350'), quantity: 1 }], address: TEST_ADDRESS },
      userA.token
    );
    const orderId = (o as { id: string }).id;

    await api('/rest/v1/metafields', {
      token: admin.token,
      method: 'POST',
      body: { owner_type: 'order', owner_id: orderId, namespace: 'custom', key: 'gift_message', type: 'text', value: '生日快乐' },
    });

    const asOwner = await api(`/rest/v1/metafields?owner_type=eq.order&owner_id=eq.${orderId}&select=value`, { token: userA.token });
    expect((asOwner.data as { value: string }[])[0].value).toBe('生日快乐');

    const asOther = await api(`/rest/v1/metafields?owner_type=eq.order&owner_id=eq.${orderId}&select=value`, { token: userB.token });
    expect(asOther.data).toEqual([]);
  });

  test('非 admin 不能写 metafield', async () => {
    const { data } = await api('/rest/v1/metafields', {
      token: userA.token,
      method: 'POST',
      body: { owner_type: 'customer', owner_id: userA.customerId, namespace: 'x', key: 'y', type: 'text', value: 'z' },
    });
    expect((data as { code: string }).code).toBe('42501');
  });
});

describe('Metaobjects', () => {
  test('定义与条目公开可读', async () => {
    const defs = await api('/rest/v1/metaobject_definitions?select=type,name,fields');
    const def = (defs.data as Record<string, unknown>[])[0];
    expect(def.type).toBe('size_guide');
    expect((def.fields as { key: string }[]).map((f) => f.key)).toContain('bust_cm');

    const entries = await api('/rest/v1/metaobjects?select=handle,values&order=handle');
    const rows = entries.data as { handle: string; values: { size: string } }[];
    expect(rows.map((r) => r.handle)).toEqual(['l', 'm', 's']);
    expect(rows.find((r) => r.handle === 'm')!.values.size).toBe('M');
  });

  test('非 admin 不能创建 metaobject', async () => {
    const { data: defs } = await api('/rest/v1/metaobject_definitions?select=id');
    const { data } = await api('/rest/v1/metaobjects', {
      token: userA.token,
      method: 'POST',
      body: { definition_id: (defs as { id: string }[])[0].id, handle: 'xl', values: {} },
    });
    expect((data as { code: string }).code).toBe('42501');
  });
});

describe('商品评价', () => {
  let productId: string;

  beforeAll(async () => {
    const { data } = await api('/rest/v1/products?slug=eq.ceramic-mug-350&select=id');
    productId = (data as unknown as { id: string }[])[0].id;
  });

  test('顾客发表评价 → pending，公开不可见', async () => {
    const { status } = await api('/rest/v1/product_reviews', {
      token: userA.token,
      method: 'POST',
      body: { product_id: productId, rating: 5, title: '好用', body: '质感不错' },
    });
    expect(status).toBe(201);

    const pub = await api(`/rest/v1/product_reviews?product_id=eq.${productId}&select=id`);
    expect(pub.data).toEqual([]); // 匿名看不到 pending

    const own = await api(`/rest/v1/product_reviews?product_id=eq.${productId}&select=status,rating`, { token: userA.token });
    expect((own.data as Record<string, unknown>[])[0].status).toBe('pending');
  });

  test('每客每商品只能评一条', async () => {
    const { data } = await api('/rest/v1/product_reviews', {
      token: userA.token,
      method: 'POST',
      body: { product_id: productId, rating: 1, title: '刷评' },
    });
    expect((data as { code: string }).code).toBe('23505'); // unique_violation
  });

  test('顾客不能自己审核通过（列级权限），修改内容后回落 pending', async () => {
    // 试图直接改 status → 权限拒绝
    const hack = await api(`/rest/v1/product_reviews?product_id=eq.${productId}`, {
      token: userA.token,
      method: 'PATCH',
      body: { status: 'approved' },
    });
    expect((hack.data as { code: string }).code).toBe('42501');

    // 非 admin 调审核 RPC 也不行
    const { data: ownReview } = await api(
      `/rest/v1/product_reviews?product_id=eq.${productId}&select=id`,
      { token: userA.token }
    );
    const deny = await rpc(
      'moderate_review',
      { review_id: (ownReview as { id: string }[])[0].id, status: 'approved' },
      userA.token
    );
    expect((deny.data as { message: string }).message).toBe('admin only');

    // admin 通过 RPC 审核（列级权限对 admin JWT 同样生效，状态变更必须走 RPC）
    const { data: mine } = await api(
      `/rest/v1/product_reviews?product_id=eq.${productId}&select=id`,
      { token: userA.token }
    );
    const reviewId = (mine as { id: string }[])[0].id;
    const mod = await rpc('moderate_review', { review_id: reviewId, status: 'approved' }, admin.token);
    expect((mod.data as { status: string }).status).toBe('approved');
    const pub = await api(`/rest/v1/product_reviews?product_id=eq.${productId}&select=rating`);
    expect((pub.data as { rating: number }[])[0].rating).toBe(5);

    // 作者修改内容 → 自动回落 pending，公开又不可见
    await api(`/rest/v1/product_reviews?product_id=eq.${productId}`, {
      token: userA.token,
      method: 'PATCH',
      body: { body: '补充：用了一周依然很好' },
    });
    const after = await api(`/rest/v1/product_reviews?product_id=eq.${productId}&select=id`);
    expect(after.data).toEqual([]);

    const own = await api(`/rest/v1/product_reviews?product_id=eq.${productId}&select=status,body`, { token: userA.token });
    expect((own.data as Record<string, unknown>[])[0].status).toBe('pending');
  });

  test('评分范围校验', async () => {
    const { data } = await api('/rest/v1/product_reviews', {
      token: userB.token,
      method: 'POST',
      body: { product_id: productId, rating: 6 },
    });
    expect((data as { code: string }).code).toBe('23514'); // check_violation
  });
});
