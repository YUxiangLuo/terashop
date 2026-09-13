import { afterAll, beforeAll, expect, test } from 'bun:test';
import { api, checked, rpc, signup, makeAdmin, type TestUser } from './helpers';
import { authMail, authMessages } from './support/mail';
import { paymentFixture, fixtureOrder, fixtureIntent, settleIntent, type PaymentFixture } from './payment-fixtures';
import { testDatabase } from './database-concurrency';

interface Session { access_token: string; user: { id: string; is_anonymous: boolean; email: string } }
const database = testDatabase();
let admin: TestUser, fixture: PaymentFixture;
beforeAll(async () => { admin = await signup(); await makeAdmin(admin.userId); fixture = await paymentFixture(admin); });
afterAll(async () => {
  try {
    if (fixture) await checked(api(`/rest/v1/products?id=eq.${fixture.productId}`, {
      service: true, method: 'PATCH', body: { status: 'archived' },
    }));
  } finally { await database.close(); }
});
const login = (email: string, password: string) => api('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } });
const verify = (link: URL) => api('/auth/v1/verify', { method: 'POST', body: {
  type: link.searchParams.get('type'), token_hash: link.searchParams.get('token'),
} });

test('游客通过真实邮件验证升级注册：验证前不能设密码，原 Customer、Cart 与已支付订单不变', async () => {
  const guest = await checked<Session>(api('/auth/v1/signup', { method: 'POST', body: {} }));
  const customerId = await checked<string>(rpc('current_customer_id', {}, guest.access_token));
  const contact = `contact-${crypto.randomUUID()}@test.com`, email = `login-${crypto.randomUUID()}@test.com`;
  await checked(api(`/rest/v1/customers?id=eq.${customerId}`, {
    token: guest.access_token, method: 'PATCH', body: { email: contact },
  }));
  const buyer = { token: guest.access_token, customerId, userId: guest.user.id, email: contact };
  const cart = await checked<{ id: string }>(rpc('create_cart', { idempotency_key: crypto.randomUUID() }, buyer.token));
  const order = await fixtureOrder(fixture, buyer);
  await settleIntent(await fixtureIntent(order, buyer));
  expect(await checked(rpc('get_admin_customer', { customer_id: customerId }, admin.token))).toMatchObject({ has_account: false });
  await checked(api('/auth/v1/user', { token: buyer.token, method: 'PUT', body: { email } }));
  expect((await api('/auth/v1/user', { token: buyer.token, method: 'PUT', body: { password: 'new-password123' } })).status).toBeGreaterThanOrEqual(400);
  expect((await login(email, 'new-password123')).status).toBeGreaterThanOrEqual(400);
  const mail = await authMail(email, 'email_change');
  expect(mail.searchParams.get('redirect_to')).toBe('http://127.0.0.1:3000');
  const wrong = new URL(mail); wrong.searchParams.set('token', '0'.repeat(64));
  expect((await verify(wrong)).status).toBeGreaterThanOrEqual(400);
  const verified = await checked<Session>(verify(mail));
  expect(verified.user).toMatchObject({ id: buyer.userId, email, is_anonymous: false });
  expect((await verify(mail)).status).toBeGreaterThanOrEqual(400);
  await checked(api('/auth/v1/user', { token: verified.access_token, method: 'PUT', body: { password: 'new-password123' } }));
  await checked(api('/auth/v1/logout', { token: verified.access_token, method: 'POST' }));
  const registered = await checked<Session>(login(email, 'new-password123'));
  expect(registered.user.id).toBe(buyer.userId);
  expect(await checked<string>(rpc('current_customer_id', {}, registered.access_token))).toBe(customerId);
  expect(await checked(rpc('get_cart', { cart_id: cart.id }, registered.access_token))).toMatchObject({ id: cart.id, customer_id: customerId });
  expect(await checked(rpc('get_customer_order', { order_id: order.id }, registered.access_token))).toMatchObject({ email: contact, financial_status: 'paid' });
  expect(await checked(rpc('get_admin_customer', { customer_id: customerId }, admin.token))).toMatchObject({ email: contact, has_account: true });
  const rows = await checked<Array<{ id: string; email: string }>>(api(`/rest/v1/profiles?id=eq.${buyer.userId}&select=id,email`, { token: registered.access_token }));
  expect(rows).toEqual([{ id: buyer.userId, email }]);
});

test('已注册邮箱不能被游客绑定，不合并 Customer 或接管已有订单', async () => {
  const existing = await signup();
  const order = await fixtureOrder(fixture, existing);
  const guest = await checked<Session>(api('/auth/v1/signup', { method: 'POST', body: {} }));
  const id = await checked<string>(rpc('current_customer_id', {}, guest.access_token));
  expect((await api('/auth/v1/user', { token: guest.access_token, method: 'PUT', body: { email: existing.email } })).status).toBeGreaterThanOrEqual(400);
  expect(await checked<string>(rpc('current_customer_id', {}, guest.access_token))).toBe(id);
  expect(id).not.toBe(existing.customerId);
  expect(await checked(rpc('get_customer_order', { order_id: order.id }, guest.access_token))).toBeNull();
  expect(await checked(api('/auth/v1/user', { token: guest.access_token }))).toMatchObject({ is_anonymous: true });
  await checked(rpc('cancel_order', { order_id: order.id }, existing.token));
});

test('普通注册必须确认邮件才能登录；密码找回邮件可重设密码且令牌只能使用一次', async () => {
  const email = `recovery-${crypto.randomUUID()}@test.com`;
  const pending = await checked<Record<string, unknown>>(api('/auth/v1/signup', { method: 'POST', body: { email, password: 'password123' } }));
  expect(pending).not.toHaveProperty('access_token');
  expect((await login(email, 'password123')).data).toMatchObject({ error_code: 'email_not_confirmed' });
  const confirmed = await checked<Session>(verify(await authMail(email, 'signup')));
  await checked(api('/auth/v1/recover', { method: 'POST', body: { email } }));
  const recovery = await authMail(email, 'recovery');
  const recovered = await checked<Session>(verify(recovery));
  expect(recovered.user.id).toBe(confirmed.user.id);
  expect((await verify(recovery)).status).toBeGreaterThanOrEqual(400);
  await checked(api('/auth/v1/user', { token: recovered.access_token, method: 'PUT', body: { password: 'recovered-password123' } }));
  expect((await login(email, 'password123')).status).toBeGreaterThanOrEqual(400);
  expect((await checked<Session>(login(email, 'recovered-password123'))).user.id).toBe(confirmed.user.id);
});

test('注册账户改邮箱仅确认新地址；确认前后登录归属、profile 与商业邮箱正确分离', async () => {
  const owner = await signup(), other = await signup();
  const order = await fixtureOrder(fixture, owner);
  const email = `changed-${crypto.randomUUID()}@test.com`;
  const oldMailIds = (await authMessages(owner.email)).map(row => row.ID);
  expect((await api('/auth/v1/user', { token: owner.token, method: 'PUT', body: { email: other.email } })).data)
    .toMatchObject({ error_code: 'email_exists' });
  await checked(api('/auth/v1/user', { token: owner.token, method: 'PUT', body: { email } }));
  expect((await checked<Session>(login(owner.email, 'password123'))).user.id).toBe(owner.userId);
  expect((await login(email, 'password123')).status).toBe(400);
  expect(await checked(api('/auth/v1/user', { token: owner.token }))).toMatchObject({ email: owner.email, new_email: email });
  const link = await authMail(email, 'email_change');
  // Current local contract is double_confirm_changes=false: no old-address confirmation.
  expect((await authMessages(owner.email)).map(row => row.ID)).toEqual(oldMailIds);
  expect((await checked<Session>(verify(link))).user).toMatchObject({ id: owner.userId, email });
  expect((await login(owner.email, 'password123')).status).toBe(400);
  const session = await checked<Session>(login(email, 'password123'));
  expect(await checked<string>(rpc('current_customer_id', {}, session.access_token))).toBe(owner.customerId);
  expect(await checked<Array<{ email: string }>>(api(`/rest/v1/profiles?id=eq.${owner.userId}&select=email`, { token: session.access_token })))
    .toEqual([{ email }]);
  expect(await checked(rpc('get_admin_customer', { customer_id: owner.customerId }, admin.token))).toMatchObject({ email: owner.email });
  expect(await checked(rpc('get_customer_order', { order_id: order.id }, session.access_token))).toMatchObject({ email: owner.email });
  expect((await verify(link)).data).toMatchObject({ error_code: 'otp_expired' });
  await checked(rpc('cancel_order', { order_id: order.id }, session.access_token));
});

// Only owned disposable Auth fixtures are retimed. Tokens always come from real
// SMTP; never rewrite a token, confirmation flag, global clock or Auth config.
for (const type of ['signup', 'recovery', 'email_change'] as const) {
  const column = { signup: 'confirmation_sent_at', recovery: 'recovery_sent_at', email_change: 'email_change_sent_at' }[type];
  const age = (id: string, seconds: number) => database.unsafe(
    `update auth.users set ${column} = clock_timestamp() - make_interval(secs => $2) where id = $1::uuid`, [id, seconds]);
  async function pendingMail() {
    const email = `${type}-${crypto.randomUUID()}@test.com`;
    if (type === 'signup') {
      const user = await checked<{ id: string }>(api('/auth/v1/signup', { method: 'POST', body: { email, password: 'password123' } }));
      return { id: user.id, email, send: () => api('/auth/v1/resend', { method: 'POST', body: { type, email } }) };
    }
    const owner = await signup();
    if (type === 'recovery') {
      const send = () => api('/auth/v1/recover', { method: 'POST', body: { email: owner.email } });
      await checked(send());
      return { id: owner.userId, email: owner.email, send };
    }
    await checked(api('/auth/v1/user', { token: owner.token, method: 'PUT', body: { email } }));
    return { id: owner.userId, email, send: () => api('/auth/v1/resend', { method: 'POST', body: { type, email: owner.email } }) };
  }

  test(`${type} 重发节流不投递、不废弃原令牌`, async () => {
    const pending = await pendingMail();
    const link = await authMail(pending.email, type);
    const ids = (await authMessages(pending.email)).map(row => row.ID);
    // Keep Auth's real send timestamp. A near-zero cooldown must fail this test.
    // The local 60s window leaves room for SMTP and CI scheduling.
    const limited = await pending.send();
    expect(limited).toMatchObject({ status: 429, data: { error_code: 'over_email_send_rate_limit' } });
    expect((await authMessages(pending.email)).map(row => row.ID)).toEqual(ids);
    expect((await checked<Session>(verify(link))).user.id).toBe(pending.id);
  });

  test(`${type} 3600秒期限内有效、期限外拒绝；成功重发替换旧令牌`, async () => {
    const pending = await pendingMail();
    const first = await authMail(pending.email, type);
    const ids = (await authMessages(pending.email)).map(row => row.ID);
    await age(pending.id, 61); // outside cooldown, but first token is still valid
    await checked(pending.send());
    const second = await authMail(pending.email, type, ids);
    // The old link must fail even after resend refreshed the user's timestamp.
    expect(await verify(first)).toMatchObject({ status: 403, data: { error_code: 'otp_expired' } });
    await age(pending.id, 3601);
    expect(await verify(second)).toMatchObject({ status: 403, data: { error_code: 'otp_expired' } });
    await age(pending.id, 3540); // one minute inside expiry, avoiding request-latency races
    expect((await checked<Session>(verify(second))).user.id).toBe(pending.id);
    expect(await verify(second)).toMatchObject({ status: 403, data: { error_code: 'otp_expired' } });
  });
}
