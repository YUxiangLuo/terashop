import { afterAll, beforeAll, expect, test } from 'bun:test';
import { api, rpc, signup, makeAdmin, stockOf, TEST_ADDRESS, type TestUser } from './helpers';
import { checked, paymentFixture, fixtureOrder, fixtureIntent, settleIntent, type PaymentFixture } from './payment-fixtures';
import { heldTransactionRace, testDatabase } from './database-concurrency';

interface Customer { id: string; auth_user_id: string | null; email: string | null; full_name: string; phone: string | null; anonymized_at: string | null }
interface Cart { id: string; customer_id: string | null; version: number; status: string; address: object | null; note: string | null; expires_at: string; quote_id: string | null; guest_token?: string; lines: Array<{ id: string; variant_id: string; line_key: string; quantity: number; attributes: Record<string, string> }> }
interface Quote { id: string; status: string; lines: Array<{ id: string; line_key: string; attributes: object }>; total: number }
const database = testDatabase();
const cartIds: string[] = [];
let admin: TestUser, fixture: PaymentFixture;
beforeAll(async () => { admin = await signup(); await makeAdmin(admin.userId); fixture = await paymentFixture(admin); });
afterAll(async () => {
  for (const id of cartIds) await database`delete from commerce.carts where id=${id}::uuid`;
  if (fixture) await api(`/rest/v1/products?id=eq.${fixture.productId}`, { service: true, method: 'PATCH', body: { status: 'archived' } });
  await database.close();
});
const claims = (user: TestUser) => JSON.stringify({ role: 'authenticated', sub: user.userId });
const items = (quantity = 1, attributes: Record<string, string> = {}) => [{ variant_id: fixture.variantId, quantity, attributes }];
const get = (cart: Cart, owner?: TestUser) => rpc('get_cart', { cart_id: cart.id, guest_token: cart.guest_token }, owner?.token);
const update = (cart: Cart, owner?: TestUser, extra: object = {}) => rpc('update_cart', {
  cart_id: cart.id, expected_version: cart.version, items: items(), guest_token: cart.guest_token, ...extra,
}, owner?.token);
const customer = async (user: TestUser) => (await checked<Customer[]>(api(`/rest/v1/customers?id=eq.${user.customerId}`, { service: true })))[0];
async function create(owner?: TestUser, params: object = {}): Promise<Cart> {
  const cart = await checked<Cart>(rpc('create_cart', { ...owner ? { idempotency_key: crypto.randomUUID() } : {}, ...params }, owner?.token));
  cartIds.push(cart.id); return cart;
}
async function filled(owner?: TestUser, extra: object = {}): Promise<Cart> {
  const cart = await create(owner); return { ...await checked<Cart>(update(cart, owner, extra)), guest_token: cart.guest_token };
}

test('注册生成独立客户；同邮箱后台客户不被认领，联系邮箱不决定权限或角色', async () => {
  const email = `identity-${crypto.randomUUID()}@test.com`;
  const offline = await checked<Customer>(rpc('create_customer', { email, full_name: 'Offline customer' }, admin.token));
  const owner = await signup(email);
  expect(owner.customerId).not.toBe(owner.userId); expect(owner.customerId).not.toBe(offline.id);
  expect(await customer(owner)).toMatchObject({ auth_user_id: owner.userId, email });
  expect(offline.auth_user_id).toBeNull();
  expect(await checked<Customer[]>(api(`/rest/v1/customers?id=eq.${offline.id}`, { token: owner.token }))).toEqual([]);
  expect((await rpc('create_customer', { email }, owner.token)).status).toBe(400);
  const another = await checked<Customer>(rpc('create_customer', { email }, admin.token));
  expect(another.id).not.toBe(offline.id);
});

test('客户联系字段可修改，Auth 链接/身份/角色不可写；登录邮箱改变不覆盖客户联系信息', async () => {
  const owner = await signup(); const other = await signup(); const contact = 'contact@example.test';
  await checked(api(`/rest/v1/customers?id=eq.${owner.customerId}`, { token: owner.token, method: 'PATCH', body: { email: contact, full_name: 'Customer', phone: '+1 555' } }));
  expect((await api('/rest/v1/customers?select=id')).status).toBe(401);
  expect(await checked<Customer[]>(api(`/rest/v1/customers?id=eq.${owner.customerId}`, { token: other.token }))).toEqual([]);
  for (const body of [{ auth_user_id: other.userId }, { id: other.customerId }, { anonymized_at: new Date().toISOString() }, { role: 'admin' }]) {
    expect((await api(`/rest/v1/customers?id=eq.${owner.customerId}`, { token: owner.token, method: 'PATCH', body })).status).toBeGreaterThanOrEqual(400);
  }
  await expect(database`update public.customers set auth_user_id=${other.userId}::uuid where id=${owner.customerId}::uuid`.execute()).rejects.toThrow('account link');
  await checked(api(`/auth/v1/admin/users/${owner.userId}`, { service: true, method: 'PUT', body: { email: `changed-${crypto.randomUUID()}@test.com`, email_confirm: true } }));
  expect((await customer(owner)).email).toBe(contact);
  const order = await fixtureOrder(fixture, owner, 1, false);
  const rows = await checked<Array<{ customer_id: string; email: string }>>(api(`/rest/v1/orders?id=eq.${order.id}&select=customer_id,email`, { token: owner.token }));
  expect(rows[0]).toEqual({ customer_id: owner.customerId, email: contact });
  await checked(rpc('cancel_order', { order_id: order.id }, owner.token));
});

test('支付 service RPC 接收已验证的 Auth actor，不把客户 UUID 当登录身份', async () => {
  const owner = await signup(); const order = await fixtureOrder(fixture, owner);
  expect((await rpc('create_payment_intent_for_customer', { order_id: order.id, actor_id: owner.customerId, provider: 'paypal', idempotency_key: crypto.randomUUID() }, undefined, true)).status).toBe(400);
  const intent = await fixtureIntent(order, owner);
  expect((await rpc('prepare_paypal_capture', { payment_intent_id: intent.id, actor_id: owner.customerId }, undefined, true)).status).toBe(400);
  await settleIntent(intent);
  const [event] = await database`select actor_id from public.order_events where order_id=${order.id}::uuid and type='order_created'`;
  expect(event.actor_id).toBe(owner.userId);
});

test('删除 Auth 只解除客户关联，保留商业身份/订单与资金；新同邮箱账号不能接管历史', async () => {
  const owner = await signup(); const order = await fixtureOrder(fixture, owner);
  await settleIntent(await fixtureIntent(order, owner));
  expect((await api(`/auth/v1/admin/users/${owner.userId}`, { service: true, method: 'DELETE' })).status).toBe(200);
  expect(await customer(owner)).toMatchObject({ id: owner.customerId, auth_user_id: null, email: owner.email });
  const replacement = await signup(owner.email); expect(replacement.customerId).not.toBe(owner.customerId);
  for (const token of [owner.token, replacement.token]) {
    expect((await rpc('get_order_ledger', { order_id: order.id }, token)).status).toBe(400);
    expect(await checked<unknown[]>(api(`/rest/v1/orders?id=eq.${order.id}&select=id`, { token }))).toEqual([]);
  }
  expect(await checked(rpc('get_order_ledger', { order_id: order.id }, admin.token))).toMatchObject({ balances: { captured: 10, is_balanced: true } });
});

test('没有活跃客户映射时授权必须失败关闭，不能借 NULL 比较读写其他人的订单/地址/Quote', async () => {
  const owner = await signup(), erased = await signup();
  const order = await fixtureOrder(fixture, owner, 1, false);
  const quote = await checked<Quote>(rpc('create_checkout_quote', { items: items(), address: TEST_ADDRESS, idempotency_key: crypto.randomUUID() }, owner.token));
  const [address] = await checked<Array<{ id: string }>>(api('/rest/v1/addresses', { token: owner.token, method: 'POST', body: TEST_ADDRESS }));
  await checked(rpc('anonymize_customer', { customer_id: erased.customerId }, admin.token));
  expect(await checked(rpc('current_customer_id', {}, erased.token))).toBeNull();
  for (const [command, body] of [
    ...['get_order_ledger', 'get_order_pricing', 'get_order_fulfillment_balance', 'get_payment_operations', 'cancel_order'].map(name => [name, { order_id: order.id }]),
    ['update_order_address', { order_id: order.id, address: TEST_ADDRESS }],
    ['get_checkout_quote', { quote_id: quote.id }], ['cancel_checkout_quote', { quote_id: quote.id }],
    ['set_default_address', { address_id: address.id }],
  ] as Array<[string, object]>) expect((await rpc(command, body, erased.token)).status).toBe(400);
  expect((await rpc('create_order', { items: items(), address: TEST_ADDRESS }, erased.token)).status).toBe(400);
  await checked(rpc('cancel_order', { order_id: order.id }, owner.token));
  await checked(rpc('cancel_checkout_quote', { quote_id: quote.id }, owner.token));
});

test('客户匿名化清联系信息、地址、metafield 和 Cart，不删除订单，也不自动恢复字段', async () => {
  const owner = await signup(); const cart = await filled(owner, { address: TEST_ADDRESS, note: 'private note', items: items(1, { name: 'private text' }) });
  await checked(api('/rest/v1/addresses', { token: owner.token, method: 'POST', body: TEST_ADDRESS }));
  await checked(api('/rest/v1/metafields', { token: admin.token, method: 'POST', body: { owner_type: 'customer', owner_id: owner.customerId, namespace: 'contact', key: 'text', type: 'text', value: 'private' } }));
  const order = await fixtureOrder(fixture, owner); await checked(rpc('mark_order_paid', { order_id: order.id }, admin.token));
  const erased = await checked<Customer>(rpc('anonymize_customer', { customer_id: owner.customerId }, admin.token));
  expect(erased).toMatchObject({ email: null, full_name: '', phone: null, anonymized_at: expect.any(String) });
  expect(await database`select id from commerce.carts where id=${cart.id}::uuid`).toHaveLength(0);
  expect(await database`select id from public.addresses where customer_id=${owner.customerId}::uuid`).toHaveLength(0);
  expect(await database`select id from public.metafields where owner_type='customer' and owner_id=${owner.customerId}::uuid`).toHaveLength(0);
  await expect(database`update public.customers set full_name='restored' where id=${owner.customerId}::uuid`.execute()).rejects.toThrow('cannot be restored');
  expect(await checked(rpc('get_order_ledger', { order_id: order.id }, admin.token))).toMatchObject({ balances: { captured: 10 } });
});

test('游客 Cart 只返回一次随机凭据，数据库仅存哈希；错误/缺失凭据和其他 Cart ID 都拒绝', async () => {
  const cart = await create(); const another = await create();
  expect(cart.customer_id).toBeNull(); expect(cart.guest_token).toMatch(/^[0-9a-f]{64}$/);
  expect(cart.guest_token).not.toBe(another.guest_token);
  const [stored] = await database`select guest_token_hash from commerce.carts where id=${cart.id}::uuid`;
  expect(stored.guest_token_hash).not.toBe(cart.guest_token);
  const result = await checked<Cart>(get(cart));
  expect(result).not.toHaveProperty('guest_token'); expect(result).not.toHaveProperty('guest_token_hash'); expect(result).not.toHaveProperty('last_mutation_hash');
  for (const token of [null, 'bad', another.guest_token, cart.guest_token!.toUpperCase()]) expect((await rpc('get_cart', { cart_id: cart.id, guest_token: token })).status).toBe(400);
  expect((await rpc('checkout_cart', { cart_id: cart.id, expected_version: 1 })).status).toBe(401);
});

test('Cart 可以为空，行 ID/属性稳定；同内容重排/拆行重试幂等，冲突版本不会覆盖', async () => {
  const owner = await signup(); const cart = await create(owner);
  expect((await checked<{ pricing: unknown }>(rpc('preview_cart', { cart_id: cart.id }, owner.token))).pricing).toBeNull();
  const payload = { items: [...items(1, { gift: 'Alice' }), ...items(2, { gift: 'Bob' })], address: TEST_ADDRESS, note: 'gift' };
  const saved = await checked<Cart>(update(cart, owner, payload)); expect(saved.version).toBe(2); expect(saved.lines).toHaveLength(2);
  expect(await checked<Cart>(update(cart, owner, { ...payload, items: [...items(1, { gift: 'Bob' }), ...items(1, { gift: 'Alice' }), ...items(1, { gift: 'Bob' })] }))).toEqual(saved);
  expect((await update(cart, owner, { items: items(4) })).status).toBe(409);
  const resized = await checked<Cart>(update(saved, owner, { ...payload, items: [...items(2, { gift: 'Alice' }), ...items(1, { gift: 'Bob' })] }));
  expect(resized.lines.map(l => l.id)).toEqual(saved.lines.map(l => l.id));
  const empty = await checked<Cart>(update(resized, owner, { items: [] })); expect(empty.lines).toEqual([]); expect(empty.address).toBeNull(); expect(empty.note).toBeNull();
  expect((await rpc('checkout_cart', { cart_id: empty.id, expected_version: empty.version }, owner.token)).status).toBe(400);
});

test('Cart 拒绝数量/属性/伪造价格/未知字段和超大状态，失败不改变版本或期限', async () => {
  const cart = await create();
  for (const lines of [items(101), items(0), items(-1), [{ variant_id: fixture.variantId, quantity: 1, price: 0.01 }],
    [{ variant_id: fixture.variantId, quantity: 1, attributes: { unsafe: 1 } }],
    [{ variant_id: fixture.variantId, quantity: 1, line_key: 'forged' }],
    Array.from({ length: 51 }, (_, i) => ({ variant_id: fixture.variantId, quantity: 1, attributes: { i: `${i}` } })),
  ]) expect((await update(cart, undefined, { items: lines })).status).toBe(400);
  for (const extra of [{ note: 'x'.repeat(2001) }, { address: { country: 'US', line1: 'x'.repeat(20000) } }, { address: { recipient_name: 'Missing country' } }]) {
    expect((await update(cart, undefined, extra)).status).toBe(400);
  }
  const current = await checked<Cart>(get(cart)); expect(current.version).toBe(1); expect(current.expires_at).toBe(cart.expires_at);
});

test('Cart 不预占库存、不锁价：缺货可保留意向，转 Quote 失败原子回滚', async () => {
  const owner = await signup(); const stock = await stockOf(fixture.sku); const cart = await filled(owner, { items: items(3), address: TEST_ADDRESS });
  expect(await stockOf(fixture.sku)).toBe(stock);
  await checked(rpc('adjust_inventory', { variant_id: fixture.variantId, delta: 2 - stock, reason: 'adjust' }, admin.token));
  try {
    expect((await rpc('checkout_cart', { cart_id: cart.id, expected_version: cart.version }, owner.token)).status).toBe(400);
    expect(await checked<Cart>(get(cart, owner))).toMatchObject({ status: 'active', version: cart.version, quote_id: null });
    expect(await database`select id from commerce.checkout_quotes where customer_id=${owner.customerId}::uuid`).toHaveLength(0);
  } finally { await checked(rpc('adjust_inventory', { variant_id: fixture.variantId, delta: stock - 2, reason: 'adjust' }, admin.token)); }
});

test('预览使用当前目录价格，Cart 不存金额；生成 Quote 后继续使用原报价的失效/重计价规则', async () => {
  const owner = await signup(); const cart = await filled(owner, { address: TEST_ADDRESS });
  const price = () => checked<{ pricing: { total: number } }>(rpc('preview_cart', { cart_id: cart.id }, owner.token));
  expect((await price()).pricing.total).toBe(10);
  let quote: Quote | undefined;
  try {
    await checked(api(`/rest/v1/product_variants?id=eq.${fixture.variantId}`, { service: true, method: 'PATCH', body: { price: 12 } }));
    expect((await price()).pricing.total).toBe(12);
    expect(await checked<Cart>(get(cart, owner))).not.toHaveProperty('total');
    quote = await checked<Quote>(rpc('checkout_cart', { cart_id: cart.id, expected_version: cart.version }, owner.token));
    expect(quote.total).toBe(12);
    await checked(api(`/rest/v1/product_variants?id=eq.${fixture.variantId}`, { service: true, method: 'PATCH', body: { price: 14 } }));
    expect((await rpc('create_order_from_quote', { quote_id: quote.id }, owner.token)).status).toBe(400);
  } finally {
    await checked(api(`/rest/v1/product_variants?id=eq.${fixture.variantId}`, { service: true, method: 'PATCH', body: { price: 10 } }));
    if (quote) await checked(rpc('cancel_checkout_quote', { quote_id: quote.id }, owner.token));
  }
});

for (const online of [false, true]) test(`Cart → Quote → ${online ? 'PayPal' : '手工'} 付款保留商业行，预占与扣库各执行一次`, async () => {
  const owner = await signup(); const stock = await stockOf(fixture.sku);
  const cart = await filled(owner, { items: [...items(1, { engraving: 'Alice' }), ...items(1, { engraving: 'Bob' })], address: TEST_ADDRESS, note: 'temporary' });
  const command = { cart_id: cart.id, expected_version: cart.version };
  const quote = await checked<Quote>(rpc('checkout_cart', command, owner.token));
  expect(await checked<Quote>(rpc('checkout_cart', command, owner.token))).toEqual(quote);
  expect(await stockOf(fixture.sku)).toBe(stock);
  const terminal = await checked<Cart>(get(cart, owner)); expect(terminal).toMatchObject({ status: 'converted', quote_id: quote.id, address: null, note: null });
  expect((await update(terminal, owner)).status).toBe(400);
  expect(quote.lines.map(l => l.line_key)).toEqual(cart.lines.map(l => l.line_key));
  const order = await checked<{ id: string; total: number; currency: string }>(rpc('create_order_from_quote', { quote_id: quote.id }, owner.token));
  if (online) await settleIntent(await fixtureIntent({ ...order, itemId: quote.lines[0].id, quoteId: quote.id }, owner));
  else await checked(rpc('mark_order_paid', { order_id: order.id }, admin.token));
  expect(await stockOf(fixture.sku)).toBe(stock - 2);
  const lines = await checked<Array<{ id: string }>>(api(`/rest/v1/order_items?order_id=eq.${order.id}&select=id`, { token: owner.token }));
  expect(lines.map(l => l.id).sort()).toEqual(quote.lines.map(l => l.id).sort());
  expect(await checked(rpc('get_order_ledger', { order_id: order.id }, owner.token))).toMatchObject({ balances: { is_balanced: true, captured: 20 } });
});

test('认领需同时持登录身份和游客凭据；不自动合并现有 Cart，旧 token 随即失效', async () => {
  const owner = await signup(), other = await signup(); const existing = await filled(owner); const guest = await filled(undefined, { items: items(2, { gift: 'guest' }) });
  const claim = { cart_id: guest.id, expected_version: guest.version, guest_token: guest.guest_token };
  expect((await rpc('claim_cart', claim)).status).toBe(401);
  expect((await rpc('claim_cart', { ...claim, guest_token: 'f'.repeat(64) }, owner.token)).status).toBe(400);
  const owned = await checked<Cart>(rpc('claim_cart', claim, owner.token));
  expect(owned).toMatchObject({ id: guest.id, customer_id: owner.customerId, version: guest.version + 1 });
  expect(await checked<Cart>(rpc('claim_cart', claim, owner.token))).toEqual(owned);
  expect((await get(guest)).status).toBe(400); expect((await get(guest, other)).status).toBe(400);
  expect(await checked<Cart>(get(existing, owner))).toEqual({ ...existing, guest_token: undefined });
  expect(await checked<Cart[]>(rpc('list_carts', {}, owner.token))).toHaveLength(2);
});

test('认领并发只允许一个账号获胜，输家和游客凭据不能接管已绑定 Cart', async () => {
  const first = await signup(), second = await signup(); const cart = await filled();
  const result = await heldTransactionRace(database, async tx => {
    await tx`select set_config('request.jwt.claims', ${claims(first)}, true)`;
    await tx`select public.claim_cart(${cart.id}::uuid, ${cart.version}::integer, ${cart.guest_token!})`;
  }, () => rpc('claim_cart', { cart_id: cart.id, expected_version: cart.version, guest_token: cart.guest_token }, second.token));
  expect(result.status).toBe(400); expect((await get(cart)).status).toBe(400);
  expect(await checked<Cart>(get(cart, first))).toMatchObject({ customer_id: first.customerId });
});

test('创建幂等、5 个活跃 Cart 配额与认领共用客户锁，放弃释放名额但不触碰库存', async () => {
  const owner = await signup(); const key = crypto.randomUUID();
  const first = await create(owner, { idempotency_key: key });
  expect(await checked<Cart>(rpc('create_cart', { idempotency_key: key }, owner.token))).toEqual(first);
  expect((await rpc('create_cart', { idempotency_key: key, ttl_seconds: 60 }, owner.token)).status).toBe(400);
  for (let i = 0; i < 4; i++) await create(owner);
  expect((await rpc('create_cart', { idempotency_key: crypto.randomUUID() }, owner.token)).status).toBe(400);
  const guest = await create(); const command = { cart_id: guest.id, expected_version: guest.version, guest_token: guest.guest_token };
  expect((await rpc('claim_cart', command, owner.token)).status).toBe(400);
  expect((await get(guest)).status).toBe(200);
  const abandon = { cart_id: first.id, expected_version: first.version };
  const abandoned = await checked<Cart>(rpc('abandon_cart', abandon, owner.token));
  expect(await checked<Cart>(rpc('abandon_cart', abandon, owner.token))).toEqual(abandoned);
  expect(await checked<Cart>(rpc('claim_cart', command, owner.token))).toMatchObject({ customer_id: owner.customerId });
});

test('Cart 转 Quote 仍受共享 checkout 配额限制，失败不消耗 Cart 或额外预占', async () => {
  const owner = await signup(); const quotes: Quote[] = [];
  try {
    for (let i = 0; i < 5; i++) quotes.push(await checked<Quote>(rpc('create_checkout_quote', { items: items(), address: TEST_ADDRESS, idempotency_key: crypto.randomUUID() }, owner.token)));
    const cart = await filled(owner, { address: TEST_ADDRESS });
    expect((await rpc('checkout_cart', { cart_id: cart.id, expected_version: cart.version }, owner.token)).status).toBe(400);
    expect(await checked<Cart>(get(cart, owner))).toMatchObject({ status: 'active', version: cart.version });
  } finally { for (const q of quotes) await checked(rpc('cancel_checkout_quote', { quote_id: q.id }, owner.token)); }
});

test('受控同时编辑返回版本冲突，不静默覆盖；不同参数不能冒充上一请求重放', async () => {
  const owner = await signup(); const cart = await create(owner);
  const result = await heldTransactionRace(database, async tx => {
    await tx`select set_config('request.jwt.claims', ${claims(owner)}, true)`;
    await tx`select public.update_cart(${cart.id}::uuid, ${cart.version}::integer, ${JSON.stringify(items(2))}::text::jsonb)`;
  }, () => update(cart, owner, { items: items(3) }));
  expect(result.status).toBe(409); expect((await checked<Cart>(get(cart, owner))).lines[0].quantity).toBe(2);
});

for (const action of ['edit', 'capacity']) test(`REPEATABLE READ 旧快照不能绕过 Cart ${action} 的版本/配额`, async () => {
  const owner = await signup(); const cart = await create(owner);
  if (action === 'capacity') for (let i = 0; i < 3; i++) await create(owner);
  const ready = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const stale = database.begin(async tx => {
    await tx`set transaction isolation level repeatable read`;
    await tx`select set_config('request.jwt.claims', ${claims(owner)}, true)`;
    await tx`select count(*) from commerce.carts`;
    ready.resolve(); await release.promise;
    if (action === 'edit') await tx`select public.update_cart(${cart.id}::uuid, ${cart.version}::integer, ${JSON.stringify(items(3))}::text::jsonb)`;
    else await tx`select public.create_cart(${crypto.randomUUID()})`;
  }).then(() => null, error => { ready.reject(error); return error; });
  try {
    await ready.promise;
    if (action === 'edit') await checked(update(cart, owner, { items: items(2) })); else await create(owner);
    release.resolve(); expect(await stale).toMatchObject({ errno: '40001' });
  } finally { release.resolve(); await stale; }
});

for (const first of ['erase', 'edit']) test(`匿名化与 Cart 编辑交错，${first} 先执行都不能恢复已删除内容`, async () => {
  const owner = await signup(); const cart = await filled(owner, { address: TEST_ADDRESS });
  const result = await heldTransactionRace(database, async tx => {
    await tx`select set_config('request.jwt.claims', ${claims(first === 'erase' ? admin : owner)}, true)`;
    if (first === 'erase') await tx`select public.anonymize_customer(${owner.customerId}::uuid)`;
    else await tx`select public.update_cart(${cart.id}::uuid, ${cart.version}::integer, ${JSON.stringify(items(2))}::text::jsonb)`;
  }, () => first === 'erase' ? update(cart, owner) : rpc('anonymize_customer', { customer_id: owner.customerId }, admin.token));
  expect(result.status).toBe(first === 'erase' ? 400 : 200);
  expect(await database`select id from commerce.carts where id=${cart.id}::uuid`).toHaveLength(0);
});

for (const resource of ['addresses', 'metafields']) for (const first of ['erase', 'insert']) test(`匿名化与 ${resource} 写入串行化（${first} 先执行），不能在擦除后补入 PII`, async () => {
  const owner = await signup();
  const body = resource === 'addresses' ? { ...TEST_ADDRESS, customer_id: owner.customerId }
    : { owner_type: 'customer', owner_id: owner.customerId, namespace: 'erase', key: 'race', type: 'text', value: 'private' };
  const result = await heldTransactionRace(database, async tx => {
    await tx`select set_config('request.jwt.claims', ${claims(admin)}, true)`;
    if (first === 'erase') await tx`select public.anonymize_customer(${owner.customerId}::uuid)`;
    else if (resource === 'addresses') await tx`insert into public.addresses(customer_id,recipient_name,line1,country) values (${owner.customerId}::uuid,'Private','Street','US')`;
    else await tx`insert into public.metafields(owner_type,owner_id,namespace,key,type,value) values ('customer',${owner.customerId}::uuid,'erase','race','text','"private"')`;
  }, () => first === 'erase' ? api(`/rest/v1/${resource}`, { service: true, method: 'POST', body })
    : rpc('anonymize_customer', { customer_id: owner.customerId }, admin.token));
  expect(result.status).toBe(first === 'erase' ? 400 : 200);
  expect(await database`select id from public.addresses where customer_id=${owner.customerId}::uuid`).toHaveLength(0);
  expect(await database`select id from public.metafields where owner_type='customer' and owner_id=${owner.customerId}::uuid`).toHaveLength(0);
});

test('过期凭据不可读，清理仅 service 可调用且有上限；不因访问延长期限', async () => {
  const owner = await signup(); const active = await create(owner); const expired = crypto.randomUUID(); cartIds.push(expired);
  await database`insert into commerce.carts(id, customer_id, created_at, expires_at) values (${expired}::uuid, ${owner.customerId}::uuid, '1999-01-01', '1999-01-02')`;
  expect((await rpc('get_cart', { cart_id: expired }, owner.token)).status).toBe(400);
  expect((await rpc('purge_expired_carts', {}, owner.token)).status).toBe(403);
  for (const params of [{ max_carts: 0 }, { max_carts: 501 }, { max_carts: null }, { as_of: null }]) expect((await rpc('purge_expired_carts', params, undefined, true)).status).toBe(400);
  expect(await checked<number>(rpc('purge_expired_carts', { max_carts: 1, as_of: '2000-01-01' }, undefined, true))).toBe(1);
  expect(await checked<number>(rpc('purge_expired_carts', { as_of: '2000-01-01' }, undefined, true))).toBe(0);
  expect((await checked<Cart>(get(active, owner))).expires_at).toBe(active.expires_at);
  for (const ttl of [0, 59, 2592001, null]) expect((await rpc('create_cart', { ttl_seconds: ttl })).status).toBe(400);
});

test('物理清理 converted Cart 不取消 Quote 或释放预占，也不修改库存事实', async () => {
  const owner = await signup(); const cart = await filled(owner, { address: TEST_ADDRESS });
  const quote = await checked<Quote>(rpc('checkout_cart', { cart_id: cart.id, expected_version: cart.version }, owner.token));
  try {
    await expect(database.begin(async tx => {
      await tx`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`;
      const before = await tx`select on_hand, private.active_reserved_quantity(variant_id, location_id, null) as reserved from public.inventory_levels where variant_id=${fixture.variantId}::uuid order by location_id`;
      // Time advancement is confined to this rollback transaction.
      await tx`select public.purge_expired_carts(500, '2100-01-01'::timestamptz)`;
      expect(await tx`select id from commerce.carts where id=${cart.id}::uuid`).toHaveLength(0);
      expect(await tx<Array<{ status: string }>>`select status from commerce.checkout_quotes where id=${quote.id}::uuid`).toEqual([{ status: 'open' }]);
      expect(await tx`select on_hand, private.active_reserved_quantity(variant_id, location_id, null) as reserved from public.inventory_levels where variant_id=${fixture.variantId}::uuid order by location_id`).toEqual(before);
      throw new Error('rollback cart cleanup probe');
    })).rejects.toThrow('rollback cart cleanup probe');
  } finally { await checked(rpc('cancel_checkout_quote', { quote_id: quote.id }, owner.token)); }
});

test('Cart 表/凭据不向 API 角色开放，受信越界写入也由内容/版本/提交时限额校验拒绝', async () => {
  const cart = await filled();
  for (const role of ['anon', 'authenticated', 'service_role']) await expect(database.begin(async tx => {
    await tx.unsafe(`set local role ${role}`); await tx`select * from commerce.carts`;
  })).rejects.toMatchObject({ errno: '42501' });
  await expect(database`update commerce.cart_lines set quantity=2 where cart_id=${cart.id}::uuid`.execute()).rejects.toThrow('cart commands');
  await expect(database.begin(async tx => {
    await tx`select set_config('commerce.cart_write', ${cart.id}, true)`;
    await tx`update commerce.carts set version=version+1, expires_at=expires_at+interval '1 day' where id=${cart.id}::uuid`;
  })).rejects.toThrow('expiry and version');
  await expect(database.begin(async tx => {
    await tx`select set_config('commerce.cart_write', ${cart.id}, true)`;
    await tx`insert into commerce.cart_lines(cart_id,variant_id,quantity,attributes) values (${cart.id}::uuid,${fixture.variantId}::uuid,100,'{"extra":"line"}')`;
  })).rejects.toThrow('cart lines exceed limits');
  const [row] = await database`select bool_and(relrowsecurity) as rls from pg_class where oid in ('commerce.carts'::regclass,'commerce.cart_lines'::regclass,'public.customers'::regclass)`;
  expect(row.rls).toBe(true);
});
