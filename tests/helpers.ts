import type { Database } from '../types/database';
import { createApi, onlyRow, checked } from './support/http';
export { checked, onlyRow } from './support/http';
export type { ApiOptions, ApiResult } from './support/http';

// 测试密钥由 scripts/test.ts 从本项目 Supabase 注入，不固化 JWT。
function requiredEnv(name: 'ANON_KEY' | 'SERVICE_ROLE_KEY'): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}; run tests with \`bun run test\` or \`bun run test:current\`.`);
  return value;
}

export const API = process.env.API_URL ?? 'http://127.0.0.1:54321';
export const ANON_KEY = requiredEnv('ANON_KEY');
export const SERVICE_KEY = requiredEnv('SERVICE_ROLE_KEY');

export const api = createApi({ url: API, anonKey: ANON_KEY, serviceKey: SERVICE_KEY });

// Raw boundary for negative tests (invalid fields/types/NULL are intentional).
export const rpc = (name: string, body: unknown, token?: string, service = false) =>
  api(`/rest/v1/rpc/${name}`, { method: 'POST', body, token, service });

type Functions = Database['public']['Functions'];
// Positive fixtures use the generated input contract; JSON DTO assertions stay
// independent of production implementations and are deliberately not generated.
export const command = <N extends keyof Functions>(name: N, body: Functions[N]['Args'], token?: string, service = false) =>
  rpc(name, body, token, service);

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
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error(`signup failed: ${JSON.stringify(data)}`);
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
  return (await onlyRow<{ id: string }>(api(`/rest/v1/product_variants?sku=eq.${encodeURIComponent(sku)}&select=id`))).id;
}

export async function shippingByName(name: string): Promise<string> {
  return (await onlyRow<{ id: string }>(api(`/rest/v1/shipping_methods?name=eq.${encodeURIComponent(name)}&select=id`))).id;
}

// 库存数只能通过 service role 读（RLS 不对外）
export async function stockOf(sku: string, locationId?: string): Promise<number> {
  const location = locationId ? `&location_id=eq.${locationId}` : '&locations.is_default=eq.true';
  return (await onlyRow<{ on_hand: number }>(api(
    `/rest/v1/inventory_levels?select=on_hand,product_variants!inner(sku)${locationId ? '' : ',locations!inner(is_default)'}&product_variants.sku=eq.${encodeURIComponent(sku)}${location}`,
    { service: true },
  ))).on_hand;
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
  const { id } = await onlyRow<{ id: string }>(api('/rest/v1/tax_rates?select=id', {
    service: true, method: 'POST', body: { name: 'Test-only tax', country, rate },
  }));
  return async () => { await checked(api(`/rest/v1/tax_rates?id=eq.${id}`, { service: true, method: 'PATCH', body: { is_active: false } })); };
}
