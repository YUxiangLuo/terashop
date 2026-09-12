import { afterAll, beforeAll, expect, test } from 'bun:test';
import { api, rpc, signup, makeAdmin, type TestUser } from './helpers';
import { checked, paymentFixture, type PaymentFixture } from './payment-fixtures';
let admin: TestUser;
let fixture: PaymentFixture;
beforeAll(async () => {
  admin = await signup(); await makeAdmin(admin.userId); fixture = await paymentFixture(admin);
});
afterAll(async () => {
  if (fixture) await api(`/rest/v1/products?id=eq.${fixture.productId}`, {
    service: true, method: 'PATCH', body: { status: 'archived' },
  });
});

for (const status of ['approved', 'rejected']) {
  test(`普通客户 INSERT 评价不能指定 ${status} 绕过审核`, async () => {
    const owner = await signup();
    const id = crypto.randomUUID();
    const result = await api('/rest/v1/product_reviews', {
      token: owner.token, method: 'POST', body: { id, product_id: fixture.productId, rating: 5, status },
    });
    expect(result.status).toBe(403);
    expect(result.data).toMatchObject({ code: '42501' });
    expect((await api(`/rest/v1/product_reviews?id=eq.${id}`)).data).toEqual([]);
  });
}

test('默认/显式 pending 均可创建；只有审核后公开，作者编辑内容后重新待审', async () => {
  for (const explicit of [false, true]) {
    const owner = await signup();
    const [review] = await checked<Array<{ id: string; status: string }>>(api('/rest/v1/product_reviews', {
      token: owner.token, method: 'POST',
      body: { product_id: fixture.productId, rating: 5, ...(explicit ? { status: 'pending' } : {}) },
    }));
    expect(review.status).toBe('pending');
    expect((await api(`/rest/v1/product_reviews?id=eq.${review.id}`)).data).toEqual([]);
    expect((await api(`/rest/v1/product_reviews?id=eq.${review.id}`, {
      token: owner.token, method: 'PATCH', body: { status: 'approved' },
    })).status).toBe(403);
    await checked(rpc('moderate_review', { review_id: review.id, status: 'approved' }, admin.token));
    expect((await api(`/rest/v1/product_reviews?id=eq.${review.id}`)).data).toHaveLength(1);
    await checked(api(`/rest/v1/product_reviews?id=eq.${review.id}`, {
      token: owner.token, method: 'PATCH', body: { body: 'edited after approval' },
    }));
    expect((await api(`/rest/v1/product_reviews?id=eq.${review.id}`)).data).toEqual([]);
  }
});

test('评价 INSERT 仍限制归属和商品可见性；管理员保留受权写入能力', async () => {
  const owner = await signup(); const other = await signup();
  const [draft] = await checked<Array<{ id: string }>>(api('/rest/v1/products', {
    service: true, method: 'POST', body: { slug: `draft-${crypto.randomUUID()}`, name: 'draft', status: 'draft' },
  }));
  for (const body of [
    { product_id: fixture.productId, customer_id: other.customerId, rating: 5, status: 'pending' },
    { product_id: draft.id, rating: 5, status: 'pending' },
  ]) {
    expect((await api('/rest/v1/product_reviews', { token: owner.token, method: 'POST', body })).status).toBe(403);
  }
  expect((await api('/rest/v1/product_reviews', {
    method: 'POST', body: { product_id: fixture.productId, customer_id: owner.customerId, rating: 5 },
  })).status).toBe(401);
  const [approved] = await checked<Array<{ id: string }>>(api('/rest/v1/product_reviews', {
    token: admin.token, method: 'POST',
    body: { product_id: fixture.productId, customer_id: owner.customerId, rating: 5, status: 'approved' },
  }));
  expect((await api(`/rest/v1/product_reviews?id=eq.${approved.id}`)).data).toHaveLength(1);
});

test('owner 权限商品列表不泄露停用分类，重启分类后恢复展示', async () => {
  const [active, inactive] = await checked<Array<{ id: string; slug: string }>>(api('/rest/v1/categories', {
    service: true, method: 'POST', body: [
      { slug: `visible-${crypto.randomUUID()}`, name: 'visible', is_active: true },
      { slug: `hidden-${crypto.randomUUID()}`, name: 'hidden', is_active: false },
    ],
  }));
  await checked(api('/rest/v1/product_categories', {
    service: true, method: 'POST', body: [active, inactive].map(category => ({
      product_id: fixture.productId, category_id: category.id,
    })),
  }));
  const listing = async () => (await checked<Array<{ categories: string[] }>>(api(
    `/rest/v1/product_listing?id=eq.${fixture.productId}&select=categories`,
  )))[0].categories;
  try {
    expect(await listing()).toEqual([active.slug]);
    expect((await api(`/rest/v1/categories?id=eq.${inactive.id}`)).data).toEqual([]);
    await checked(api(`/rest/v1/categories?id=eq.${inactive.id}`, {
      service: true, method: 'PATCH', body: { is_active: true },
    }));
    expect(await listing()).toEqual([active.slug, inactive.slug].sort());
  } finally {
    await api(`/rest/v1/categories?id=in.(${active.id},${inactive.id})`, {
      service: true, method: 'PATCH', body: { is_active: false },
    });
  }
});
