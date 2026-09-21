import type { Database, Json } from '../../types/database';
import { createHash } from 'node:crypto';
import * as z from 'zod/v4';
import { paypalRefund, paypalRefundResult, productMediaIdentity, managedMedia } from './schemas';

export type Functions = Database['public']['Functions'];
// Supabase emits Args: never for parameterless RPCs; PostgREST accepts {}.
export type RpcArgs<N extends keyof Functions> = [Functions[N]['Args']] extends [never]
  ? Record<string, never>
  : Functions[N]['Args'];

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

  async rpc<N extends keyof Functions>(name: N, args: RpcArgs<N>, mutation: boolean): Promise<Json> {
    // Recheck on every call, including replay, so role revocation takes effect.
    // The target RPC also checks permissions within its own transaction.
    await this.assertAdmin();
    return this.json(`/rest/v1/rpc/${name}`, args, mutation);
  }

  async managedMedia(
    action: 'upload' | 'get' | 'recover' | 'publish' | 'discard' | 'delete' | 'recover_delete',
    args: Record<string, unknown>,
  ): Promise<Json> {
    await this.assertAdmin();
    const mutation = action !== 'get';
    try {
      const parsed = managedMedia.safeParse(
        await this.json('/functions/v1/managed-media', { ...args, action }, mutation),
      );
      if (
        !parsed.success ||
        (action === 'upload'
          ? parsed.data.request_id.toLowerCase() !== String(args.request_id).toLowerCase()
          : parsed.data.id.toLowerCase() !== String(args.media_id).toLowerCase())
      ) {
        throw new BackendError('INVALID_BACKEND_RESPONSE', mutation);
      }
      const media = parsed.data;
      const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[media.content_type];
      return {
        media,
        url: media.published
          ? `${this.url}/storage/v1/object/public/catalog-media/managed/${media.id}.${extension}`
          : null,
      };
    } catch (error) {
      // A write rejection may follow a committed allocation or retention marker.
      throw new BackendError(error instanceof BackendError ? error.code : 'BACKEND_UNAVAILABLE', mutation);
    }
  }

  async refundPayPal(args: z.infer<typeof paypalRefund>): Promise<Json> {
    await this.assertAdmin();
    try {
      const raw = await this.json('/functions/v1/paypal-create-refund', args, true);
      const parsed = paypalRefundResult.strip().safeParse(raw);
      if (!parsed.success || parsed.data.order_id.toLowerCase() !== args.order_id.toLowerCase()) {
        throw new BackendError('INVALID_BACKEND_RESPONSE', true);
      }
      // Explicit output whitelist: never forward provider references or raw text.
      return parsed.data;
    } catch (error) {
      // Even a 4xx can follow creation/dispatch of the durable refund request.
      throw new BackendError(error instanceof BackendError ? error.code : 'BACKEND_UNAVAILABLE', true);
    }
  }

  async inspectProductMedia(args: z.infer<typeof productMediaIdentity>): Promise<Json> {
    await this.assertAdmin();
    // No product-existence requirement: an upload can outlive its product.
    const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[args.content_type];
    const path = `products/${args.product_id.toLowerCase()}/${args.media_id.toLowerCase()}.${extension}`;
    const url = `${this.url}/storage/v1/object/public/catalog-media/${path}`;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await this.request(url, {
        method: 'GET',
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
      reader = response.body?.getReader();
      // Do not parse Storage error bodies or reflect arbitrary headers.
      if (response.status !== 200) throw new BackendError(`HTTP_${response.status}`);
      if (!reader || response.headers.get('content-type')?.split(';')[0].trim() !== args.content_type) {
        throw new BackendError('INVALID_BACKEND_RESPONSE');
      }
      const hash = createHash('sha256');
      let byteSize = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        byteSize += value.byteLength;
        if (byteSize > 5242880) throw new BackendError('MEDIA_TOO_LARGE');
        hash.update(value);
      }
      if (byteSize === 0) throw new BackendError('INVALID_BACKEND_RESPONSE');
      return { path, url, content_type: args.content_type, byte_size: byteSize, sha256: hash.digest('hex') };
    } catch (error) {
      throw error instanceof BackendError ? error : new BackendError('BACKEND_UNAVAILABLE');
    } finally {
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
    }
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
