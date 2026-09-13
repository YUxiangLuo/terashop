export interface ApiOptions {
  token?: string;
  service?: boolean;
  method?: string;
  body?: unknown;
  returning?: 'representation' | 'minimal';
}
export interface ApiResult { status: number; data: unknown }

export type HttpTransport = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export function createApi(config: { url: string; anonKey: string; serviceKey: string }, transport?: HttpTransport) {
  return async (path: string, opts: ApiOptions = {}): Promise<ApiResult> => {
    const key = opts.service ? config.serviceKey : config.anonKey;
    // Resolve fetch per request so the handler harness can intercept it.
    const response = await (transport ?? globalThis.fetch)(`${config.url}${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        apikey: key,
        Authorization: `Bearer ${opts.token ?? key}`,
        'Content-Type': 'application/json',
        ...(opts.method && opts.method !== 'GET' ? { Prefer: `return=${opts.returning ?? 'representation'}` } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: response.status, data };
  };
}

export async function checked<T>(response: Promise<ApiResult>): Promise<T> {
  const result = await response;
  if (result.status < 200 || result.status >= 300) throw new Error(`API request failed: ${JSON.stringify(result)}`);
  return result.data as T;
}

export async function onlyRow<T>(response: Promise<ApiResult>): Promise<T> {
  const rows = await checked<unknown>(response);
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error('Expected exactly one API row');
  return rows[0] as T;
}
