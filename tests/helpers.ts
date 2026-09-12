// 测试密钥由 `supabase status -o env` 注入，避免在仓库中固化 JWT。
function requiredEnv(name: 'ANON_KEY' | 'SERVICE_ROLE_KEY'): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}; run tests with \`bun run test\` or \`bun run test:current\`.`);
  return value;
}

export const API = process.env.API_URL ?? 'http://127.0.0.1:54321';
export const ANON_KEY = requiredEnv('ANON_KEY');
export const SERVICE_KEY = requiredEnv('SERVICE_ROLE_KEY');

export interface ApiOptions {
  token?: string;        // 用户 JWT；不传 = 匿名
  service?: boolean;     // true = service role（绕过 RLS，模拟管理端/webhook）
  method?: string;
  body?: unknown;
}

export async function api(path: string, opts: ApiOptions = {}) {
  const key = opts.service ? SERVICE_KEY : ANON_KEY;
  const res = await fetch(`${API}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      apikey: key,
      Authorization: `Bearer ${opts.token ?? key}`,
      'Content-Type': 'application/json',
      ...(opts.method && opts.method !== 'GET' ? { Prefer: 'return=representation' } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

export const rpc = (name: string, body: unknown, token?: string, service = false) =>
  api(`/rest/v1/rpc/${name}`, { method: 'POST', body, token, service });

export interface TestUser {
  token: string;
  userId: string;
  customerId: string;
  email: string;
}

export async function signup(email = `t_${crypto.randomUUID()}@test.com`): Promise<TestUser> {
  const res = await fetch(`${API}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123' }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`signup failed: ${JSON.stringify(data)}`);
  const customer = await rpc('current_customer_id', {}, data.access_token);
  if (customer.status !== 200 || typeof customer.data !== 'string' || customer.data === data.user.id) throw new Error('signup did not create an independent customer');
  return { token: data.access_token, userId: data.user.id, customerId: customer.data, email };
}

export async function makeAdmin(userId: string) {
  const res = await api(`/rest/v1/profiles?id=eq.${userId}`, {
    service: true,
    method: 'PATCH',
    body: { role: 'admin' },
  });
  if (res.status >= 400) throw new Error(`makeAdmin failed: ${JSON.stringify(res.data)}`);
}

// ---------- 领域快捷方法 ----------
export async function variantBySku(sku: string): Promise<string> {
  const { data } = await api(`/rest/v1/product_variants?sku=eq.${sku}&select=id`);
  return (data as { id: string }[])[0].id;
}

export async function shippingByName(name: string): Promise<string> {
  const { data } = await api(
    `/rest/v1/shipping_methods?name=eq.${encodeURIComponent(name)}&select=id`
  );
  return (data as { id: string }[])[0].id;
}

// 库存数只能通过 service role 读（RLS 不对外）
export async function stockOf(sku: string, locationId?: string): Promise<number> {
  const { data } = await api(
    `/rest/v1/inventory_levels?select=on_hand,product_variants!inner(sku)&product_variants.sku=eq.${sku}${locationId ? `&location_id=eq.${locationId}` : ''}`,
    { service: true }
  );
  return (data as { on_hand: number }[])[0].on_hand;
}

export const TEST_ADDRESS = {
  recipient_name: 'Alex Morgan',
  country: 'US',
  region: 'NY',
  city: 'New York',
  line1: '123 Example Street',
  line2: 'Apt 4B',
  postal_code: '10001',
};

// Explicit, fictitious test rule, never a seed/default or a claim about US tax law.
export async function installTestTax(country = 'US', rate = 0.13): Promise<() => Promise<void>> {
  const created = await api('/rest/v1/tax_rates?select=id', {
    service: true, method: 'POST', body: { name: 'Test-only tax', country, rate },
  });
  if (created.status >= 400) throw new Error(`test tax setup failed: ${JSON.stringify(created.data)}`);
  const [{ id }] = created.data as { id: string }[];
  return async () => {
    const deleted = await api(`/rest/v1/tax_rates?id=eq.${id}`, { service: true, method: 'PATCH', body: { is_active: false } });
    if (deleted.status >= 400) throw new Error(`test tax cleanup failed: ${JSON.stringify(deleted.data)}`);
  };
}
