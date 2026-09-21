import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { api, rpc, signup, makeAdmin, stockOf, TEST_ADDRESS, type TestUser } from './helpers';
import { checked, paymentFixture, fixtureIntent, settleIntent, paymentEvent, type PaymentFixture, type FixtureOrder } from './payment-fixtures';
import { heldTransactionRace, staleAfterCommit, testDatabase } from './database-concurrency';
import { paymentRequest, withPaymentProviderMock } from './payment-handler-harness';
import { handlePayPalCreateRefund } from '../supabase/functions/paypal-create-refund/handler';
import { AdminBackend } from '../mcp/src/backend';
import { API, ANON_KEY } from './helpers';
import { mcpSession, toolData } from './support/mcp';

interface Tax { id: string; tax_rate_id: string; name: string; country: string; rate: number; taxable_amount: number; amount: number }
interface Allocation { promotion_id: string; label: string; amount: number }
interface Line { id: string; variant_id: string; line_key: string; quantity: number; attributes: Record<string, string>; total: number; discount_total: number; line_total: number; tax_lines: Tax[]; discount_allocations: Allocation[] }
interface Shipping { id: string; name: string; shipping_method_id: string; gross_amount: number; discount_total: number; threshold_discount: number; total: number; tax_lines: Tax[]; discount_allocations: Allocation[]; policy: object }
interface Price {
  id: string; lines: Line[]; shipping_line: Shipping | null; promotions: Array<{ promotion_id: string; amount: number; snapshot: object }>;
  subtotal: number; discount_total: number; shipping_total: number; tax_total: number; total: number;
  tax_context: { status: string; destination_country: string | null; rule: { rate: number } | null };
}
interface Component { kind: 'tax' | 'shipping' | 'unallocated'; amount: number; tax_line_id: string | null; shipping_line_id: string | null }
interface Refund { id: string; amount: number; source: string; components: Component[]; lines: Array<{ order_item_id: string; quantity: number; amount: number }> }
interface Request extends Refund { parent_provider_reference: string; currency: string }
interface Ledger { refunds: Refund[]; balances: { is_balanced: boolean; captured: number; refunded: number; net_paid: number } }
const database = testDatabase();
let admin: TestUser, buyer: TestUser, other: TestUser;
let fixture: PaymentFixture, second: PaymentFixture;
let taxId: string, shippingId: string, thresholdId: string, promoId: string;
const code = `DETAIL-${crypto.randomUUID()}`, freeCode = `FREE-${crypto.randomUUID()}`, tinyCode = `TINY-${crypto.randomUUID()}`;
const cleanup: Array<[string, string]> = [];
const address = { ...TEST_ADDRESS, country: 'AQ' }; // Fictional test rate; not a tax-law fixture.
const cents = (amount: number) => Math.round(Number(amount) * 100);
const sum = (rows: Array<{ amount: number }>) => rows.reduce((n, row) => n + cents(row.amount), 0);
const patch = (table: string, id: string, body: object) => checked(api(`/rest/v1/${table}?id=eq.${id}`, { service: true, method: 'PATCH', body }));
async function insert(table: string, body: object): Promise<string> {
  const [row] = await checked<Array<{ id: string }>>(api(`/rest/v1/${table}?select=id`, { service: true, method: 'POST', body }));
  cleanup.push([table, row.id]); return row.id;
}
beforeAll(async () => {
  admin = await signup(); buyer = await signup(); other = await signup(); await makeAdmin(admin.userId);
  fixture = await paymentFixture(admin); second = await paymentFixture(admin);
  taxId = await insert('tax_rates', { name: 'Fictional breakdown rate', country: 'AQ', rate: 0.13, include_shipping: true });
  shippingId = await insert('shipping_methods', { name: 'Breakdown shipping', price: 8, countries: ['AQ', 'GB'] });
  thresholdId = await insert('shipping_methods', { name: 'Threshold shipping', price: 8, free_above: 10, countries: ['AQ'] });
  promoId = await insert('promotions', { name: 'Breakdown discount', code, type: 'order_fixed', params: { amount: 1 }, stackable: true });
  await insert('promotions', { name: 'Shipping promotion', code: freeCode, type: 'free_shipping', params: {}, stackable: true });
  await insert('promotions', { name: 'Tiny allocation', code: tinyCode, type: 'order_fixed', params: { amount: 0.01 }, stackable: true });
});
beforeEach(async () => { buyer = await signup(); });
afterAll(async () => {
  for (const [table, id] of cleanup) await patch(table, id, { is_active: false });
  for (const f of [fixture, second]) if (f) await patch('products', f.productId, { status: 'archived' });
  await database.close();
});
const input = (overrides: object = {}) => ({
  items: ['Alice', 'Bob'].map(engraving => ({ variant_id: fixture.variantId, quantity: 1, attributes: { engraving } })),
  address, shipping_method_id: shippingId, discount_code: code, ...overrides,
});
const preview = (overrides: object = {}) => checked<Price>(rpc('price_checkout', input(overrides), buyer.token));
const pricing = (id: string) => checked<Price>(rpc('get_order_pricing', { order_id: id }, buyer.token));
const ledger = async (id: string) => {
  const expected = await checked<Ledger>(rpc('get_order_ledger', { order_id: id }, buyer.token));
  const session = await mcpSession(new AdminBackend({ url: API, anonKey: ANON_KEY, accessToken: admin.token }));
  try {
    const actual = await toolData<Ledger>(session.client, 'get_order_ledger', { order_id: id });
    expect(actual).toEqual(expected);
    return actual;
  } finally { await session.close(); }
};
async function create(quoted = true, overrides: object = {}): Promise<FixtureOrder> {
  const quote = quoted ? await checked<Price>(rpc('create_checkout_quote', { ...input(overrides), idempotency_key: crypto.randomUUID() }, buyer.token)) : null;
  const order = await checked<FixtureOrder>(quoted ? rpc('create_order_from_quote', { quote_id: quote!.id }, buyer.token) : rpc('create_order', { ...input(overrides), idempotency_key: crypto.randomUUID() }, buyer.token));
  return { ...order, itemId: (await pricing(order.id)).lines[0].id, quoteId: quote?.id ?? null };
}
const paid = async (online = false, overrides: object = {}) => {
  const order = await create(true, overrides);
  if (online) await settleIntent(await fixtureIntent(order, buyer));
  else await checked(rpc('mark_order_paid', { idempotency_key: crypto.randomUUID(), order_id: order.id }, admin.token));
  return order;
};
const requestRefund = (id: string, args: object) => rpc('create_refund_request', {
  order_id: id, actor_id: admin.userId, provider: 'paypal', idempotency_key: crypto.randomUUID(), ...args,
}, undefined, true);
async function complete(request: Request): Promise<void> {
  const reference = `REFUND${request.id.replaceAll('-', '')}`;
  await checked(rpc('bind_refund_request_provider', {
    refund_request_id: request.id, provider_reference: reference, provider_status: 'pending', amount: request.amount, currency: request.currency,
  }, undefined, true));
  for (let i = 0; i < 2; i++) {
    const event = await paymentEvent('paypal', 'PAYMENT.REFUND.COMPLETED', reference, {
      object_type: 'refund', status: 'completed', amount: Number(request.amount).toFixed(2), currency: request.currency,
      capture_reference: request.parent_provider_reference,
    });
    expect(event.status).toBe('processed');
  }
}
function conserved(p: Price): void {
  expect(p.lines.reduce((n, l) => n + cents(l.total), 0)).toBe(cents(p.subtotal));
  expect(p.lines.reduce((n, l) => n + sum(l.discount_allocations), 0)).toBe(cents(p.discount_total));
  const shipping = p.shipping_line;
  expect(cents(shipping?.total ?? 0)).toBe(cents(p.shipping_total));
  if (shipping) {
    expect(sum(shipping.discount_allocations) + cents(shipping.threshold_discount)).toBe(cents(shipping.discount_total));
    expect(cents(shipping.gross_amount) - cents(shipping.discount_total)).toBe(cents(shipping.total));
  }
  expect(p.lines.reduce((n, l) => n + sum(l.tax_lines), sum(shipping?.tax_lines ?? []))).toBe(cents(p.tax_total));
  expect(cents(p.subtotal) - cents(p.discount_total) + cents(p.shipping_total) + cents(p.tax_total)).toBe(cents(p.total));
  for (const promo of p.promotions) expect(sum([
    ...p.lines.flatMap(l => l.discount_allocations), ...shipping?.discount_allocations ?? [],
  ].filter(a => a.promotion_id === promo.promotion_id))).toBe(cents(promo.amount));
}

test('税计算区分无目的地、无规则与显式零税率，不把零税额解释为免税证明', async () => {
  const absent = await preview({ address: null, shipping_method_id: null });
  expect(absent.tax_context).toMatchObject({ status: 'not_calculated', destination_country: null, rule: null });
  const noRule = await preview({ address: { ...address, country: 'GB' } });
  expect(noRule.tax_context).toMatchObject({ status: 'no_rule', destination_country: 'GB', rule: null });
  expect(noRule.lines.every(l => l.tax_lines.length === 0)).toBe(true);
  await patch('tax_rates', taxId, { include_shipping: false });
  try {
    const excluded = await preview(); conserved(excluded);
    expect(excluded.shipping_line!.tax_lines).toEqual([]);
  } finally { await patch('tax_rates', taxId, { include_shipping: true }); }
  await patch('tax_rates', taxId, { rate: 0 });
  try {
    const zero = await preview(); conserved(zero);
    expect(zero.tax_context).toMatchObject({ status: 'calculated', rule: { rate: 0 } });
    expect(zero.lines.every(l => l.tax_lines.length === 1 && l.tax_lines[0].amount === 0)).toBe(true);
  } finally { await patch('tax_rates', taxId, { rate: 0.13 }); }
});

test('国家专用税率优先于 wildcard，回退时保存实际匹配规则而非伪造国家规则', async () => {
  const fallback = await insert('tax_rates', { name: 'Fictional fallback', country: '*', rate: 0.07 });
  try {
    expect((await preview()).tax_context.rule).toMatchObject({ tax_rate_id: taxId, country: 'AQ', rate: 0.13 });
    const p = await preview({ address: { ...address, country: 'GB' } }); conserved(p);
    expect(p.tax_context).toMatchObject({ destination_country: 'GB', rule: { tax_rate_id: fallback, country: '*', rate: 0.07 } });
  } finally { await patch('tax_rates', fallback, { is_active: false }); }
});

for (const quoted of [false, true]) test(`${quoted ? 'Quote' : '即时订单'} 保存逐商业行优惠、税和配送净额，所有汇总守恒`, async () => {
  const expected = await preview(); conserved(expected);
  const order = await create(quoted);
  try {
    const actual = await pricing(order.id); conserved(actual);
    const session = await mcpSession(new AdminBackend({ url: API, anonKey: ANON_KEY, accessToken: admin.token }));
    try {
      expect(await toolData<Price>(session.client, 'get_order_pricing', { order_id: order.id })).toEqual(actual);
      const detail = await toolData<{ pricing: Price }>(session.client, 'get_admin_order', { order_id: order.id });
      expect(detail.pricing).toEqual(actual);
    } finally { await session.close(); }
    expect(actual.total).toBe(expected.total);
    expect(actual.tax_context).toEqual(expected.tax_context);
    expect(actual.promotions).toEqual(expected.promotions);
    for (const line of actual.lines) {
      const original = expected.lines.find(l => l.line_key === line.line_key)!;
      expect(line.discount_allocations).toEqual(original.discount_allocations);
      expect(line.tax_lines.map(({ id: _id, ...tax }) => tax)).toEqual(original.tax_lines);
      expect(line.tax_lines[0].taxable_amount).toBe(line.line_total);
    }
    if (order.quoteId) {
      const quote = await checked<Price>(rpc('get_checkout_quote', { quote_id: order.quoteId }, buyer.token));
      expect(actual.lines.map(l => l.id)).toEqual(quote.lines.map(l => l.id));
    }
    expect((await ledger(order.id)).balances.is_balanced).toBe(true);
  } finally { await checked(rpc('cancel_order', { order_id: order.id }, buyer.token)); }
});

test('税额先按 SKU/配送、再按商业行分配整数分；重排和同 SKU 拆属性不能改变 SKU 税额', async () => {
  await patch('product_variants', fixture.variantId, { price: 0.03 });
  await patch('product_variants', second.variantId, { price: 0.07 });
  try {
    for (let count = 2; count <= 12; count++) {
      const common = { variant_id: second.variantId, quantity: 2 };
      const whole = await preview({ discount_code: null, items: [{ variant_id: fixture.variantId, quantity: count }, common] });
      const items = Array.from({ length: count }, (_, i) => ({ variant_id: fixture.variantId, quantity: 1, attributes: { engraving: `tax-${i}` } }));
      const split = await preview({ discount_code: null, items: [...items, common] });
      expect(await preview({ discount_code: null, items: [common, ...items.reverse()] })).toEqual(split);
      conserved(whole); conserved(split);
      for (const variant of [fixture.variantId, second.variantId]) {
        expect(sum(split.lines.filter(l => l.variant_id === variant).flatMap(l => l.tax_lines)))
          .toBe(sum(whole.lines.filter(l => l.variant_id === variant).flatMap(l => l.tax_lines)));
      }
    }
  } finally { await patch('product_variants', fixture.variantId, { price: 10 }); await patch('product_variants', second.variantId, { price: 10 }); }
});

test('运费门槛减免与促销免邮分别留存，免邮优惠不重复计入商品折扣', async () => {
  for (const [method, discount] of [[thresholdId, code], [shippingId, freeCode]]) {
    const order = await paid(false, { shipping_method_id: method, discount_code: discount });
    const p = await pricing(order.id); conserved(p);
    expect(p.shipping_line).toMatchObject({ gross_amount: 8, discount_total: 8, total: 0 });
    if (method === thresholdId) expect(p.shipping_line).toMatchObject({ threshold_discount: 8, discount_allocations: [] });
    else {
      expect(p.discount_total).toBe(0);
      expect(sum(p.shipping_line!.discount_allocations)).toBe(800);
      expect(p.promotions[0].amount).toBe(8);
    }
    expect((await rpc('refund_order', { idempotency_key: crypto.randomUUID(), order_id: order.id, shipping_amount: 0.01 }, admin.token)).status).toBe(400);
  }
});

test('已支付快照不随税率、运费或优惠改名/改价变化；保留规则引用并拒绝删除', async () => {
  const order = await paid(); const before = await pricing(order.id);
  try {
    await patch('tax_rates', taxId, { name: 'Changed rate', rate: 0.2 });
    await patch('shipping_methods', shippingId, { name: 'Changed shipping', price: 9 });
    await patch('promotions', promoId, { name: 'Changed promotion', params: { amount: 2 } });
    expect(await pricing(order.id)).toEqual(before);
    expect((await checked<Price>(rpc('price_checkout', input(), other.token))).total).not.toBe(before.total);
    for (const [table, id] of [['tax_rates', taxId], ['shipping_methods', shippingId], ['promotions', promoId]]) {
      const deletion = await api(`/rest/v1/${table}?id=eq.${id}`, { service: true, method: 'DELETE' });
      expect(deletion.status).toBe(409); expect(deletion.data).toMatchObject({ code: '23503' });
    }
  } finally {
    await patch('tax_rates', taxId, { name: 'Fictional breakdown rate', rate: 0.13 });
    await patch('shipping_methods', shippingId, { name: 'Breakdown shipping', price: 8 });
    await patch('promotions', promoId, { name: 'Breakdown discount', params: { amount: 1 } });
  }
});

test('报价税务依据变化即拒绝转单，即时未付订单也冻结税务快照', async () => {
  const quote = await checked<Price>(rpc('create_checkout_quote', { ...input(), idempotency_key: crypto.randomUUID() }, buyer.token));
  try {
    await patch('tax_rates', taxId, { rate: 0.2 });
    const changed = await rpc('create_order_from_quote', { quote_id: quote.id }, buyer.token);
    expect(changed.data).toMatchObject({ message: expect.stringContaining('pricing changed') });
  } finally {
    await patch('tax_rates', taxId, { rate: 0.13 });
    await checked(rpc('cancel_checkout_quote', { quote_id: quote.id }, buyer.token));
  }
  const order = await create(false); const before = await pricing(order.id);
  try {
    const edit = await rpc('update_order_address', { order_id: order.id, address: { ...address, country: 'GB' } }, buyer.token);
    expect(edit.status).toBe(400);
    expect(edit.data).toMatchObject({ message: expect.stringContaining('immutable') });
    expect(await pricing(order.id)).toEqual(before);
  } finally { await checked(rpc('cancel_order', { order_id: order.id }, buyer.token)); }
  const replacement = await create(false, { address: { ...address, country: 'GB' } });
  const after = await pricing(replacement.id); conserved(after);
  expect(after.tax_context.status).toBe('no_rule'); expect(after.tax_total).toBe(0);
  await checked(rpc('cancel_order', { order_id: replacement.id }, buyer.token));
});

test('关系金额在提交时校验，错税/漏税、配送/优惠头行错配和跨单归属全部回滚', async () => {
  const order = await create(false); const foreign = await create(false, { discount_code: null }); const before = await pricing(order.id);
  try {
    const statements = [
      `delete from commerce.order_tax_lines where order_id='${order.id}'`,
      `update commerce.order_tax_lines set amount=amount+0.01 where id='${before.lines[0].tax_lines[0].id}'`,
      `update commerce.order_shipping_lines set gross_amount=gross_amount+0.01 where order_id='${order.id}'`,
      `update commerce.order_discount_allocations set amount=amount+0.01 where order_item_id='${before.lines[0].id}'`,
      `update public.order_promotions set amount=amount+0.01 where order_id='${order.id}'`,
      `update commerce.order_tax_lines set order_item_id='${foreign.itemId}' where id='${before.lines[0].tax_lines[0].id}'`,
      `update public.orders set tax_context='{"status":"calculated"}' where id='${order.id}'`,
    ];
    for (const sql of statements) {
      await expect(database.begin(async tx => { await tx.unsafe(sql); })).rejects.toBeDefined();
      expect(await pricing(order.id)).toEqual(before);
    }
  } finally { for (const o of [order, foreign]) await checked(rpc('cancel_order', { order_id: o.id }, buyer.token)); }
});

test('定价读取只对所有者/管理员/service 开放；支付意图或已付款后所有关系快照不可改', async () => {
  const order = await create(false);
  expect((await rpc('get_order_pricing', { order_id: order.id }, other.token)).status).toBe(400);
  expect((await rpc('get_order_pricing', { order_id: order.id })).status).toBe(401);
  expect((await rpc('get_order_pricing', { order_id: order.id }, admin.token)).status).toBe(200);
  expect((await rpc('get_order_pricing', { order_id: order.id }, undefined, true)).status).toBe(200);
  const intent = await fixtureIntent(order, buyer);
  for (const settle of [false, true]) {
    if (settle) await settleIntent(intent);
    for (const table of ['order_tax_lines', 'order_shipping_lines', 'order_discount_allocations', 'order_promotions']) {
      await expect(database.begin(async tx => { await tx.unsafe(`delete from ${table === 'order_promotions' ? 'public' : 'commerce'}.${table} where order_id='${order.id}'`); })).rejects.toThrow('pricing');
    }
  }
  const rows = await database`select c.relrowsecurity as rls, has_table_privilege('authenticated',c.oid,'SELECT') as readable,
    has_table_privilege('service_role',c.oid,'INSERT') as writable from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='commerce' and c.relname in ('order_tax_lines','order_shipping_lines','order_discount_allocations','refund_components','refund_request_components')`;
  expect(rows).toHaveLength(5); for (const row of rows) expect(row).toEqual({ rls: true, readable: false, writable: false });
});

for (const first of ['intent', 'admin_note']) test(`${first} 提交后旧 REPEATABLE READ 快照不能改定价明细`, async () => {
  const order = await create(false);
  const before = await pricing(order.id);
  try {
    const result = await staleAfterCommit(database, async tx => {
      await tx`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`;
      await tx`update commerce.order_discount_allocations set label='stale edit' where order_id=${order.id}::uuid`;
    }, async () => {
      if (first === 'intent') await fixtureIntent(order, buyer);
      else await database`update public.orders set admin_note='committed lock holder' where id=${order.id}::uuid`;
    });
    expect(result.error).toMatchObject({ errno: '40001' });
    expect(await pricing(order.id)).toEqual(before);
  } finally { await checked(rpc('cancel_order', { order_id: order.id }, buyer.token)); }
});

test('手工退款按商业行退净额和对应税；配送需显式选择，分次退税/净额严格守恒', async () => {
  const order = await paid(); const p = await pricing(order.id); const stock = await stockOf(fixture.sku);
  for (const line of p.lines) {
    await checked(rpc('refund_order', { idempotency_key: crypto.randomUUID(), order_id: order.id, items: [{ order_item_id: line.id, quantity: 1 }], restock: true }, admin.token));
    const refund = (await ledger(order.id)).refunds.find(r => r.lines.some(l => l.order_item_id === line.id))!;
    expect(cents(refund.amount)).toBe(cents(line.line_total) + sum(line.tax_lines));
    expect(sum(refund.lines) + sum(refund.components)).toBe(cents(refund.amount));
    expect(refund.components.every(c => c.kind === 'tax')).toBe(true);
  }
  expect((await ledger(order.id)).balances.net_paid).toBe(9.04);
  for (let i = 0; i < 2; i++) {
    const command = { order_id: order.id, shipping_amount: 4, idempotency_key: crypto.randomUUID() };
    const first = await checked<Record<string, unknown>>(rpc('refund_order', command, admin.token));
    expect(await checked<Record<string, unknown>>(rpc('refund_order', command, admin.token))).toEqual(first);
  }
  const result = await ledger(order.id);
  expect(result.refunds).toHaveLength(4);
  for (const refund of result.refunds.filter(r => r.source === 'shipping')) {
    expect(refund.lines).toEqual([]); expect(sum(refund.components)).toBe(452);
  }
  expect(result.balances).toMatchObject({ is_balanced: true, net_paid: 0, refunded: p.total });
  expect(await stockOf(fixture.sku)).toBe(stock + 2);
});

test('PayPal 请求同时预留商品/税/运费，取消释放全部；完成时原样落账且重复事件不重复回库', async () => {
  const order = await paid(true); const p = await pricing(order.id); const stock = await stockOf(fixture.sku);
  const items = [{ order_item_id: p.lines[0].id, quantity: 1 }];
  const held = await checked<Request>(requestRefund(order.id, { items, shipping_amount: 4 }));
  expect(held.components.map(c => c.kind).sort()).toEqual(['shipping', 'tax', 'tax']);
  expect((await requestRefund(order.id, { items })).status).toBe(400);
  expect((await requestRefund(order.id, { shipping_amount: 5 })).status).toBe(400);
  await checked(rpc('cancel_refund_request', { refund_request_id: held.id, actor_id: admin.userId }, undefined, true));
  const all = await checked<Request>(requestRefund(order.id, {
    items: p.lines.map(l => ({ order_item_id: l.id, quantity: 1 })), shipping_amount: 8, restock: true,
  }));
  expect(all.amount).toBe(p.total); await complete(all);
  const result = await ledger(order.id);
  expect(result.refunds).toHaveLength(1); expect(result.refunds[0].components).toEqual(all.components);
  expect(result.balances).toMatchObject({ is_balanced: true, net_paid: 0 });
  expect(await stockOf(fixture.sku)).toBe(stock + 2);
});

test('美分极值：零净额/非零税退款、三次数量预留、取消与逆序完成都不超退', async () => {
  await patch('product_variants', fixture.variantId, { price: 0.01 }); await patch('tax_rates', taxId, { rate: 0.5 });
  let order: FixtureOrder;
  try {
    order = await paid(true, { items: [{ variant_id: fixture.variantId, quantity: 3 }], discount_code: tinyCode, shipping_method_id: null });
  } finally { await patch('product_variants', fixture.variantId, { price: 10 }); await patch('tax_rates', taxId, { rate: 0.13 }); }
  expect(order!.total).toBe(0.03);
  const args = { items: [{ order_item_id: order!.itemId, quantity: 1 }] };
  const requests: Request[] = [];
  for (let i = 0; i < 3; i++) requests.push(await checked<Request>(requestRefund(order!.id, args)));
  expect(requests.map(r => r.amount)).toEqual([0.01, 0.01, 0.01]);
  expect(requests[2].lines[0].amount).toBe(0); expect(sum(requests[2].components)).toBe(1);
  await checked(rpc('cancel_refund_request', { refund_request_id: requests[1].id, actor_id: admin.userId }, undefined, true));
  requests[1] = await checked<Request>(requestRefund(order!.id, args));
  for (const r of requests.reverse()) await complete(r);
  const result = await ledger(order!.id);
  expect(result.balances).toMatchObject({ is_balanced: true, net_paid: 0, refunded: 0.03 });
  expect(result.refunds.reduce((n, r) => n + sum(r.lines), 0)).toBe(2);
  expect(result.refunds.reduce((n, r) => n + sum(r.components), 0)).toBe(1);
});

test('纯金额退款明确未分配，不猜税/配送/数量；后续数量退款仍受实收余额限制', async () => {
  const order = await paid(); const p = await pricing(order.id);
  await checked(rpc('refund_order', { idempotency_key: crypto.randomUUID(), order_id: order.id, amount: 1 }, admin.token));
  const first = (await ledger(order.id)).refunds[0];
  expect(first.lines).toEqual([]);
  expect(first.components).toEqual([{ kind: 'unallocated', amount: 1, tax_line_id: null, shipping_line_id: null }]);
  expect((await rpc('refund_order', { idempotency_key: crypto.randomUUID(), order_id: order.id, items: p.lines.map(l => ({ order_item_id: l.id, quantity: 1 })), shipping_amount: 8 }, admin.token)).status).toBe(400);
  await checked(rpc('refund_order', { idempotency_key: crypto.randomUUID(), order_id: order.id }, admin.token));
  expect((await ledger(order.id)).refunds.every(r => r.components.every(c => c.kind === 'unallocated'))).toBe(true);
  const lines = await checked<Array<{ refunded_quantity: number }>>(api(`/rest/v1/order_items?order_id=eq.${order.id}&select=refunded_quantity`, { token: buyer.token }));
  expect(lines.every(l => l.refunded_quantity === 0)).toBe(true);
});

test('PayPal 生产 handler 接收 shipping_amount，发送的是数据库计算的含税退款额且重试不重新 POST', async () => {
  const order = await paid(true); let posts = 0; let refund: object;
  const command = { order_id: order.id, shipping_amount: '4.00', idempotency_key: crypto.randomUUID() };
  await withPaymentProviderMock(async request => {
    if (request.url.endsWith('/v1/oauth2/token')) return Response.json({ access_token: 'composition-mock', expires_in: 3600 });
    if (request.method === 'POST') {
      posts++; const body = await request.json(); expect(body.amount).toEqual({ value: '4.52', currency_code: 'USD' });
      expect(request.headers.get('PayPal-Request-Id')).toBe(`ref_${body.custom_id.replaceAll('-', '')}`);
      refund = { id: `REFUND${body.custom_id.replaceAll('-', '')}`, status: 'COMPLETED', amount: body.amount, custom_id: body.custom_id, create_time: new Date().toISOString() };
    }
    return Response.json(refund!);
  }, async () => {
    for (let i = 0; i < 2; i++) {
      const response = await handlePayPalCreateRefund(paymentRequest(command, admin.token));
      expect({ status: response.status, data: await response.json() }).toMatchObject({ status: 200, data: { amount: 4.52, pending_reconciliation: false } });
    }
  });
  expect(posts).toBe(1); expect((await ledger(order.id)).refunds).toHaveLength(1);
});

test('退款组成不可篡改/跨单追加，提交时拒绝只有请求头却遗漏明细的写入', async () => {
  const order = await paid(true); const foreign = await paid(true, { discount_code: null });
  const request = await checked<Request>(requestRefund(order.id, { shipping_amount: 4 }));
  for (const statement of [
    `update commerce.refund_request_components set amount=amount+0.01 where refund_request_id='${request.id}'`,
    `delete from commerce.refund_request_components where refund_request_id='${request.id}'`,
  ]) await expect(database.begin(async tx => { await tx.unsafe(statement); })).rejects.toThrow('immutable');
  const id = crypto.randomUUID();
  await expect(database.begin(async tx => {
    await tx`insert into commerce.refund_requests select (jsonb_populate_record(null::commerce.refund_requests,
      to_jsonb(r) || jsonb_build_object('id', ${id}::text, 'idempotency_key', ${id}::text))).*
      from commerce.refund_requests r where r.id=${request.id}::uuid`;
  })).rejects.toThrow('refund components do not match header');
  // Per-request 30 fits the capture, but 30 plus the existing 4.52 reservation does not.
  await expect(database.begin(async tx => {
    await tx`insert into commerce.refund_requests select (jsonb_populate_record(null::commerce.refund_requests,
      to_jsonb(r) || jsonb_build_object('id', ${id}::text, 'idempotency_key', ${id}::text, 'amount', 30, 'source', 'custom_amount'))).*
      from commerce.refund_requests r where r.id=${request.id}::uuid`;
  })).rejects.toThrow('available capture balance');
  const foreignTax = (await pricing(foreign.id)).lines[0].tax_lines[0].id;
  await expect(database.begin(async tx => {
    await tx`insert into commerce.refund_request_components(refund_request_id,order_id,kind,tax_line_id,amount)
      values (${request.id}::uuid,${order.id}::uuid,'tax',${foreignTax}::uuid,0.01)`;
  })).rejects.toBeDefined();
  await complete(request);
  const result = (await ledger(order.id)).refunds[0];
  await expect(database.begin(async tx => { await tx`delete from commerce.refund_components where refund_id=${result.id}::uuid`; })).rejects.toThrow('immutable');
  expect(result.components).toEqual(request.components);
});

test('配送税最后一笔吸收美分余数，异步预留逆序完成也保留原计算结果', async () => {
  await patch('shipping_methods', shippingId, { price: 0.1 }); await patch('tax_rates', taxId, { rate: 0.05 });
  let order: FixtureOrder;
  try { order = await paid(true); }
  finally { await patch('shipping_methods', shippingId, { price: 8 }); await patch('tax_rates', taxId, { rate: 0.13 }); }
  const requests: Request[] = [];
  for (const amount of [0.03, 0.03, 0.04]) requests.push(await checked<Request>(requestRefund(order!.id, { shipping_amount: amount })));
  expect(requests.map(r => r.amount)).toEqual([0.03, 0.03, 0.05]);
  for (const request of requests.reverse()) await complete(request);
  const result = await ledger(order!.id);
  expect(result.balances.refunded).toBe(0.11);
  expect(result.refunds.reduce((n, r) => n + sum(r.components.filter(c => c.kind === 'tax')), 0)).toBe(1);
});

test('运费预留受控并发：竞争请求等待订单锁，不能超出已折后配送余额', async () => {
  const order = await paid(true);
  const result = await heldTransactionRace(database, async tx => {
    await tx`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`;
    await tx`select public.create_refund_request(${order.id}::uuid, ${admin.userId}::uuid, 'paypal', ${crypto.randomUUID()}, shipping_amount => 5)`;
  }, () => requestRefund(order.id, { shipping_amount: 5 }));
  expect(result.status).toBe(400); expect(result.data).toMatchObject({ message: expect.stringContaining('shipping refund exceeds') });
});

test('退款容量在 REPEATABLE READ 旧快照上也不能绕过新提交的预留', async () => {
  const order = await paid(true);
  const result = await staleAfterCommit(database, async tx => {
    await tx`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`;
    await tx`select public.create_refund_request(${order.id}::uuid, ${admin.userId}::uuid, 'paypal', ${crypto.randomUUID()}, shipping_amount => 5)`;
  }, () => checked(requestRefund(order.id, { shipping_amount: 5 })));
  expect(result.error).toMatchObject({ errno: '40001' });
});
