import { expect, test } from 'bun:test';
import { AdminBackend } from '../../mcp/src/backend';
import { productChanges, uploadProductMedia } from '../../mcp/src/schemas';
import { mcpSession, toolData } from '../support/mcp';

const config = { url: 'http://127.0.0.1:54321', anonKey: 'public-key', accessToken: 'private-session' };
const user = { id: crypto.randomUUID(), role: 'authenticated', is_anonymous: false };

function fakeBackend(response: (request: Request) => Response | Promise<Response>, admin = true) {
  const calls: Request[] = [];
  const backend = new AdminBackend(config, async (url, init) => {
    const request = new Request(url, init);
    calls.push(request);
    if (url.endsWith('/auth/v1/user')) return Response.json(user);
    if (url.endsWith('/is_admin')) return Response.json(admin);
    return response(request);
  });
  return { backend, calls };
}

test('MCP 默认只读；写工具显式启用，不能调用未注册或 service-only 入口', async () => {
  const { backend, calls } = fakeBackend(() => Response.json(null));
  const readonly = await mcpSession(backend);
  const write = await mcpSession(backend, true);
  try {
    const readTools = (await readonly.client.listTools()).tools;
    const writeTools = (await write.client.listTools()).tools;
    expect(readTools.length).toBe(20);
    expect(writeTools.length).toBe(51);
    expect(readTools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(writeTools.find((tool) => tool.name === 'adjust_inventory')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
    expect(writeTools.find((tool) => tool.name === 'create_product')?.annotations?.idempotentHint).toBe(
      false,
    );
    for (const name of [
      'execute_sql',
      'claim_outbox_events',
      'ingest_payment_provider_event',
      'retry_payment_provider_events',
    ]) {
      expect(writeTools.some((tool) => tool.name === name)).toBe(false);
      await expect(write.client.callTool({ name, arguments: {} })).rejects.toThrow('not found');
    }
    await expect(
      readonly.client.callTool({ name: 'create_customer', arguments: { idempotency_key: 'not-permitted' } }),
    ).rejects.toThrow('not found');
    await expect(readonly.client.callTool({ name: 'upload_product_media', arguments: {} })).rejects.toThrow(
      'not found',
    );
    expect(calls).toHaveLength(0);
  } finally {
    await readonly.close();
    await write.close();
  }
});

test('MCP 严格 schema 阻止身份注入、非法嵌套 PATCH、退款参数冲突', async () => {
  const { backend, calls } = fakeBackend(() => Response.json(null));
  const session = await mcpSession(backend, true);
  const id = crypto.randomUUID();
  try {
    for (const [name, args] of [
      ['redrive_outbox_event', { event_id: id, expected_attempt: 25, reason: 'test', worker_id: 'forged' }],
      ['list_admin_products', { page_size: 101 }],
      ['list_admin_inventory_movements', { after_id: 9007199254740992 }],
      ['list_admin_inventory_movements', { reason_filter: 'transfer' }],
      ...[0, -1, 1.5, 2147483648].map(
        (quantity) =>
          [
            'transfer_inventory',
            {
              variant_id: id,
              from_location_id: id,
              to_location_id: crypto.randomUUID(),
              quantity,
              idempotency_key: 'x',
            },
          ] as const,
      ),
      [
        'transfer_inventory',
        { variant_id: id, from_location_id: id, to_location_id: id, quantity: 1, idempotency_key: 'x' },
      ],
      ['list_admin_locations', { active: 'true' }],
      ['create_location', { location_id: id, changes: { code: 'only-code' } }],
      ['update_location', { location_id: id, expected_revision: 1, changes: { is_default: true } }],
      ['set_default_location', { location_id: id }],
      ['create_product', { product_id: id, changes: {} }],
      [
        'update_customer',
        { customer_id: id, expected_updated_at: '2026-09-20T00:00:00Z', changes: { auth_user_id: id } },
      ],
      ['create_customer_address', { customer_id: id, address_id: id, changes: { country: 'US' } }],
      [
        'update_customer_address',
        {
          customer_id: id,
          address_id: id,
          expected_updated_at: '2026-09-20T00:00:00Z',
          changes: { is_default: true },
        },
      ],
      ['delete_customer_address', { customer_id: id, address_id: id }],
      ['create_category', { category_id: id, changes: { name: 'Missing slug' } }],
      ['list_admin_categories', { root_only: true, parent_id: id }],
      [
        'update_category',
        {
          category_id: id,
          expected_updated_at: '2026-09-20T00:00:00.123456Z',
          changes: { created_at: 'forged' },
        },
      ],
      ['update_product', { product_id: id, expected_revision: 1, changes: { product: { revision: 99 } } }],
      [
        'update_product',
        { product_id: id, expected_revision: 1, changes: { variants: [{ id, delete: true, price: 8 }] } },
      ],
      ['update_fulfillment', { fulfillment_id: id, expected_version: 1, idempotency_key: 'x', changes: {} }],
      ['refund_order', { order_id: id, idempotency_key: 'x', amount: 10, shipping_amount: 1 }],
      ['adjust_inventory', { variant_id: id, delta: 3 }],
      ['list_admin_outbox_events', { after_id: 9007199254740992 }],
    ] as const) {
      expect((await session.client.callTool({ name, arguments: args })).isError).toBe(true);
    }
    expect(calls).toHaveLength(0);
  } finally {
    await session.close();
  }
});

test('MCP 保留大整数游标/微秒时间戳且用户 JWT 透传，不暴露凭据', async () => {
  const { backend, calls } = fakeBackend(async (request) => Response.json(await request.json()));
  const session = await mcpSession(backend);
  try {
    expect(
      await toolData<{ after_id: string }>(session.client, 'list_admin_outbox_events', {
        after_id: '9007199254740993',
      }),
    ).toEqual({ after_id: '9007199254740993' });
    const cursor = { updated_at: '2026-09-20T11:12:13.123456+00:00', id: crypto.randomUUID() };
    expect(
      await toolData<{ after_cursor: typeof cursor }>(session.client, 'list_admin_products', {
        after_cursor: cursor,
      }),
    ).toEqual({ after_cursor: cursor });
    expect(calls).toHaveLength(6);
    expect(calls.every((call) => call.headers.get('authorization') === 'Bearer private-session')).toBe(true);
    expect(
      calls.every((call) => call.headers.get('apikey') === 'public-key' && call.redirect === 'error'),
    ).toBe(true);
  } finally {
    await session.close();
  }
});

test('目录 position 接受 PostgreSQL int4 边界，拒绝越界及小数', () => {
  const id = crypto.randomUUID();
  for (const group of ['variants', 'images', 'options', 'option_values']) {
    for (const position of [-2147483648, -1, 0, 2147483647]) {
      expect(productChanges.safeParse({ [group]: [{ id, position }] }).success).toBe(true);
    }
    for (const position of [-2147483649, 2147483648, -0.5]) {
      expect(productChanges.safeParse({ [group]: [{ id, position }] }).success).toBe(false);
    }
  }
});

test('权限拒绝发生在业务调用之前；错误文本不泄漏 SQL details 或网络异常', async () => {
  const denied = fakeBackend(() => {
    throw new Error('must not run');
  }, false);
  const session = await mcpSession(denied.backend, true);
  try {
    const result = await session.client.callTool({
      name: 'create_customer',
      arguments: { idempotency_key: 'x' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('ADMIN_REQUIRED');
    expect(denied.calls).toHaveLength(2);
  } finally {
    await session.close();
  }
  for (const [response, unknown] of [
    [
      () =>
        Response.json(
          { code: 'PT409', message: 'private-session', details: 'customer-email-secret' },
          { status: 409 },
        ),
      false,
    ],
    [
      () => {
        throw new Error('private-session customer-email-secret');
      },
      true,
    ],
  ] as const) {
    const { backend, calls } = fakeBackend(response);
    const session = await mcpSession(backend, true);
    try {
      const result = await session.client.callTool({
        name: 'create_customer',
        arguments: { idempotency_key: 'x' },
      });
      expect(result.isError).toBe(true);
      const text = JSON.stringify(result);
      expect(text).not.toContain('private-session');
      expect(text).not.toContain('customer-email-secret');
      const content = result.content as Array<{ type: string; text: string }>;
      expect(JSON.parse(content[0].text)).toMatchObject({
        outcome_unknown: unknown,
        code: unknown ? 'BACKEND_UNAVAILABLE' : 'PT409',
      });
      expect(calls).toHaveLength(3); // no automatic retry
    } finally {
      await session.close();
    }
  }
});

test('拒绝非 TLS 远程端点和带凭据/路径的 URL；拒绝匿名或 service 身份', async () => {
  for (const url of [
    'http://shop.example',
    'https://user:password@shop.example',
    'https://shop.example/rest/v1',
    'https://shop.example?x=1',
  ]) {
    expect(() => new AdminBackend({ ...config, url })).toThrow();
  }
  for (const identity of [{ ...user, is_anonymous: true }, { ...user, role: 'service_role' }, null]) {
    let calls = 0;
    const backend = new AdminBackend(config, async () => {
      calls++;
      return Response.json(identity);
    });
    await expect(backend.assertAdmin()).rejects.toThrow('ADMIN_REQUIRED');
    expect(calls).toBe(1);
  }
});

test('媒体仅接受有界规范 base64 和固定 MIME，拒绝路径、URL、bucket 注入', () => {
  const args = {
    product_id: crypto.randomUUID(),
    media_id: crypto.randomUUID(),
    content_type: 'image/png',
    data_base64: 'AA==',
  };
  expect(uploadProductMedia.safeParse(args).success).toBe(true);
  for (const changes of [
    { data_base64: '' },
    { data_base64: 'AB==' },
    { data_base64: 'AA' },
    { data_base64: 'AA==\n' },
    { data_base64: 'data:image/png;base64,AA==' },
    { content_type: 'image/svg+xml' },
    { media_id: '../file' },
    { bucket: 'other' },
    { url: 'https://example.test/image.png' },
    { data_base64: Buffer.alloc(1048577).toString('base64') },
  ])
    expect(uploadProductMedia.safeParse({ ...args, ...changes }).success).toBe(false);
  expect(
    uploadProductMedia.safeParse({ ...args, data_base64: Buffer.alloc(1048576).toString('base64') }).success,
  ).toBe(true);
});

test('媒体上传发送原始字节、不覆盖、不泄漏或重试未知结果，权限拒绝不访问 Storage', async () => {
  const args = {
    product_id: crypto.randomUUID(),
    media_id: crypto.randomUUID(),
    content_type: 'image/png',
    data_base64: 'AP+A',
  };
  for (const denied of [true, false]) {
    const { backend, calls } = fakeBackend(async (request) => {
      if (request.url.endsWith('/get_admin_product')) return Response.json({ id: args.product_id });
      throw new Error('private-session');
    }, !denied);
    const session = await mcpSession(backend, true);
    try {
      const result = await session.client.callTool({ name: 'upload_product_media', arguments: args });
      expect(result.isError).toBe(true);
      const text = JSON.stringify(result);
      expect(text).not.toContain('private-session');
      expect(text).toContain(denied ? 'ADMIN_REQUIRED' : 'BACKEND_UNAVAILABLE');
      const content = result.content as Array<{ text: string }>;
      expect(JSON.parse(content[0].text).outcome_unknown).toBe(!denied);
      expect(calls).toHaveLength(denied ? 2 : 4);
      if (!denied) {
        const request = calls[3];
        expect(request.url).toBe(
          `${config.url}/storage/v1/object/catalog-media/products/${args.product_id}/${args.media_id}.png`,
        );
        expect(request.headers.get('x-upsert')).toBe('false');
        expect(request.headers.get('content-type')).toBe('image/png');
        expect(new Uint8Array(await request.arrayBuffer())).toEqual(new Uint8Array([0, 255, 128]));
      }
    } finally {
      await session.close();
    }
  }
});
