import { afterAll, beforeAll, expect, test } from 'bun:test';
import { withRollback } from '../scripts/lib/transactions';
import { testDatabase } from './database-concurrency';
import { api, checked, command, makeAdmin, rpc, signup, TEST_ADDRESS, type TestUser } from './helpers';

const db = testDatabase();
let admin: TestUser, buyer: TestUser;
interface Customer { id: string; full_name: string; email: string | null; has_account: boolean }
interface Page { items: Customer[]; next_cursor: { created_at: string; id: string } | null }
beforeAll(async () => { [admin,buyer] = await Promise.all([signup(),signup()]); await makeAdmin(admin.userId); });
afterAll(() => db.close());

test('客户列表保留同邮箱独立客户，按微秒时间/UUID 分页并按名称、邮箱、电话字面搜索', async () => {
  await withRollback(db, async sql => {
    const ids = Array.from({ length: 3 }, () => crypto.randomUUID()).sort(), marker = crypto.randomUUID();
    for (let i = 0; i < 3; i++) {
      await sql`insert into public.customers(id,email,full_name,phone,created_at)
        values (${ids[i]}::uuid,${marker + '@example.test'},${'Name%_' + i},${'Phone' + marker + i},
          ${i === 0 ? '2026-01-01T00:00:00.123457Z' : '2026-01-01T00:00:00.123456Z'}::timestamptz)`;
    }
    await sql`select set_config('request.jwt.claims',${JSON.stringify({ sub: admin.userId, role: 'authenticated' })},true)`;
    await sql`set local role authenticated`;
    const first = (await sql`select public.list_admin_customers(page_size=>2,search=>${' ' + marker.toUpperCase() + '@EXAMPLE.TEST '}) dto`)[0].dto as Page;
    expect(first.items.map(c => c.id)).toEqual([ids[0],ids[2]]);
    expect(first.next_cursor?.created_at).toContain('.123456');
    const next = (await sql.unsafe('select public.list_admin_customers(page_size=>2,search=>$1,after_cursor=>$2::text::jsonb) dto',
      [marker,JSON.stringify(first.next_cursor)]))[0].dto as Page;
    expect(next.items.map(c => c.id)).toEqual([ids[1]]); expect(next.next_cursor).toBeNull();
    expect(Object.keys(first.items[0]).sort()).toEqual(['id','email','full_name','phone','has_account','anonymized_at','created_at','updated_at'].sort());
    expect(first.items[0].has_account).toBe(false);
    expect((await sql`select public.list_admin_customers(search=>${'phone' + marker + '2'}) dto`)[0].dto.items[0].id).toBe(ids[2]);
    expect((await sql`select public.list_admin_customers(search=>'Name%_1') dto`)[0].dto.items.map((c: Customer) => c.id)).toEqual([ids[1]]);
    expect((await sql`select public.list_admin_customers(search=>${marker + '%'}) dto`)[0].dto.items).toEqual([]);
    await sql`select public.anonymize_customer(${ids[1]}::uuid)`;
    expect((await sql`select public.get_admin_customer(${ids[1]}::uuid) dto`)[0].dto).toMatchObject({ email: null, full_name: '', addresses: [], metafields: [] });
    expect((await sql`select public.list_admin_customers(anonymized=>false,search=>${marker}) dto`)[0].dto.items).toHaveLength(2);
    // A reused local database can contain more than one page of anonymized users.
    let cursor: Page['next_cursor'] = null, found = false;
    do {
      const anonymous = (await sql.unsafe(
        'select public.list_admin_customers(anonymized=>true,page_size=>100,after_cursor=>$1::jsonb) dto',
        [cursor === null ? null : JSON.stringify(cursor)],
      ))[0].dto as Page;
      found = anonymous.items.some(c => c.id === ids[1]);
      cursor = anonymous.next_cursor;
    } while (!found && cursor !== null);
    expect(found).toBe(true);
  });
});

test('客户管理详情仅管理员可读，地址/扩展正确归属；匿名化后不恢复联系资料', async () => {
  await checked(api('/rest/v1/addresses', { token: buyer.token, method: 'POST', body: { ...TEST_ADDRESS, label: 'Home', is_default: true } }));
  await checked(api('/rest/v1/metafields', { service: true, method: 'POST', body: {
    owner_type: 'customer', owner_id: buyer.customerId, namespace: 'custom', key: 'internal', type: 'text', value: 'VIP note',
  } }));
  const detail = await checked<Record<string, unknown>>(rpc('get_admin_customer',{ customer_id: buyer.customerId },admin.token));
  expect(detail).toMatchObject({ id: buyer.customerId, has_account: true, email: buyer.email,
    addresses: [{ label: 'Home', recipient_name: TEST_ADDRESS.recipient_name, is_default: true }], metafields: [{ value: 'VIP note' }] });
  expect(detail).not.toHaveProperty('auth_user_id'); expect(detail).not.toHaveProperty('role');
  expect(await checked<unknown>(rpc('get_admin_customer',{ customer_id: buyer.customerId },undefined,true))).toEqual(detail);
  expect(await checked<unknown>(rpc('get_admin_customer',{ customer_id: buyer.userId },admin.token))).toBeNull();
  for (const token of [undefined,buyer.token]) {
    expect((await rpc('get_admin_customer',{ customer_id: buyer.customerId },token)).data).toMatchObject({ code: '42501' });
    expect((await rpc('list_admin_customers',{},token)).data).toMatchObject({ code: '42501' });
  }
  await checked(command('anonymize_customer',{ customer_id: buyer.customerId },admin.token));
  expect(await checked<Record<string, unknown>>(rpc('get_admin_customer',{ customer_id: buyer.customerId },admin.token)))
    .toMatchObject({ email: null, full_name: '', phone: null, has_account: true, addresses: [], metafields: [] });
});

test('客户列表限制分页和输入，空结果与不存在详情不泄露其他对象', async () => {
  const cursor = { created_at: '2026-01-01T00:00:00Z', id: crypto.randomUUID() };
  for (const args of [{ page_size: 0 },{ page_size: 101 },{ page_size: null },{ search: 'x'.repeat(201) },
    { after_cursor: [] },{ after_cursor: {} },{ after_cursor: { ...cursor, created_at: 'infinity' } },
    { after_cursor: { ...cursor, id: null } },{ after_cursor: { ...cursor, extra: true } }]) {
    expect((await rpc('list_admin_customers',args,admin.token)).status).toBe(400);
  }
  expect(await checked<Page>(rpc('list_admin_customers',{ page_size: 100, search: 'x'.repeat(200) },admin.token)))
    .toEqual({ items: [], next_cursor: null });
  expect(await checked<unknown>(rpc('get_admin_customer',{ customer_id: crypto.randomUUID() },admin.token))).toBeNull();
});
