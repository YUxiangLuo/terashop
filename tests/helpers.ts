// 测试辅助：本地 Supabase 的固定 dev key（仅本地有效，随 supabase start 不变）
export const API = 'http://127.0.0.1:54321';
export const ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
export const SERVICE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

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

let seq = 0;
export interface TestUser {
  token: string;
  userId: string;
  email: string;
}

export async function signup(): Promise<TestUser> {
  const email = `t${Date.now()}_${seq++}@test.com`;
  const res = await fetch(`${API}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123' }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`signup failed: ${JSON.stringify(data)}`);
  return { token: data.access_token, userId: data.user.id, email };
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
export async function stockOf(sku: string): Promise<number> {
  const { data } = await api(
    `/rest/v1/inventory_levels?select=on_hand,product_variants!inner(sku)&product_variants.sku=eq.${sku}`,
    { service: true }
  );
  return (data as { on_hand: number }[])[0].on_hand;
}

export const CN_ADDRESS = {
  receiver: '张三',
  phone: '13800000000',
  country: 'CN',
  province: '上海',
  city: '上海',
  detail: '浦东新区世纪大道 1 号',
};
