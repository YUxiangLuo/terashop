import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { withRollback } from '../scripts/lib/transactions';
import { testDatabase } from './database-concurrency';
import { Cleanup } from './support/cleanup';
import { stockedProduct } from './support/catalog';
import { promotionFixture } from './support/promotions';
import { api, rpc, signup, makeAdmin, stockOf, TEST_ADDRESS, type TestUser } from './helpers';
import { checked, fixtureIntent, settleIntent } from './payment-fixtures';

interface Line {
  id: string; variant_id: string; line_key: string; attributes: Record<string, string>;
  quantity: number; discount_total: number; line_total: number;
}
interface Quote { id: string; total: number; lines: Line[] }
interface Price { lines: Array<Omit<Line, 'id'>>; total: number; discount_total: number; promotions: Array<{ promotion_id: string; amount: number }> }
const database = testDatabase();
let admin: TestUser;
const products = new Cleanup();
beforeAll(async () => { admin = await signup(); await makeAdmin(admin.userId); });
afterEach(() => products.run());
afterAll(() => database.close());
const fixture = () => stockedProduct(admin, { cleanup: products });
const cart = (variant: string) => [
  { variant_id: variant, quantity: 1, attributes: { engraving: 'Alice' } },
  { variant_id: variant, quantity: 1, attributes: { engraving: 'Bob' } },
];

test('匿名计价共享 50 商业行/100 件预算，重叠买赠拒绝超大数量及合并越界', async () => {
  const f = await fixture(), cleanup = new Cleanup(), code = crypto.randomUUID().toUpperCase();
  try {
    const promotion = await promotionFixture(cleanup, { name: code, code, type: 'buy_x_get_y',
      params: { buy: 1, get: 1 }, apply_scope: 'selected', get_scope: 'selected' });
    await checked(api('/rest/v1/promotion_targets', { service: true, method: 'POST', body: [
      { promotion_id: promotion, role: 'apply', variant_id: f.variantId },
      { promotion_id: promotion, role: 'get', variant_id: f.variantId },
    ] }));
    const line = (quantity: number, label?: string) => ({ variant_id: f.variantId, quantity,
      ...(label === undefined ? {} : { attributes: { label } }) });
    for (const [items, count] of [
      [[line(100)], 1],
      [Array.from({ length: 100 }, () => line(1)), 1],
      [Array.from({ length: 50 }, (_, i) => line(2, String(i))), 50],
    ] as const) {
      const price = await checked<Price>(rpc('price_checkout', { items, discount_code: code }));
      expect(price.lines).toHaveLength(count);
      expect(price.lines.reduce((sum, l) => sum + l.quantity, 0)).toBe(100);
      expect(price.discount_total).toBe(500);
    }
    for (const items of [[line(101)], [line(60), line(41)], [line(60, 'a'), line(41, 'b')],
      [line(1_000_000)], [line(2_147_483_648)]]) {
      const result = await rpc('price_checkout', { items, discount_code: code });
      expect(result.status).toBe(400);
      expect(result.data).toMatchObject({ message: expect.stringContaining('100 units') });
    }
    const distinct = await rpc('price_checkout', {
      items: Array.from({ length: 51 }, (_, i) => line(1, String(i))), discount_code: code,
    });
    expect(distinct.status).toBe(400);
    expect(distinct.data).toMatchObject({ message: expect.stringContaining('50 lines') });
    const raw = await rpc('price_checkout', { items: Array.from({ length: 101 }, () => line(1)) });
    expect(raw.status).toBe(400);
    expect(raw.data).toMatchObject({ message: expect.stringContaining('100 input lines') });
  } finally { await cleanup.run(); }
});

test('原始输入行数和 JSONB UTF-8 字节预算在逐行规范化之前拒绝', async () => {
  await withRollback(database, async sql => {
    await sql`select set_config('request.jwt.claims','{"role":"anon"}',true)`;
    await sql`set local role anon`;
    // Invalid line content distinguishes a front-door budget check from a late check.
    for (const [count, message] of [[100, 'each item requires variant_id'], [101, '100 input lines']] as const) {
      await sql`savepoint probe`;
      await expect(Promise.resolve(sql`select public.price_checkout((select jsonb_agg(null::jsonb) from generate_series(1,${count})))`))
        .rejects.toThrow(message);
      await sql`rollback to savepoint probe`;
    }
    for (const extra of [-1, 0, 1]) {
      await sql`savepoint probe`;
      // Account for PostgreSQL's JSONB text punctuation; CJK tests bytes, not characters.
      await expect(Promise.resolve(sql`select public.price_checkout(jsonb_build_array(jsonb_build_object('padding',
        repeat('界',300000) || repeat('x',1048576 + ${extra} - 900000 - octet_length('[{"padding": ""}]')))))`))
        .rejects.toThrow(extra > 0 ? '1 MiB' : 'each item requires variant_id');
      await sql`rollback to savepoint probe`;
    }
  });
});

for (const command of ['create_checkout_quote', 'create_order']) {
  test(`${command}: 输入拒绝不占库存或消费幂等键，100 条重复输入可合并后重试`, async () => {
    const f = await fixture(), buyer = await signup(), idempotency_key = crypto.randomUUID();
    const line = (quantity: number, label = 'same') => ({ variant_id: f.variantId, quantity, attributes: { label } });
    const invoke = (items: unknown) => rpc(command, { items, address: TEST_ADDRESS, idempotency_key }, buyer.token);
    for (const [items, message] of [
      [Array.from({ length: 101 }, () => line(1)), '100 input lines'],
      [[{ padding: '界'.repeat(350000) }], '1 MiB'],
      [[line(60), line(41)], '100 units'],
      [Array.from({ length: 51 }, (_, i) => line(1, String(i))), '50 lines'],
    ] as const) {
      const rejected = await invoke(items);
      expect(rejected.status).toBe(400);
      expect(rejected.data).toMatchObject({ message: expect.stringContaining(message) });
    }
    expect(await database`select id from commerce.checkout_quotes where customer_id=${buyer.customerId}::uuid`).toHaveLength(0);
    expect(await database`select id from public.orders where customer_id=${buyer.customerId}::uuid`).toHaveLength(0);
    const availability = () => checked<{ reserved: number }>(rpc('get_inventory_availability', { variant_id: f.variantId }, admin.token));
    expect((await availability()).reserved).toBe(0);
    const accepted = await checked<{ id: string }>(invoke(Array.from({ length: 100 }, () => line(1))));
    try {
      const lines = command === 'create_checkout_quote'
        ? (await checked<Quote>(rpc('get_checkout_quote', { quote_id: accepted.id }, buyer.token))).lines
        : await checked<Line[]>(api(`/rest/v1/order_items?order_id=eq.${accepted.id}`, { token: buyer.token }));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ variant_id: f.variantId, quantity: 100, attributes: { label: 'same' } });
      expect((await checked<{ id: string }>(invoke([line(100)]))).id).toBe(accepted.id);
      expect((await availability()).reserved).toBe(100);
      expect(await stockOf(f.sku)).toBe(100);
    } finally {
      await checked(command === 'create_checkout_quote'
        ? rpc('cancel_checkout_quote', { quote_id: accepted.id }, buyer.token)
        : rpc('cancel_order', { order_id: accepted.id }, buyer.token));
    }
    expect((await availability()).reserved).toBe(0);
  });
}

test('商业行规范化：属性键顺序、输入顺序、拆行、UUID 大小写和会话设置不改变身份及哈希', async () => {
  const variant = 'aaaa0000-0000-4000-8000-000000000001';
  const canonical = [{ variant_id: variant, quantity: 3, attributes: { engraving: 'Alice', wrap: 'yes' } },
    { variant_id: variant, quantity: 1, attributes: { engraving: 'Bob' } }];
  const split = [{ variant_id: variant.toUpperCase(), quantity: '1', attributes: { engraving: 'Bob' } },
    { variant_id: variant, quantity: 2, attributes: { wrap: 'yes', engraving: 'Alice' } },
    { variant_id: variant, quantity: 1, attributes: { engraving: 'Alice', wrap: 'yes' } }];
  await withRollback(database, async sql => {
    let value: unknown; let hash: string | undefined;
    for (const [zone, dateStyle, intervalStyle, digits] of [
      ['UTC', 'ISO, MDY', 'postgres', '3'],
      ['Asia/Shanghai', 'SQL, DMY', 'sql_standard', '-3'],
      ['Pacific/Honolulu', 'German, DMY', 'iso_8601', '0'],
    ]) {
      await sql`select set_config('TimeZone',${zone},true), set_config('DateStyle',${dateStyle},true),
        set_config('IntervalStyle',${intervalStyle},true), set_config('extra_float_digits',${digits},true)`;
      for (const input of [canonical, split]) {
        const [row] = await sql`with result as (select private.canonical_checkout_lines(${JSON.stringify(input)}::text::jsonb) value)
          select value, private.command_request_hash(value) hash from result`;
        value ??= row.value; hash ??= row.hash;
        expect(row.value).toEqual(value); expect(row.hash).toBe(hash);
        expect(row.value).toHaveLength(2);
        expect(new Set(row.value.map((l: Line) => l.line_key)).size).toBe(2);
      }
    }
    const [row] = await sql`select private.canonical_checkout_lines(${JSON.stringify([{ variant_id: variant, quantity: 1 }])}::text::jsonb) a,
      private.canonical_checkout_lines(${JSON.stringify([{ variant_id: variant, quantity: 2, attributes: {} }])}::text::jsonb) b`;
    expect(row.a[0].attributes).toEqual({}); expect(row.a[0].line_key).toBe(row.b[0].line_key);
  });
});

test('拒绝未声明商业字段、伪造 line_key 及无界/非文本属性；直接 SQL 同样校验属性', async () => {
  const f = await fixture();
  for (const extra of [
    { unit_price: 0 }, { selling_plan: 'unimplemented' }, { line_key: 'forged' }, { line_key: null },
    ...[null, [], 'text', { engraving: 123 }, { engraving: null }, { ' ': 'x' }, { '\t\n': 'x' },
      { ['x'.repeat(65)]: 'x' }, { engraving: 'x'.repeat(501) },
      Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 'x'])),
      Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, '界'.repeat(500)])),
    ].map(attributes => ({ attributes })),
  ]) {
    const result = await rpc('price_checkout', { items: [{ variant_id: f.variantId, quantity: 1, ...extra }] });
    expect(result.status).toBe(400);
  }
  const buyer = await signup();
  const order = await checked<{ id: string }>(rpc('create_order', { idempotency_key: crypto.randomUUID(),
    items: cart(f.variantId), address: TEST_ADDRESS,
  }, buyer.token));
  const invalid = await api(`/rest/v1/order_items?order_id=eq.${order.id}`, {
    service: true, method: 'PATCH', body: { attributes: { engraving: false } },
  });
  expect(invalid.status).toBe(400);
  expect(invalid.data).toMatchObject({ code: 'P0001', message: 'quoted order items are immutable until payment' });
  // Exercise the table CHECK at initial construction too; immutability must not
  // mask a missing attributes constraint on a newly inserted line.
  await expect(withRollback(database, async sql => {
    const [header] = await sql`insert into public.orders(customer_id,email,subtotal,total,shipping_address)
      values (${buyer.customerId}::uuid,'check@example.invalid',10,10,${JSON.stringify(TEST_ADDRESS)}::text::jsonb) returning id`;
    await sql`insert into public.order_items(order_id,variant_id,name,unit_price,quantity,total,attributes)
      values (${header.id}::uuid,${f.variantId}::uuid,'Invalid attributes',10,1,10,'{"engraving":false}')`;
  })).rejects.toMatchObject({ errno: '23514' });
  const generated = await api(`/rest/v1/order_items?order_id=eq.${order.id}`, {
    service: true, method: 'PATCH', body: { line_key: '0'.repeat(64) },
  });
  expect(generated.status).toBe(400);
  expect(generated.data).toMatchObject({ code: '428C9' });
  await checked(rpc('cancel_order', { order_id: order.id }, buyer.token));
});

for (const mode of ['quoted-manual', 'quoted-paypal', 'immediate'] as const) {
  test(`${mode}: 同 SKU 两条定制行分别履约/退款，预占和扣库按 SKU 汇总且只执行一次`, async () => {
    const f = await fixture(); const buyer = await signup();
    const input = { items: cart(f.variantId), address: TEST_ADDRESS, idempotency_key: crypto.randomUUID() };
    const quote = mode === 'immediate' ? null : await checked<Quote>(rpc('create_checkout_quote', input, buyer.token));
    if (quote) {
      expect(quote.lines).toHaveLength(2);
      expect(new Set(quote.lines.map(l => l.id)).size).toBe(2);
      const retried = await checked<Quote>(rpc('create_checkout_quote', { ...input, items: [...input.items].reverse() }, buyer.token));
      expect(retried).toEqual(quote);
      expect((await rpc('create_checkout_quote', { ...input, items: [{ ...input.items[0], attributes: { engraving: 'Changed' } }] }, buyer.token)).status).toBe(400);
      expect(await stockOf(f.sku)).toBe(100);
      expect((await checked<{ reserved: number }>(rpc('get_inventory_availability', { variant_id: f.variantId }, admin.token))).reserved).toBe(2);
    }
    const order = await checked<{ id: string; total: number; currency: string }>(quote
      ? rpc('create_order_from_quote', { quote_id: quote.id }, buyer.token)
      : rpc('create_order', input, buyer.token));
    const lines = await checked<Line[]>(api(`/rest/v1/order_items?order_id=eq.${order.id}&order=line_key`, { token: buyer.token }));
    expect(lines).toHaveLength(2);
    expect(lines.map(l => l.attributes.engraving).sort()).toEqual(['Alice', 'Bob']);
    if (quote) expect(lines.map(l => l.id).sort()).toEqual(quote.lines.map(l => l.id).sort());
    else {
      expect((await checked<{ id: string }>(rpc('create_order', { ...input, items: [...input.items].reverse() }, buyer.token))).id).toBe(order.id);
      expect((await rpc('create_order', { ...input, items: [{ ...input.items[0], attributes: {} }] }, buyer.token)).status).toBe(400);
    }
    const alice = lines.find(l => l.attributes.engraving === 'Alice')!;
    const bob = lines.find(l => l.attributes.engraving === 'Bob')!;
    if (mode === 'quoted-paypal') {
      const intent = await fixtureIntent({ ...order, itemId: alice.id, quoteId: quote!.id }, buyer);
      expect((await api(`/rest/v1/order_items?id=eq.${alice.id}`, {
        service: true, method: 'PATCH', body: { attributes: { engraving: 'tampered' } },
      })).status).toBe(400);
      await settleIntent(intent); await settleIntent(intent);
    } else await checked(rpc('mark_order_paid', { order_id: order.id }, admin.token));
    expect(await stockOf(f.sku)).toBe(98);
    const [movement] = await database`select count(*)::int n, sum(delta)::int delta from public.inventory_movements where order_id=${order.id}::uuid and reason='order'`;
    expect(movement).toEqual({ n: 1, delta: -2 });
    expect((await api(`/rest/v1/order_items?id=eq.${alice.id}`, {
      service: true, method: 'PATCH', body: { attributes: { engraving: 'tampered' } },
    })).status).toBe(400);
    await checked(rpc('create_fulfillment', {
      order_id: order.id, items: [{ order_item_id: alice.id, quantity: 1 }], idempotency_key: crypto.randomUUID(),
    }, admin.token));
    // Manual refunds use the same inventory/line accounting; provider delivery is tested separately below.
    if (mode === 'quoted-paypal') {
      const request = await checked<{ id: string; amount: number; currency: string; parent_provider_reference: string }>(rpc('create_refund_request', {
        order_id: order.id, actor_id: admin.userId, provider: 'paypal', idempotency_key: crypto.randomUUID(),
        items: [{ order_item_id: bob.id, quantity: 1 }], restock: true,
      }, undefined, true));
      const reference = `REFUND${crypto.randomUUID()}`;
      await checked(rpc('bind_refund_request_provider', {
        refund_request_id: request.id, provider_reference: reference, provider_status: 'pending', amount: request.amount, currency: request.currency,
      }, undefined, true));
      const { paymentEvent } = await import('./payment-fixtures');
      for (let i = 0; i < 2; i++) await paymentEvent('paypal', 'PAYMENT.REFUND.COMPLETED', reference, {
        status: 'completed', amount: request.amount.toFixed(2), currency: request.currency, capture_reference: request.parent_provider_reference,
      });
    } else await checked(rpc('refund_order', {
      order_id: order.id, items: [{ order_item_id: bob.id, quantity: 1 }], restock: true, idempotency_key: crypto.randomUUID(),
    }, admin.token));
    expect(await stockOf(f.sku)).toBe(99);
    const balances = await checked<{ lines: Array<{ order_item_id: string; fulfilled_quantity: number; cancelled_quantity: number }> }>(rpc('get_order_fulfillment_balance', { order_id: order.id }, buyer.token));
    expect(balances.lines.find(l => l.order_item_id === alice.id)).toMatchObject({ fulfilled_quantity: 1, cancelled_quantity: 0 });
    expect(balances.lines.find(l => l.order_item_id === bob.id)).toMatchObject({ fulfilled_quantity: 0, cancelled_quantity: 1 });
    expect((await checked<{ balances: { is_balanced: boolean } }>(rpc('get_order_ledger', { order_id: order.id }, buyer.token))).balances.is_balanced).toBe(true);
  });
}

test('不同商业行不能各自绕过库存总量与 50 行上限，取消只回补一次', async () => {
  const f = await fixture(); const buyer = await signup();
  await checked(rpc('adjust_inventory', { variant_id: f.variantId, delta: -99 }, admin.token));
  for (const command of ['create_checkout_quote', 'create_order']) {
    expect((await rpc(command, { items: cart(f.variantId), address: TEST_ADDRESS,
      idempotency_key: crypto.randomUUID(),
    }, buyer.token)).status).toBe(400);
  }
  await checked(rpc('adjust_inventory', { variant_id: f.variantId, delta: 99 }, admin.token));
  const items = Array.from({ length: 51 }, (_, i) => ({ variant_id: f.variantId, quantity: 1, attributes: { engraving: String(i) } }));
  for (const command of ['create_checkout_quote', 'create_order']) expect((await rpc(command, {
    items, address: TEST_ADDRESS, idempotency_key: crypto.randomUUID(),
  }, buyer.token)).status).toBe(400);
  const order = await checked<{ id: string }>(rpc('create_order', { idempotency_key: crypto.randomUUID(), items: cart(f.variantId), address: TEST_ADDRESS }, buyer.token));
  expect(await stockOf(f.sku)).toBe(100);
  expect((await checked<{ reserved: number }>(rpc('get_inventory_availability', { variant_id: f.variantId }, admin.token))).reserved).toBe(2);
  await checked(rpc('cancel_order', { order_id: order.id }, buyer.token));
  await rpc('cancel_order', { order_id: order.id }, buyer.token);
  expect(await stockOf(f.sku)).toBe(100);
  expect((await checked<{ reserved: number }>(rpc('get_inventory_availability', { variant_id: f.variantId }, admin.token))).reserved).toBe(0);
});

for (const quoted of [true, false]) {
  test(`${quoted ? 'Quote' : '即时订单'}: 多商业行到期释放库存仅一次，未来时间实验回滚`, async () => {
    const f = await fixture(); const buyer = await signup();
    const input = { items: cart(f.variantId), address: TEST_ADDRESS, idempotency_key: crypto.randomUUID() };
    const quote = quoted ? await checked<Quote>(rpc('create_checkout_quote', {
      ...input,
    }, buyer.token)) : null;
    const order = await checked<{ id: string }>(quote
      ? rpc('create_order_from_quote', { quote_id: quote.id }, buyer.token)
      : rpc('create_order', input, buyer.token));
    try {
      await withRollback(database, async sql => {
        await sql`select set_config('request.jwt.claims','{"role":"service_role"}',true)`;
        for (let i = 0; i < 2; i++) await sql`select public.expire_checkout_quotes(500,'2100-01-01'::timestamptz)`;
        const [row] = await sql`select o.status, il.on_hand,
          (select sum(delta)::int from public.inventory_movements where order_id=o.id and reason='cancel') returned
          from public.orders o join public.inventory_levels il on il.variant_id=${f.variantId}::uuid where o.id=${order.id}::uuid`;
        expect(row).toEqual({ status: 'cancelled', on_hand: 100, returned: null });
      });
      expect(await stockOf(f.sku)).toBe(100);
    } finally { await checked(rpc('cancel_order', { order_id: order.id }, buyer.token)); }
  });
}

test('新增属性不能放大百分比、整单优惠及买赠收益；两层最大余数分摊守恒且重排不变', async () => {
  const fs = [await fixture(), await fixture()].sort((a, b) => a.variantId.localeCompare(b.variantId));
  const merged = fs.map(f => ({ variant_id: f.variantId, quantity: 3 }));
  const split = fs.flatMap(f => [0, 1, 2].map(i => ({ variant_id: f.variantId, quantity: 1, attributes: { engraving: String(i) } })));
  for (const [index, f] of fs.entries()) await checked(api(`/rest/v1/product_variants?id=eq.${f.variantId}&select=id`, {
    service: true, method: 'PATCH', body: { price: index ? 0.03 : 0.01 },
  }));
  const promotions = await checked<Array<{ id: string }>>(api('/rest/v1/promotions', {
    service: true, method: 'POST', body: [
      { name: 'line fixed', type: 'order_fixed', params: { amount: 0.02 }, priority: -30, stackable: true },
      { name: 'line percent', type: 'item_percentage', params: { percent: 50 }, priority: -20, stackable: true },
      { name: 'line bogo', type: 'buy_x_get_y', params: { buy: 1, get: 1, get_percent: 50 }, priority: -10, stackable: true },
    ],
  }));
  try {
    for (const p of promotions) await checked(api('/rest/v1/promotion_targets', {
      service: true, method: 'POST', body: fs.map(f => ({ promotion_id: p.id, role: 'apply', variant_id: f.variantId })),
    }));
    for (const count of [1, 2, 3]) {
      for (const [index, p] of promotions.entries()) await checked(api(`/rest/v1/promotions?id=eq.${p.id}`, {
        service: true, method: 'PATCH', body: { is_active: index < count },
      }));
      const price = await checked<Price>(rpc('price_checkout', { items: split }));
      const original = await checked<Price>(rpc('price_checkout', { items: merged }));
      expect(price.total).toBe(original.total); expect(price.discount_total).toBe(original.discount_total);
      expect(price.promotions).toEqual(original.promotions);
      expect(await checked<Price>(rpc('price_checkout', { items: [...split].reverse() }))).toEqual(price);
      expect(price.lines).toHaveLength(6);
      const cents = (n: number) => Math.round(n * 100);
      expect(price.lines.reduce((sum, l) => sum + cents(l.discount_total), 0)).toBe(cents(price.discount_total));
      for (const f of fs) expect(price.lines.filter(l => l.variant_id === f.variantId).reduce((sum, l) => sum + cents(l.discount_total), 0))
        .toBe(cents(original.lines.find(l => l.variant_id === f.variantId)!.discount_total));
    }
  } finally {
    for (const p of promotions) await checked(api(`/rest/v1/promotions?id=eq.${p.id}`, { service: true, method: 'PATCH', body: { is_active: false } }));
  }
});
