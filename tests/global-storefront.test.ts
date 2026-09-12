import { afterAll, beforeAll, expect, test } from 'bun:test';
import { api, rpc, signup, variantBySku, shippingByName, TEST_ADDRESS, type TestUser } from './helpers';
import { checked } from './payment-fixtures';

let buyer: TestUser;
let variantId: string;
const orders: string[] = [];
beforeAll(async () => {
  buyer = await signup();
  variantId = await variantBySku('MUG-350');
});
afterAll(async () => {
  for (const id of orders) await rpc('cancel_order', { order_id: id }, buyer.token);
});
const items = () => [{ variant_id: variantId, quantity: 1 }];

test('单一 USD 与配送国家无关，seed 不暗中安装任何税率', async () => {
  expect(await checked<Array<{ id: string }>>(api('/rest/v1/tax_rates?is_active=eq.true&select=id', { service: true }))).toEqual([]);
  const [product] = await checked<Array<{ currency: string }>>(api('/rest/v1/product_listing?select=currency&limit=1'));
  expect(product.currency).toBe('USD');
  for (const country of ['US', 'GB', 'JP', 'HK', 'CN']) {
    const address = { recipient_name: 'Alex / 陳曉', country: country.toLowerCase(), line1: '12 Example Road', line2: 'Unit 4' };
    const quote = await checked<{ id: string; currency: string; tax_total: number }>(rpc('create_checkout_quote', {
      items: items(), address, idempotency_key: crypto.randomUUID(),
    }, buyer.token));
    expect(quote.currency).toBe('USD');
    expect(quote.tax_total).toBe(0);
    const order = await checked<{ id: string; currency: string; shipping_address: unknown }>(rpc('create_order_from_quote', {
      quote_id: quote.id,
    }, buyer.token));
    orders.push(order.id);
    expect(order.currency).toBe('USD');
    expect(order.shipping_address).toEqual({ ...address, country });
    await checked(rpc('cancel_order', { order_id: order.id }, buyer.token));
    orders.pop();
  }
});

test('地址簿与两种下单路径均不猜测国家，拒绝缺失/空白国家及非法地址字段', async () => {
  const { country: _country, ...withoutCountry } = TEST_ADDRESS;
  for (const address of [withoutCountry, { ...TEST_ADDRESS, country: '' }, { ...TEST_ADDRESS, country: null }]) {
    for (const command of ['create_order_v2', 'create_checkout_quote']) {
      const result = await rpc(command, {
        items: items(), address, idempotency_key: crypto.randomUUID(),
      }, buyer.token);
      expect(result.status).toBe(400);
      expect(result.data).toMatchObject({ message: expect.stringContaining('country') });
    }
    const direct = await rpc('create_order', { items: items(), address }, buyer.token);
    expect(direct.status).toBe(400);
    expect(direct.data).toMatchObject({ message: expect.stringContaining('country') });
    const inserted = await api('/rest/v1/addresses', { token: buyer.token, method: 'POST', body: address });
    expect(inserted.status).toBe(400);
  }
  for (const overrides of [{ recipient_name: 123 }, { line1: '   ' }, { line2: [] }, { region: {} }]) {
    const result = await rpc('create_order', { items: items(), address: { ...TEST_ADDRESS, ...overrides } }, buyer.token);
    expect(result.status).toBe(400);
  }
});

test('无地址只能预估商品价格，选择配送方式必须提供目的国家', async () => {
  const price = await checked<{ currency: string; tax_total: number }>(rpc('price_checkout', { items: items() }));
  expect(price.currency).toBe('USD');
  expect(price.tax_total).toBe(0);
  const shipping = await shippingByName('Standard shipping');
  const missing = await rpc('price_checkout', { items: items(), shipping_method_id: shipping });
  expect(missing.status).toBe(400);
  expect(missing.data).toMatchObject({ message: expect.stringContaining('destination country') });
});

test('通用地址行可经地址簿创建和编辑快照，电话/行政区/城市/邮编不强制填写', async () => {
  const input = { recipient_name: 'Alex Morgan', country: 'hk', line1: '12 Example Road', line2: 'Unit 7' };
  const [address] = await checked<Array<{ id: string; country: string; phone: null; region: null; city: null; postal_code: null }>>(api('/rest/v1/addresses', {
    token: buyer.token, method: 'POST', body: input,
  }));
  try {
    expect(address).toMatchObject({ country: 'HK', phone: null, region: null, city: null, postal_code: null });
    const order = await checked<{ id: string; shipping_address: Record<string, unknown> }>(rpc('create_order', {
      items: items(), address_id: address.id,
    }, buyer.token));
    orders.push(order.id);
    expect(order.shipping_address).toMatchObject({ ...input, country: 'HK' });
    await checked(api(`/rest/v1/addresses?id=eq.${address.id}`, {
      token: buyer.token, method: 'PATCH', body: { line2: 'Unit 8', region: null },
    }));
    const updated = await checked<{ shipping_address: Record<string, unknown> }>(rpc('update_order_address', {
      order_id: order.id, address_id: address.id,
    }, buyer.token));
    expect(updated.shipping_address.line2).toBe('Unit 8');
    const missingCountry = await rpc('update_order_address', {
      order_id: order.id, address: { recipient_name: 'Alex', line1: 'Another street' },
    }, buyer.token);
    expect(missingCountry.status).toBe(400);
  } finally {
    await checked(api(`/rest/v1/addresses?id=eq.${address.id}`, { token: buyer.token, method: 'DELETE' }));
  }
});

test('数据库拒绝非 USD 订单和支付，不能只靠 Edge 校验', async () => {
  const invalid = await api('/rest/v1/orders', {
    service: true, method: 'POST', body: {
      customer_id: buyer.customerId, email: buyer.email, currency: 'EUR',
      subtotal: 1, total: 1, shipping_address: TEST_ADDRESS,
    },
  });
  expect(invalid.status).toBe(400);
  expect(invalid.data).toMatchObject({ code: '23514', message: expect.stringContaining('orders_currency_usd_chk') });
  const order = await checked<{ id: string }>(rpc('create_order', { items: items(), address: TEST_ADDRESS }, buyer.token));
  orders.push(order.id);
  const payment = await api('/rest/v1/payments', {
    service: true, method: 'POST', body: {
      order_id: order.id, provider: 'manual', kind: 'charge', status: 'succeeded', amount: 1, currency: 'EUR',
    },
  });
  expect(payment.status).toBe(400);
  expect(payment.data).toMatchObject({ code: '23514', message: expect.stringContaining('payments_currency_check') });
});
