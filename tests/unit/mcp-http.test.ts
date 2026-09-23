import { expect, test } from 'bun:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createAdminHttpHandler } from '../../mcp/src/http';
import { createCredentialCipher } from '../../mcp/src/credentials';

async function fixture(expired = false, admit?: (userId: string) => number) {
  const cipher = await createCredentialCipher(
    new Map([['test', crypto.getRandomValues(new Uint8Array(32))]]),
    'test',
  );
  const config = {
    issuer: 'https://auth.example',
    resource: 'https://shop.example/mcp',
    introspectionEndpoint: 'https://auth.example/token/introspection',
    introspectionClientId: 'mcp',
    introspectionClientSecret: 'secret',
    project: 'test',
    supabaseUrl: 'https://db.example',
    serviceRoleKey: 'service-secret',
    anonKey: 'public',
    scopes: ['store:read', 'store:write'] as const,
    allowWrites: true,
  };
  const users = await Promise.all(
    ['a', 'b'].map(async (token) => {
      const id = crypto.randomUUID(),
        grantId = crypto.randomUUID();
      return {
        token,
        id,
        grantId,
        active: true,
        scopes: token === 'a' ? ['store:read'] : ['store:read', 'store:write'],
        envelope: await cipher.seal(
          { project: 'test', userId: id, grantId, revision: 1 },
          {
            accessToken: `downstream-${token}`,
            refreshToken: `refresh-${token}`,
            expiresAt: Math.floor(Date.now() / 1000) + (expired ? -1 : 300),
          },
        ),
      };
    }),
  );
  let calls = 0;
  let refreshClaims = 0;
  const uploads: Uint8Array[] = [];
  const handler = createAdminHttpHandler(
    config,
    cipher,
    async (url, init) => {
      calls++;
      if (url === config.introspectionEndpoint) {
        const user = users.find((u) => u.token === new URLSearchParams(init.body as string).get('token'));
        if (!user?.active) return Response.json({ active: false });
        return Response.json({
          active: true,
          token_type: 'Bearer',
          token_kind: 'AccessToken',
          iss: config.issuer,
          aud: config.resource,
          sub: user.id,
          client_id: 'agent',
          grant_id: user.grantId,
          exp: Math.floor(Date.now() / 1000) + 300,
          scope: user.scopes.join(' '),
        });
      }
      if (url.endsWith('/auth/v1/user'))
        return Response.json({ id: users[1].id, role: 'authenticated', is_anonymous: false });
      if (url.endsWith('/is_admin')) return Response.json(true);
      if (url.endsWith('/get_admin_product'))
        return Response.json({ id: JSON.parse(String(init.body)).product_id });
      if (url.includes('/storage/v1/object/catalog-media/')) {
        expect(new Headers(init.headers).get('authorization')).toBe('Bearer downstream-b');
        uploads.push(new Uint8Array(init.body as Uint8Array));
        return Response.json({});
      }
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer service-secret');
      const body = JSON.parse(init.body as string);
      const user = users.find((u) => u.id === body.p_binding.subject)!;
      if (url.endsWith('/mcp_grant_command'))
        return Response.json({
          id: user.grantId,
          user_id: user.id,
          state: 'active',
          version: 1,
          scopes: user.scopes,
        });
      if (url.endsWith('/mcp_credential_command') && body.p_action === 'claim_refresh') {
        refreshClaims++;
        throw new Error('Lost refresh claim receipt: secret');
      }
      if (url.endsWith('/mcp_credential_command'))
        return Response.json({ revision: 1, envelope: user.envelope });
      throw new Error('Unexpected backend call');
    },
    admit,
  );
  return { handler, users, config, uploads, calls: () => calls, refreshClaims: () => refreshClaims };
}

test('remote SDK uploads the full advertised 1 MiB media size after base64 expansion', async () => {
  const f = await fixture();
  const client = new Client({ name: 'media-limit-test', version: '1' });
  const bytes = Buffer.alloc(1048576, 0xab);
  const productId = crypto.randomUUID(),
    mediaId = crypto.randomUUID();
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(f.config.resource), {
        requestInit: { headers: { authorization: 'Bearer b' } },
        fetch: (input, init) => f.handler(new Request(input, init)),
      }),
    );
    const result = await client.callTool({
      name: 'upload_product_media',
      arguments: {
        product_id: productId,
        media_id: mediaId,
        content_type: 'image/png',
        data_base64: bytes.toString('base64'),
      },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      data: {
        path: `products/${productId}/${mediaId}.png`,
        url: `https://db.example/storage/v1/object/public/catalog-media/products/${productId}/${mediaId}.png`,
      },
    });
    expect(f.uploads).toHaveLength(1);
    expect(Buffer.from(f.uploads[0]).equals(bytes)).toBe(true);
  } finally {
    await client.close();
  }
});

test('identity admission follows verified authorization and precedes credentials or body work', async () => {
  const seen: string[] = [];
  const f = await fixture(false, (userId) => {
    seen.push(userId);
    return 2;
  });
  const response = await f.handler(
    new Request(f.config.resource, {
      method: 'POST',
      headers: { authorization: 'Bearer a' },
      body: 'not-json',
    }),
  );
  expect(response.status).toBe(429);
  expect(response.headers.get('retry-after')).toBe('2');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ error: 'rate_limited' });
  expect(seen).toEqual([f.users[0].id]);
  expect(f.calls()).toBe(2); // Introspection and grant only, no credentials/business calls.
  expect(
    (
      await f.handler(
        new Request(f.config.resource, {
          headers: { authorization: 'Bearer untrusted' },
        }),
      )
    ).status,
  ).toBe(401);
  expect(seen).toHaveLength(1);
});

test('HTTP boundary advertises protected resource and rejects untrusted requests before credentials', async () => {
  const f = await fixture();
  const metadata = await f.handler(
    new Request('https://shop.example/.well-known/oauth-protected-resource/mcp'),
  );
  expect(await metadata.json()).toEqual({
    resource: f.config.resource,
    authorization_servers: [f.config.issuer],
    scopes_supported: ['store:read', 'store:write'],
    bearer_methods_supported: ['header'],
  });
  const missing = await f.handler(new Request(f.config.resource));
  expect(missing.status).toBe(401);
  expect(missing.headers.get('www-authenticate')).toBe(
    'Bearer resource_metadata="https://shop.example/.well-known/oauth-protected-resource/mcp"',
  );
  for (const headers of [
    new Headers({ origin: 'https://evil.example' }),
    new Headers({ host: 'evil.example' }),
    new Headers({ origin: 'null' }),
  ])
    expect((await f.handler(new Request(f.config.resource, { headers }))).status).toBe(403);
  expect((await f.handler(new Request(`${f.config.resource}?access_token=a`))).status).toBe(400);
  expect(f.calls()).toBe(0);
});

test('SDK clients initialize and list tools with per-request identity, scopes and revocation', async () => {
  const f = await fixture();
  const clients: Client[] = [];
  try {
    for (const user of f.users) {
      const client = new Client({ name: `test-${user.token}`, version: '1' });
      clients.push(client);
      const transport = new StreamableHTTPClientTransport(new URL(f.config.resource), {
        requestInit: { headers: { authorization: `Bearer ${user.token}` } },
        fetch: async (input, init) => {
          const response = await f.handler(new Request(input, init));
          expect(response.headers.get('mcp-session-id')).toBeNull();
          return response;
        },
      });
      await client.connect(transport);
    }
    const [a, b] = await Promise.all(clients.map((client) => client.listTools()));
    expect(a!.tools.some((t) => t.name === 'update_shop_settings')).toBe(false);
    expect(b!.tools.some((t) => t.name === 'update_shop_settings')).toBe(true);
    f.users[1]!.scopes = ['store:read'];
    expect((await clients[1]!.listTools()).tools.some((t) => t.name === 'update_shop_settings')).toBe(false);
    f.users[0]!.active = false;
    expect(
      (
        await f.handler(
          new Request(f.config.resource, { method: 'POST', headers: { authorization: 'Bearer a' } }),
        )
      ).status,
    ).toBe(401);
    expect((await clients[1]!.listTools()).tools.length).toBeGreaterThan(0);
  } finally {
    await Promise.all(clients.map((client) => client.close()));
  }
});

test('stateless handler rejects sessions, streaming methods and oversized bodies', async () => {
  const f = await fixture();
  for (const method of ['GET', 'DELETE']) {
    const response = await f.handler(
      new Request(f.config.resource, { method, headers: { authorization: 'Bearer a' } }),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  }
  expect(
    (
      await f.handler(
        new Request(f.config.resource, {
          method: 'POST',
          headers: { authorization: 'Bearer a', 'mcp-session-id': 'other-user' },
        }),
      )
    ).status,
  ).toBe(400);
  for (const size of [2 * 1024 * 1024, 2 * 1024 * 1024 + 1]) {
    const response = await f.handler(
      new Request(f.config.resource, {
        method: 'POST',
        headers: {
          authorization: 'Bearer a',
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: ' '.repeat(size),
      }),
    );
    expect(response.status).toBe(size === 2 * 1024 * 1024 ? 400 : 413);
    expect(response.headers.get('cache-control')).toBe('no-store');
  }
});

test('credential identity mismatch and uncertain refresh fail closed without retries', async () => {
  for (const expired of [false, true]) {
    const f = await fixture(expired);
    if (!expired) f.users[0]!.envelope = f.users[1]!.envelope;
    const response = await f.handler(
      new Request(f.config.resource, {
        method: 'POST',
        headers: { authorization: 'Bearer a' },
        body: '{}',
      }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'authorization_unavailable' });
    expect(f.refreshClaims()).toBe(expired ? 1 : 0);
  }
});

test('aborting a stalled request body stops before reading downstream credentials', async () => {
  const f = await fixture();
  const reading = Promise.withResolvers<void>();
  const controller = new AbortController();
  let pulls = 0,
    cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(stream) {
      if (++pulls === 1) stream.enqueue(new TextEncoder().encode('{'));
      else reading.resolve();
    },
    cancel() {
      cancelled = true;
    },
  });
  const operation = f.handler(
    new Request(f.config.resource, {
      method: 'POST',
      headers: { authorization: 'Bearer a' },
      body,
      signal: controller.signal,
    }),
  );
  await reading.promise;
  controller.abort();
  expect((await operation).status).toBe(408);
  expect(cancelled).toBe(true);
  expect(f.calls()).toBe(2);
});
