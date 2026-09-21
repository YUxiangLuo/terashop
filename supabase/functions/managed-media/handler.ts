/// <reference path="../_shared/deno.d.ts" />
import {
  authenticatedUser,
  HttpError,
  jsonResponse,
  requiredEnv,
  requireUuid,
  serviceRpc,
} from '../_shared/http.ts';

interface Media {
  id: string;
  request_id: string;
  state: 'uploading' | 'staged' | 'retained' | 'discard_prepared';
  content_type: 'image/jpeg' | 'image/png' | 'image/webp';
  byte_size: number;
  sha256: string;
  published: boolean;
}
const extensions = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

async function boundedBytes(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!body) throw new HttpError('Missing bytes');
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new HttpError('Media body too large', 413, 'body_too_large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function hash(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (x) =>
    x.toString(16).padStart(2, '0'),
  ).join('');
}

async function storage(
  path: string,
  method = 'GET',
  bytes?: Uint8Array<ArrayBuffer>,
  mime?: string,
): Promise<Response> {
  const key = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
  return fetch(`${requiredEnv('SUPABASE_URL')}/storage/v1/object/${path}`, {
    method,
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      ...(bytes ? { 'Content-Type': mime!, 'x-upsert': 'false' } : {}),
    },
    body: bytes,
  });
}

async function verifiedBytes(media: Media, bucket: string, path: string): Promise<Uint8Array<ArrayBuffer>> {
  const response = await storage(`authenticated/${bucket}/${path}`);
  if (
    response.status !== 200 ||
    response.headers.get('Content-Type')?.split(';')[0].trim() !== media.content_type
  ) {
    await response.body?.cancel();
    throw new HttpError('Stored media not verified', 409, 'media_unverified');
  }
  const bytes = await boundedBytes(response.body, 1048576);
  if (bytes.byteLength !== media.byte_size || (await hash(bytes)) !== media.sha256) {
    throw new HttpError('Stored media content mismatch', 409, 'media_unverified');
  }
  return bytes;
}

// An immutable duplicate can follow a lost response. Verify original bytes; do
// not overwrite, allocate another key, or retry the write automatically.
async function writeOnce(
  media: Media,
  bucket: string,
  path: string,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<void> {
  const response = await storage(`${bucket}/${path}`, 'POST', bytes, media.content_type);
  const status = response.status;
  await response.body?.cancel();
  if (!response.ok && status !== 400 && status !== 409)
    throw new HttpError('Storage unavailable', 502, 'storage_unavailable');
  await verifiedBytes(media, bucket, path);
}

export async function handleManagedMedia(request: Request): Promise<Response> {
  try {
    // Initial interface is programmatic MCP, not a browser upload/signing API.
    if (request.headers.has('Origin')) throw new HttpError('Origin not allowed', 403, 'origin_denied');
    if (request.method !== 'POST') throw new HttpError('Method not allowed', 405, 'method_not_allowed');
    const user = await authenticatedUser(request);
    const raw = await boundedBytes(request.body, 1400000);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      throw new HttpError('Invalid JSON');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError('Invalid request');
    const action = body.action;
    if (!['upload', 'get', 'recover', 'publish', 'discard'].includes(String(action)))
      throw new HttpError('Invalid action');
    const allowed =
      action === 'upload' ? ['action', 'request_id', 'content_type', 'data_base64'] : ['action', 'media_id'];
    if (Object.keys(body).some((key) => !allowed.includes(key))) throw new HttpError('Unknown field');
    const command = (action: string, args: Record<string, unknown>) =>
      serviceRpc<Media>('managed_media_command', { actor_id: user.id, action, ...args });
    let media: Media;
    if (action === 'upload') {
      const requestId = requireUuid(body.request_id, 'request_id');
      if (
        typeof body.content_type !== 'string' ||
        !Object.hasOwn(extensions, body.content_type) ||
        typeof body.data_base64 !== 'string' ||
        body.data_base64.length > 1398104
      )
        throw new HttpError('Invalid media');
      let binary: string;
      try {
        binary = atob(body.data_base64);
      } catch {
        throw new HttpError('Invalid base64');
      }
      if (!binary.length || binary.length > 1048576 || btoa(binary) !== body.data_base64)
        throw new HttpError('Invalid base64');
      const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      media = await command('allocate', {
        request_id: requestId,
        content_type: body.content_type,
        byte_size: bytes.length,
        sha256: await hash(bytes),
      });
      if (media.state === 'uploading') {
        await writeOnce(media, 'media-staging', `${media.id}.${extensions[media.content_type]}`, bytes);
        media = await command('verified', { media_id: media.id });
      }
    } else {
      const id = requireUuid(body.media_id, 'media_id');
      media = await command('get', { media_id: id });
      const path = `${media.id}.${extensions[media.content_type]}`;
      if (action === 'recover' && media.state === 'uploading') {
        await verifiedBytes(media, 'media-staging', path);
        media = await command('verified', { media_id: id });
      } else if (action === 'publish') {
        // This RPC commits BEFORE any public write. Never undo retention.
        media = await command('retain', { media_id: id });
        if (!media.published) {
          const bytes = await verifiedBytes(media, 'media-staging', path);
          await writeOnce(media, 'catalog-media', `managed/${path}`, bytes);
          media = await command('published', { media_id: id });
        }
      } else if (action === 'discard') media = await command('discard', { media_id: id });
    }
    // Never return arbitrary DB fields, credentials, staging keys or signed URLs.
    return jsonResponse({
      id: media.id,
      request_id: media.request_id,
      state: media.state,
      content_type: media.content_type,
      byte_size: media.byte_size,
      sha256: media.sha256,
      published: media.published,
    });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 502;
    const code =
      error instanceof HttpError && /^(?:[0-9A-Z]{5}|[a-z_]+)$/.test(error.code)
        ? error.code
        : 'media_unavailable';
    return jsonResponse(
      {
        error: {
          code,
          message:
            'Media operation did not complete. Read state and preserve original IDs; never retry automatically.',
        },
      },
      status,
    );
  }
}
