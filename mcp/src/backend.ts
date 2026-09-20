import type { Database, Json } from '../../types/database';

export type Functions = Database['public']['Functions'];

export class BackendError extends Error {
  constructor(
    readonly code: string,
    readonly outcomeUnknown = false,
  ) {
    super(code);
  }
}

export interface BackendConfig {
  url: string;
  anonKey: string;
  accessToken: string;
}

// Stdio uses a locally supplied user session, never an MCP HTTP bearer token.
// No privileged fallback, refresh-token storage, or credentials in tool inputs.
export class AdminBackend {
  private readonly url: string;
  private readonly headers: Record<string, string>;

  constructor(
    config: BackendConfig,
    private readonly request: (url: string, init: RequestInit) => Promise<Response> = fetch,
  ) {
    const url = new URL(config.url);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    ) {
      throw new Error('Supabase URL must be an HTTPS origin (HTTP is allowed only on loopback)');
    }
    if (!config.anonKey || !config.accessToken) throw new Error('Missing Supabase credentials');
    this.url = url.origin;
    this.headers = {
      apikey: config.anonKey,
      Authorization: `Bearer ${config.accessToken}`,
      'Content-Type': 'application/json',
    };
  }

  private async json(
    path: string,
    body?: unknown,
    mutation = false,
    upload?: { bytes: Uint8Array<ArrayBuffer>; contentType: string },
  ): Promise<Json> {
    let response: Response;
    try {
      response = await this.request(`${this.url}${path}`, {
        method: upload || body !== undefined ? 'POST' : 'GET',
        headers: upload
          ? { ...this.headers, 'Content-Type': upload.contentType, 'x-upsert': 'false' }
          : this.headers,
        body: upload ? upload.bytes : body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new BackendError('BACKEND_UNAVAILABLE', mutation);
    }
    if (!response.ok) {
      // SQL messages/details can contain PII, request values and secrets. Only
      // expose a validated machine code; do not stringify backend exceptions.
      const failure = await response.json().catch(() => null);
      const code =
        typeof failure?.code === 'string' && /^(?:[0-9A-Z]{5}|PGRST\d{3})$/.test(failure.code)
          ? failure.code
          : `HTTP_${response.status}`;
      throw new BackendError(code, mutation && response.status >= 500);
    }
    try {
      return await response.json();
    } catch {
      throw new BackendError('INVALID_BACKEND_RESPONSE', mutation);
    }
  }

  async assertAdmin(): Promise<void> {
    const user = await this.json('/auth/v1/user');
    if (
      !user ||
      typeof user !== 'object' ||
      Array.isArray(user) ||
      typeof user.id !== 'string' ||
      user.is_anonymous !== false ||
      user.role !== 'authenticated'
    ) {
      throw new BackendError('ADMIN_REQUIRED');
    }
    if ((await this.json('/rest/v1/rpc/is_admin', {})) !== true) {
      throw new BackendError('ADMIN_REQUIRED');
    }
  }

  async rpc<N extends keyof Functions>(
    name: N,
    args: Functions[N]['Args'],
    mutation: boolean,
  ): Promise<Json> {
    // Recheck on every call, including replay, so role revocation takes effect.
    // The target RPC also checks permissions within its own transaction.
    await this.assertAdmin();
    return this.json(`/rest/v1/rpc/${name}`, args, mutation);
  }

  async uploadProductMedia(args: {
    product_id: string;
    media_id: string;
    content_type: 'image/jpeg' | 'image/png' | 'image/webp';
    data_base64: string;
  }): Promise<Json> {
    // Existing product lookup rechecks admin membership. Storage independently
    // enforces insert-only admin RLS; upload never edits product associations.
    if ((await this.rpc('get_admin_product', { product_id: args.product_id }, false)) === null) {
      throw new BackendError('PT404');
    }
    const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[args.content_type];
    const path = `products/${args.product_id.toLowerCase()}/${args.media_id.toLowerCase()}.${extension}`;
    await this.json(`/storage/v1/object/catalog-media/${path}`, undefined, true, {
      bytes: Buffer.from(args.data_base64, 'base64'),
      contentType: args.content_type,
    });
    return { path, url: `${this.url}/storage/v1/object/public/catalog-media/${path}` };
  }
}
