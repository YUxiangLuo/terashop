import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { API, ANON_KEY, SERVICE_KEY, api, checked, rpc, signup, makeAdmin, type TestUser } from './helpers';
import { testDatabase, heldTransactionRace, staleAfterCommit } from './database-concurrency';
import { handleManagedMedia } from '../supabase/functions/managed-media/handler';
import { AdminBackend } from '../mcp/src/backend';
import { mcpSession, toolData } from './support/mcp';

const db = testDatabase();
let admin: TestUser, customer: TestUser;
const requests: string[] = [];
const bytes = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 4, 0, 0, 0, 181,
  28, 12, 2, 0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 252, 255, 31, 0, 3, 3, 2, 0, 238, 254, 95, 217, 0, 0,
  0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
]);
interface Media {
  id: string;
  request_id: string;
  state: string;
  content_type: string;
  byte_size: number;
  sha256: string;
  published: boolean;
}
interface Result {
  media: Media;
  url: string | null;
}
beforeAll(async () => {
  admin = await signup();
  customer = await signup();
  await makeAdmin(admin.userId);
});
afterEach(async () => {
  for (const request of requests.splice(0)) {
    const rows = await db`select id from private.managed_media where request_id=${request}::uuid`;
    for (const { id } of rows) {
      for (const [bucket, path] of [
        ['media-staging', `${id}.png`],
        ['catalog-media', `managed/${id}.png`],
      ]) {
        const response = await fetch(`${API}/storage/v1/object/${bucket}`, {
          method: 'DELETE',
          headers: {
            apikey: SERVICE_KEY,
            Authorization: `Bearer ${SERVICE_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ prefixes: [path] }),
        });
        expect(response.ok).toBe(true);
      }
    }
    await db`delete from private.managed_media where request_id=${request}::uuid`;
  }
});
afterAll(() => db.close());
function upload() {
  const request_id = crypto.randomUUID();
  requests.push(request_id);
  return { request_id, content_type: 'image/png', data_base64: Buffer.from(bytes).toString('base64') };
}
function edge(body: unknown, token = admin.token) {
  return handleManagedMedia(
    new Request('http://media-handler.test', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}
type Intercept = (request: Request, send: () => Promise<Response>) => Promise<Response>;
async function runtime(
  run: (session: Awaited<ReturnType<typeof mcpSession>>, setFault: (f?: Intercept) => void) => Promise<void>,
) {
  const original = globalThis.fetch,
    deno = Object.getOwnPropertyDescriptor(globalThis, 'Deno');
  const env: Record<string, string> = {
    SUPABASE_URL: API,
    SUPABASE_ANON_KEY: ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
  };
  Object.defineProperty(globalThis, 'Deno', {
    configurable: true,
    value: { env: { get: (key: string) => env[key] } },
  });
  let fault: Intercept | undefined;
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    expect(new URL(request.url).origin).toBe(new URL(API).origin);
    if (request.url.includes('/storage/v1/')) expect(request.method).not.toBe('DELETE');
    return fault ? fault(request, () => original(request)) : original(request);
  }) as typeof fetch;
  const session = await mcpSession(
    new AdminBackend({ url: API, anonKey: ANON_KEY, accessToken: admin.token }, (url, init) =>
      url.endsWith('/functions/v1/managed-media')
        ? handleManagedMedia(new Request(url, init))
        : fetch(url, init),
    ),
    true,
  );
  try {
    await run(session, (f) => {
      fault = f;
    });
  } finally {
    await session.close();
    globalThis.fetch = original;
    if (deno) Object.defineProperty(globalThis, 'Deno', deno);
    else Reflect.deleteProperty(globalThis, 'Deno');
  }
}

test('private staging, immutable replay, publication/attachment and discard preparation use real Storage', async () => {
  await runtime(async (session) => {
    const args = upload();
    const staged = await toolData<Result>(session.client, 'stage_media_upload', args);
    expect(staged).toMatchObject({
      url: null,
      media: { request_id: args.request_id, state: 'staged', byte_size: bytes.length, published: false },
    });
    expect(staged.media.id).not.toBe(args.request_id);
    expect(await toolData<Result>(session.client, 'stage_media_upload', args)).toEqual(staged);
    expect((await edge({ action: 'upload', ...args, data_base64: 'YWJj' })).status).toBe(409);
    const id = staged.media.id;
    for (const token of [undefined, customer.token, admin.token]) {
      const headers: Record<string, string> = {
        apikey: ANON_KEY,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      };
      for (const prefix of ['public', 'authenticated']) {
        expect(
          (await fetch(`${API}/storage/v1/object/${prefix}/media-staging/${id}.png`, { headers })).ok,
        ).toBe(false);
      }
      const signed = await fetch(`${API}/storage/v1/object/sign/media-staging/${id}.png`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn: 60 }),
      });
      expect(signed.ok).toBe(false);
      const listed = await fetch(`${API}/storage/v1/object/list/media-staging`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefix: '', limit: 100 }),
      });
      if (listed.ok) expect(await listed.json()).toEqual([]);
      for (const path of [`media-staging/${id}.webp`, `catalog-media/managed/${id}.png`]) {
        expect(
          (
            await fetch(`${API}/storage/v1/object/${path}`, {
              method: 'POST',
              headers: { ...headers, 'Content-Type': 'image/png' },
              body: bytes,
            })
          ).ok,
        ).toBe(false);
      }
    }
    expect((await edge({ action: 'get', media_id: id }, customer.token)).status).toBe(403);
    expect((await edge({ action: 'get', media_id: id }, SERVICE_KEY)).status).toBe(401);
    expect((await edge({ action: 'get', media_id: crypto.randomUUID() })).status).toBe(404);
    expect((await edge({ action: 'upload', ...args, data_base64: '!!!' })).status).toBe(400);
    expect(
      (
        await handleManagedMedia(
          new Request('http://media-handler.test', {
            method: 'POST',
            headers: { Authorization: `Bearer ${admin.token}` },
            body: '{',
          }),
        )
      ).status,
    ).toBe(400);
    await checked(
      api(`/rest/v1/profiles?id=eq.${admin.userId}`, {
        service: true,
        method: 'PATCH',
        body: { role: 'customer' },
      }),
    );
    try {
      expect((await edge({ action: 'get', media_id: id })).status).toBe(403);
    } finally {
      await makeAdmin(admin.userId);
    }
    expect(
      (
        await rpc(
          'managed_media_command',
          { actor_id: admin.userId, action: 'get', media_id: id },
          admin.token,
        )
      ).status,
    ).toBeGreaterThanOrEqual(400);
    expect((await edge({ action: 'get', media_id: id, actor_id: admin.userId })).status).toBe(400);
    expect((await edge({ action: 'upload', ...args, path: `products/${id}/old.png` })).status).toBe(400);
    const published = await toolData<Result>(session.client, 'publish_managed_media', { media_id: id });
    expect(published).toMatchObject({
      media: { state: 'retained', published: true },
      url: `${API}/storage/v1/object/public/catalog-media/managed/${id}.png`,
    });
    expect(new Uint8Array(await (await fetch(published.url!)).arrayBuffer())).toEqual(bytes);
    expect(await toolData<Result>(session.client, 'publish_managed_media', { media_id: id })).toEqual(
      published,
    );
    const product = crypto.randomUUID();
    try {
      const created = await checked<{ revision: number }>(
        rpc(
          'create_product',
          { product_id: product, changes: { product: { slug: product, name: 'Managed image' } } },
          admin.token,
        ),
      );
      await checked(
        rpc(
          'update_product',
          {
            product_id: product,
            expected_revision: created.revision,
            changes: { images: [{ id: crypto.randomUUID(), url: published.url }] },
          },
          admin.token,
        ),
      );
      expect(
        (
          await rpc(
            'update_product',
            {
              product_id: product,
              expected_revision: created.revision,
              changes: { product: { name: 'stale' } },
            },
            admin.token,
          )
        ).status,
      ).toBe(409);
    } finally {
      await checked(api(`/rest/v1/products?id=eq.${product}`, { service: true, method: 'DELETE' }));
    }
    expect((await edge({ action: 'discard', media_id: id })).status).toBe(409);
    const discarded = await toolData<Result>(session.client, 'stage_media_upload', upload());
    const frozen = await toolData<Result>(session.client, 'prepare_media_discard', {
      media_id: discarded.media.id,
    });
    expect(frozen).toMatchObject({ url: null, media: { state: 'discard_prepared', published: false } });
    expect(
      await toolData<Result>(session.client, 'prepare_media_discard', { media_id: discarded.media.id }),
    ).toEqual(frozen);
    expect((await edge({ action: 'publish', media_id: discarded.media.id })).status).toBe(409);
    expect(
      (await fetch(`${API}/storage/v1/object/public/catalog-media/managed/${discarded.media.id}.png`)).ok,
    ).toBe(false);
    expect(
      (
        await fetch(`${API}/storage/v1/object/authenticated/media-staging/${discarded.media.id}.png`, {
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
        })
      ).ok,
    ).toBe(true);
  });
});

test('managed media runs through the real local Edge gateway', async () => {
  const session = await mcpSession(
    new AdminBackend({ url: API, anonKey: ANON_KEY, accessToken: admin.token }),
    true,
  );
  try {
    const staged = await toolData<Result>(session.client, 'stage_media_upload', upload());
    expect(staged).toMatchObject({ url: null, media: { state: 'staged' } });
    expect(
      await toolData<Result>(session.client, 'publish_managed_media', { media_id: staged.media.id }),
    ).toMatchObject({ media: { state: 'retained', published: true } });
  } finally {
    await session.close();
  }
});

test('lost upload/publication responses retain identity and never reverse the public retention veto', async () => {
  await runtime(async (session, fault) => {
    for (const phase of ['allocate', 'upload', 'retain', 'public_write', 'published']) {
      const args = upload();
      let fired = false;
      const intercept: Intercept = async (request, send) => {
        const isRpc = request.url.endsWith('/rpc/managed_media_command');
        const action = isRpc ? (await request.clone().json()).action : '';
        const matches =
          phase === 'upload'
            ? request.method === 'POST' && request.url.includes('/object/media-staging/')
            : phase === 'public_write'
              ? request.method === 'POST' && request.url.includes('/object/catalog-media/managed/')
              : action === phase;
        const response = await send();
        if (!fired && matches) {
          fired = true;
          throw new Error('SECRET_LOST_RESPONSE');
        }
        return response;
      };
      if (phase === 'upload' || phase === 'allocate') fault(intercept);
      const first = await session.client.callTool({ name: 'stage_media_upload', arguments: args });
      fault();
      const row = (
        await db`select id,state from private.managed_media where request_id=${args.request_id}::uuid`
      )[0];
      if (phase === 'allocate') {
        expect(first.isError).toBe(true);
        expect(row.state).toBe('uploading');
        expect(await toolData<Result>(session.client, 'stage_media_upload', args)).toMatchObject({
          media: { id: row.id, state: 'staged' },
        });
      } else if (phase === 'upload') {
        expect(first.isError).toBe(true);
        expect(JSON.stringify(first)).not.toContain('SECRET');
        expect(row.state).toBe('uploading');
        expect((await edge({ action: 'discard', media_id: row.id })).status).toBe(409);
        expect(
          await toolData<Result>(session.client, 'recover_media_upload', { media_id: row.id }),
        ).toMatchObject({ media: { state: 'staged' } });
      } else {
        expect(first.isError).not.toBe(true);
        fault(intercept);
        expect(
          (await session.client.callTool({ name: 'publish_managed_media', arguments: { media_id: row.id } }))
            .isError,
        ).toBe(true);
        fault();
        expect(
          await toolData<Result>(session.client, 'get_managed_media', { media_id: row.id }),
        ).toMatchObject({ media: { state: 'retained', published: phase === 'published' } });
        expect((await edge({ action: 'discard', media_id: row.id })).status).toBe(409);
      }
      expect(fired).toBe(true);
      expect(
        await toolData<Result>(session.client, 'publish_managed_media', { media_id: row.id }),
      ).toMatchObject({ media: { id: row.id, state: 'retained', published: true } });
    }
  });
});

async function stagedRecord() {
  const args = upload();
  const media = await checked<Media>(
    rpc(
      'managed_media_command',
      {
        action: 'allocate',
        actor_id: admin.userId,
        request_id: args.request_id,
        content_type: 'image/png',
        byte_size: 3,
        sha256: 'a'.repeat(64),
      },
      undefined,
      true,
    ),
  );
  await checked(
    rpc(
      'managed_media_command',
      { action: 'verified', actor_id: admin.userId, media_id: media.id },
      undefined,
      true,
    ),
  );
  return media.id;
}
test('retention versus discard is serialized in both directions and rejects stale RR snapshots', async () => {
  for (const winner of ['retain', 'discard']) {
    const loser = winner === 'retain' ? 'discard' : 'retain';
    const id = await stagedRecord();
    const response = await heldTransactionRace(
      db,
      async (sql) => {
        await sql`select set_config('request.jwt.claims','{"role":"service_role"}',true)`;
        await sql`select public.managed_media_command(${admin.userId}::uuid,${winner},${id}::uuid)`;
      },
      () =>
        rpc(
          'managed_media_command',
          { actor_id: admin.userId, action: loser, media_id: id },
          undefined,
          true,
        ),
    );
    expect(response.status).toBe(409);
    for (const isolation of ['read committed', 'repeatable read'] as const) {
      const staleId = await stagedRecord();
      const stale = await staleAfterCommit(
        db,
        async (sql) => {
          await sql`select set_config('request.jwt.claims','{"role":"service_role"}',true)`;
          return sql`select public.managed_media_command(${admin.userId}::uuid,${loser},${staleId}::uuid)`;
        },
        () =>
          checked(
            rpc(
              'managed_media_command',
              { actor_id: admin.userId, action: winner, media_id: staleId },
              undefined,
              true,
            ),
          ),
        isolation,
      );
      expect(stale.error).toMatchObject({ errno: isolation === 'repeatable read' ? '40001' : 'PT409' });
    }
  }
});
