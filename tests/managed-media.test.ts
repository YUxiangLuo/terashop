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
  upload_status: string;
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
  allowDelete = false,
  mediaOrigins = '',
) {
  const original = globalThis.fetch,
    deno = Object.getOwnPropertyDescriptor(globalThis, 'Deno');
  const env: Record<string, string> = {
    SUPABASE_URL: API,
    SUPABASE_ANON_KEY: ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
    MEDIA_ALLOWED_ORIGINS: mediaOrigins,
    PAYMENT_ALLOWED_ORIGINS: 'https://storefront.example',
  };
  Object.defineProperty(globalThis, 'Deno', {
    configurable: true,
    value: { env: { get: (key: string) => env[key] } },
  });
  let fault: Intercept | undefined;
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    expect(new URL(request.url).origin).toBe(new URL(API).origin);
    if (request.url.includes('/storage/v1/') && !allowDelete) expect(request.method).not.toBe('DELETE');
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

test('browser media admission is opt-in and independent of payment origins and user authority', async () => {
  const origin = 'https://admin.example';
  const request = (origin: string, method: string, token?: string, body?: unknown) =>
    handleManagedMedia(
      new Request('http://media-handler.test', {
        method,
        headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  await runtime(async () => {
    const response = await request(origin, 'OPTIONS');
    expect(response.status).toBe(403);
    expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false);
  });
  await runtime(
    async () => {
      for (const denied of ['https://storefront.example', 'https://admin.example.evil', 'null', '*']) {
        for (const method of ['OPTIONS', 'POST']) {
          const response = await request(denied, method);
          expect(response.status).toBe(403);
          expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false);
        }
      }
      const preflight = await request(origin, 'OPTIONS');
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(origin);
      expect(preflight.headers.get('Access-Control-Allow-Methods')).toBe('POST, OPTIONS');
      expect(preflight.headers.get('Access-Control-Allow-Headers')).toContain('authorization');
      expect(preflight.headers.has('Access-Control-Allow-Credentials')).toBe(false);
      for (const [token, expected] of [
        [undefined, 401],
        [customer.token, 403],
      ] as const) {
        const response = await request(origin, 'POST', token, {
          action: 'get',
          media_id: crypto.randomUUID(),
        });
        expect(response.status).toBe(expected);
        expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
        expect(response.headers.get('Cache-Control')).toBe('no-store');
      }
      const args = upload();
      const staged = await request(origin, 'POST', admin.token, { action: 'upload', ...args });
      expect(staged.status).toBe(200);
      expect(staged.headers.get('Vary')).toBe('Origin');
      const media = await staged.json();
      expect(media).toMatchObject({ state: 'staged', published: false });
      const published = await request(origin, 'POST', admin.token, { action: 'publish', media_id: media.id });
      expect(published.status).toBe(200);
      expect(await published.json()).toMatchObject({ id: media.id, published: true, state: 'retained' });
    },
    false,
    ` ${origin},https://other-admin.example `,
  );
});

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

test('managed media discovery pages stable IDs, combines filters and preserves private lifecycle facts', async () => {
  const fixtures: Media[] = [];
  for (const [state, upload_status, published] of [
    ['uploading', 'not_started', false],
    ['uploading', 'pending', false],
    ['staged', 'pending', false],
    ['staged', 'settled', false],
    ['retained', 'settled', false],
    ['retained', 'settled', true],
    ['discard_prepared', 'settled', false],
    ['discarded', 'settled', false],
  ] as const) {
    const row = {
      id: crypto.randomUUID(),
      request_id: upload().request_id,
      state,
      upload_status,
      published,
      content_type: 'image/png',
      byte_size: 17,
      sha256: 'a'.repeat(64),
    };
    fixtures.push(row);
    await db`insert into private.managed_media(id,request_id,state,upload_status,published,content_type,byte_size,sha256)
      values (${row.id}::uuid,${row.request_id}::uuid,${state},${upload_status},${published},'image/png',17,${row.sha256})`;
  }
  // No objects exist for these rows: discovery must not require Storage reads.
  const session = await mcpSession(
    new AdminBackend({ url: API, anonKey: ANON_KEY, accessToken: admin.token }, (url, init) => {
      expect(url).not.toContain('/storage/');
      expect(url).not.toContain('/functions/');
      return fetch(url, init);
    }),
  );
  type Page = { items: Media[]; next_cursor: string | null };
  const list = (args: Record<string, unknown> = {}) =>
    toolData<Page>(session.client, 'list_admin_managed_media', args);
  try {
    const seen: Media[] = [];
    let cursor: string | undefined;
    do {
      const page = await list({ page_size: 2, ...(cursor ? { after_id: cursor } : {}) });
      expect(page.items.length).toBeLessThanOrEqual(2);
      for (const row of page.items) {
        if (cursor) expect(row.id > cursor).toBe(true);
        seen.push(row);
      }
      if (page.next_cursor) {
        expect(page.items.length).toBe(2);
        expect(page.next_cursor).toBe(page.items.at(-1)!.id);
      }
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    expect(seen.map((r) => r.id)).toEqual([...new Set(seen.map((r) => r.id))].sort());
    expect(seen.filter((r) => fixtures.some((f) => f.id === r.id))).toEqual(
      fixtures.toSorted((a, b) => a.id.localeCompare(b.id)),
    );
    for (const row of fixtures) {
      expect(
        await list({
          request_id_filter: row.request_id,
          state_filter: row.state,
          upload_status_filter: row.upload_status,
          published_filter: row.published,
        }),
      ).toEqual({ items: [row], next_cursor: null });
      expect(await list({ request_id_filter: row.request_id, published_filter: !row.published })).toEqual({
        items: [],
        next_cursor: null,
      });
    }
    for (const state of ['uploading', 'staged', 'retained', 'discard_prepared', 'discarded']) {
      const page = await list({ state_filter: state, page_size: 100 });
      expect(page.items.every((r) => r.state === state)).toBe(true);
      expect(page.items.map((r) => r.id)).toEqual(
        expect.arrayContaining(fixtures.filter((r) => r.state === state).map((r) => r.id)),
      );
    }
    for (const upload_status of ['not_started', 'pending', 'settled']) {
      const page = await list({ upload_status_filter: upload_status, page_size: 100 });
      expect(page.items.every((r) => r.upload_status === upload_status)).toBe(true);
      expect(page.items.map((r) => r.id)).toEqual(
        expect.arrayContaining(fixtures.filter((r) => r.upload_status === upload_status).map((r) => r.id)),
      );
    }
    expect(await list({ after_id: 'ffffffff-ffff-4fff-bfff-ffffffffffff' })).toEqual({
      items: [],
      next_cursor: null,
    });
    for (const args of [
      { page_size: null },
      { page_size: 0 },
      { page_size: 101 },
      { state_filter: 'deleted' },
      { upload_status_filter: 'expired' },
    ])
      expect((await rpc('list_admin_managed_media', args, admin.token)).status).toBe(400);
    for (const token of [undefined, customer.token, SERVICE_KEY])
      expect((await rpc('list_admin_managed_media', {}, token)).status).toBeGreaterThanOrEqual(400);
    await checked(
      api(`/rest/v1/profiles?id=eq.${admin.userId}`, {
        service: true,
        method: 'PATCH',
        body: { role: 'customer' },
      }),
    );
    try {
      expect((await rpc('list_admin_managed_media', {}, admin.token)).status).toBe(403);
      expect(
        (await session.client.callTool({ name: 'list_admin_managed_media', arguments: {} })).isError,
      ).toBe(true);
    } finally {
      await makeAdmin(admin.userId);
    }
    expect(await list({ request_id_filter: fixtures[0].request_id })).toEqual({
      items: [fixtures[0]],
      next_cursor: null,
    });
  } finally {
    await session.close();
  }
});

test('one-shot upload admission blocks replay and discard while the original response is in flight', async () => {
  await runtime(async (session, fault) => {
    const args = upload();
    const ready = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let writes = 0;
    fault(async (request, send) => {
      if (request.method === 'POST' && request.url.includes('/object/media-staging/')) {
        writes++;
        const response = await send();
        ready.resolve();
        await release.promise;
        return response;
      }
      return send();
    });
    const first = edge({ action: 'upload', ...args });
    try {
      await ready.promise;
      expect(await (await edge({ action: 'upload', ...args })).json()).toMatchObject({
        state: 'uploading',
        upload_status: 'pending',
      });
      const [{ id }] =
        await db`select id from private.managed_media where request_id=${args.request_id}::uuid`;
      expect(await toolData<Result>(session.client, 'recover_media_upload', { media_id: id })).toMatchObject({
        media: { state: 'staged', upload_status: 'pending' },
      });
      expect((await edge({ action: 'discard', media_id: id })).status).toBe(409);
      expect((await edge({ action: 'delete', media_id: id })).status).toBe(409);
      expect(writes).toBe(1);
    } finally {
      release.resolve();
      await first;
      fault();
    }
    expect(await (await first).json()).toMatchObject({ state: 'staged', upload_status: 'settled' });
  });
});

test('lost upload admission remains pending and replay returns identity without granting another write', async () => {
  await runtime(async (session, fault) => {
    const args = upload();
    fault(async (request, send) => {
      expect(request.url).not.toContain('/storage/v1/');
      const action = request.url.endsWith('/rpc/managed_media_command')
        ? (await request.clone().json()).action
        : '';
      const response = await send();
      if (action === 'begin_upload') throw new Error('lost committed admission');
      return response;
    });
    expect((await edge({ action: 'upload', ...args })).status).toBe(502);
    fault(async (request, send) => {
      expect(request.url).not.toContain('/storage/v1/');
      return send();
    });
    const replay = await toolData<Result>(session.client, 'stage_media_upload', args);
    expect(replay.media).toMatchObject({ state: 'uploading', upload_status: 'pending' });
    expect((await edge({ action: 'discard', media_id: replay.media.id })).status).toBe(409);
    expect((await edge({ action: 'delete', media_id: replay.media.id })).status).toBe(409);
    fault();
    expect((await edge({ action: 'recover', media_id: replay.media.id })).status).toBe(409);
  });
});

test('private deletion preserves tombstones and recovers each lost response without deleting public media', async () => {
  await runtime(async (session, fault) => {
    for (const phase of ['none', 'before_delete', 'after_delete', 'before_confirm', 'after_confirm']) {
      const args = upload();
      const staged = await toolData<Result>(session.client, 'stage_media_upload', args);
      const id = staged.media.id;
      expect((await edge({ action: 'delete', media_id: id })).status).toBe(409);
      await toolData(session.client, 'prepare_media_discard', { media_id: id });
      expect(
        await toolData<Result>(session.client, 'recover_media_deletion', { media_id: id }),
      ).toMatchObject({ media: { state: 'discard_prepared' } });
      let deletes = 0,
        fired = false;
      fault(async (request, send) => {
        if (request.method === 'DELETE') {
          expect(new URL(request.url).pathname).toBe(`/storage/v1/object/media-staging/${id}.png`);
          deletes++;
          if (phase === 'before_delete') {
            fired = true;
            throw new Error('LOST');
          }
          const response = await send();
          if (phase === 'after_delete') {
            fired = true;
            throw new Error('LOST');
          }
          return response;
        }
        if (
          request.url.endsWith('/rpc/managed_media_command') &&
          (await request.clone().json()).action === 'deleted'
        ) {
          if (phase === 'before_confirm') {
            fired = true;
            throw new Error('LOST');
          }
          const response = await send();
          if (phase === 'after_confirm') {
            fired = true;
            throw new Error('LOST');
          }
          return response;
        }
        return send();
      });
      const result = await session.client.callTool({
        name: 'delete_managed_media',
        arguments: { media_id: id },
      });
      expect(Boolean(result.isError)).toBe(phase !== 'none');
      expect(fired).toBe(phase !== 'none');
      expect(deletes).toBe(1);
      fault(async (request, send) => {
        expect(request.method).not.toBe('DELETE');
        return send();
      });
      const recovered = await toolData<Result>(session.client, 'recover_media_deletion', { media_id: id });
      expect(recovered.media.state).toBe(phase === 'before_delete' ? 'discard_prepared' : 'discarded');
      fault();
      expect(await toolData<Result>(session.client, 'delete_managed_media', { media_id: id })).toMatchObject({
        url: null,
        media: { state: 'discarded', upload_status: 'settled' },
      });
      fault(async (request, send) => {
        expect(request.url).not.toContain('/storage/v1/');
        return send();
      });
      expect(await toolData<Result>(session.client, 'stage_media_upload', args)).toMatchObject({
        media: { state: 'discarded' },
      });
      expect((await edge({ action: 'publish', media_id: id })).status).toBe(409);
      await toolData(session.client, 'delete_managed_media', { media_id: id });
      fault();
    }
    const retained = await toolData<Result>(session.client, 'stage_media_upload', upload());
    await toolData(session.client, 'publish_managed_media', { media_id: retained.media.id });
    fault(async (request, send) => {
      expect(request.method).not.toBe('DELETE');
      return send();
    });
    expect((await edge({ action: 'delete', media_id: retained.media.id })).status).toBe(409);
  }, true);
}, 20000);

test('absence recovery rejects generic 404, permission, bucket and network errors', async () => {
  await runtime(async (session, fault) => {
    const staged = await toolData<Result>(session.client, 'stage_media_upload', upload());
    const id = staged.media.id;
    await toolData(session.client, 'prepare_media_discard', { media_id: id });
    for (const status of [403, 404, 500]) {
      fault(async (request, send) =>
        request.url.includes('/storage/v1/')
          ? Response.json({ code: 'NoSuchBucket', message: 'SECRET' }, { status })
          : send(),
      );
      const result = await edge({ action: 'recover_delete', media_id: id });
      expect(result.status).toBe(502);
      expect(await result.text()).not.toContain('SECRET');
      fault();
      expect(await toolData<Result>(session.client, 'get_managed_media', { media_id: id })).toMatchObject({
        media: { state: 'discard_prepared' },
      });
    }
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
    const disposable = await toolData<Result>(session.client, 'stage_media_upload', upload());
    await toolData(session.client, 'prepare_media_discard', { media_id: disposable.media.id });
    expect(
      await toolData<Result>(session.client, 'delete_managed_media', { media_id: disposable.media.id }),
    ).toMatchObject({ media: { state: 'discarded' } });
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
        ).toMatchObject({ media: { state: 'staged', upload_status: 'pending' } });
        expect((await edge({ action: 'discard', media_id: row.id })).status).toBe(409);
        expect((await edge({ action: 'delete', media_id: row.id })).status).toBe(409);
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
}, 20000);

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
  for (const action of ['begin_upload', 'uploaded']) {
    await checked(
      rpc('managed_media_command', { action, actor_id: admin.userId, media_id: media.id }, undefined, true),
    );
  }
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
