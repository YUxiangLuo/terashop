import { expect, test } from 'bun:test';
import { AdminBackend, BackendError } from '../../mcp/src/backend';

const config = { url: 'http://127.0.0.1:54321', anonKey: 'anon', accessToken: 'session' };
const user = { id: crypto.randomUUID(), role: 'authenticated', is_anonymous: false };
const RPC_RESPONSE_LIMIT = 8 * 1024 * 1024;
const SMALL_RESPONSE_LIMIT = 64 * 1024;

function streamedResponse(chunks: Uint8Array[], init: ResponseInit = {}, onCancel?: () => void): Response {
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index === chunks.length) controller.close();
        else controller.enqueue(chunks[index++]);
      },
      cancel() {
        onCancel?.();
      },
    }),
    init,
  );
}

function rpcBackend(target: () => Response): AdminBackend {
  return new AdminBackend(config, async (url) => {
    if (url.endsWith('/auth/v1/user')) return Response.json(user);
    if (url.endsWith('/rest/v1/rpc/is_admin')) return Response.json(true);
    return target();
  });
}

function exactJsonBytes(size: number): Uint8Array {
  return new TextEncoder().encode(`null${' '.repeat(size - 4)}`);
}

async function failure(promise: Promise<unknown>): Promise<BackendError> {
  try {
    await promise;
    throw new Error('expected backend failure');
  } catch (error) {
    expect(error).toBeInstanceOf(BackendError);
    return error as BackendError;
  }
}

test('accepts a valid RPC response at the exact byte boundary', async () => {
  const backend = rpcBackend(() => streamedResponse([exactJsonBytes(RPC_RESPONSE_LIMIT)]));
  expect(await backend.rpc('get_admin_product', { product_id: crypto.randomUUID() }, false)).toBeNull();
});

test('rejects and cancels an oversized chunked RPC response without content-length', async () => {
  let cancelled = false;
  const bytes = exactJsonBytes(RPC_RESPONSE_LIMIT + 1);
  const backend = rpcBackend(() =>
    streamedResponse(
      [
        bytes.slice(0, RPC_RESPONSE_LIMIT),
        bytes.slice(RPC_RESPONSE_LIMIT),
        new Uint8Array([32]),
        new Uint8Array([32]),
      ],
      {},
      () => (cancelled = true),
    ),
  );
  const error = await failure(backend.rpc('get_admin_product', { product_id: crypto.randomUUID() }, false));
  expect(error.code).toBe('INVALID_BACKEND_RESPONSE');
  expect(error.outcomeUnknown).toBe(false);
  expect(cancelled).toBe(true);
});

test('does not trust a lying content-length on an oversized success response', async () => {
  const backend = rpcBackend(() =>
    streamedResponse([exactJsonBytes(RPC_RESPONSE_LIMIT + 1)], { headers: { 'content-length': '2' } }),
  );
  expect(
    (await failure(backend.rpc('get_admin_product', { product_id: crypto.randomUUID() }, false))).code,
  ).toBe('INVALID_BACKEND_RESPONSE');
});

test('oversized success responses preserve read versus write outcome semantics', async () => {
  for (const mutation of [false, true]) {
    const backend = rpcBackend(() => streamedResponse([exactJsonBytes(RPC_RESPONSE_LIMIT + 1)]));
    const error = await failure(
      backend.rpc('get_admin_product', { product_id: crypto.randomUUID() }, mutation),
    );
    expect(error.code).toBe('INVALID_BACKEND_RESPONSE');
    expect(error.outcomeUnknown).toBe(mutation);
  }
});

test('oversized error response uses the generic status code and the smaller cap', async () => {
  let cancelled = false;
  const backend = rpcBackend(() =>
    streamedResponse(
      [
        new TextEncoder().encode(`{"code":"PT404"}${' '.repeat(SMALL_RESPONSE_LIMIT)}`),
        new Uint8Array([32]),
        new Uint8Array([32]),
      ],
      { status: 503, headers: { 'content-length': '20' } },
      () => (cancelled = true),
    ),
  );
  const error = await failure(backend.rpc('get_admin_product', { product_id: crypto.randomUUID() }, true));
  expect(error.code).toBe('HTTP_503');
  expect(error.outcomeUnknown).toBe(true);
  expect(cancelled).toBe(true);
});

test('auth responses use the smaller response cap', async () => {
  const oversizedUser = new TextEncoder().encode(
    `${JSON.stringify(user)}${' '.repeat(SMALL_RESPONSE_LIMIT)}`,
  );
  const backend = new AdminBackend(config, async () => streamedResponse([oversizedUser]));
  const error = await failure(backend.assertAdmin());
  expect(error.code).toBe('INVALID_BACKEND_RESPONSE');
  expect(error.outcomeUnknown).toBe(false);
});
