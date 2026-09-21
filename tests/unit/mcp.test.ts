import { expect, test } from 'bun:test';
import { AdminBackend } from '../../mcp/src/backend';
import { productChanges, uploadProductMedia, paypalRefund } from '../../mcp/src/schemas';
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

test('退货嵌套合同保留收货与处置，拒绝审计字段泄漏；所有新合同写失败不重试', async () => {
  const id = crypto.randomUUID(),
    at = '2026-09-20T11:12:13.123456+00:00';
  const disposition = {
    id,
    receipt_line_id: id,
    quantity: 1,
    disposition: 'discard',
    inventory_movement_id: null,
    note: null,
    created_at: at,
  };
  const receipt = {
    id,
    return_id: id,
    order_id: id,
    location_id: id,
    note: null,
    received_at: at,
    lines: [{ id, return_line_id: id, quantity: 2, undisposed_quantity: 1, dispositions: [disposition] }],
  };
  const authorization = {
    id,
    order_id: id,
    fulfillment_id: id,
    status: 'closed',
    reason: null,
    created_at: at,
    closed_at: at,
    lines: [{ id, order_item_id: id, quantity: 3, received_quantity: 2, receivable_quantity: 0 }],
    receipts: [receipt],
  };
  const returns = {
    order_id: id,
    returns: [authorization],
    lines: [
      {
        fulfillment_id: id,
        order_item_id: id,
        shipped_quantity: 4,
        authorized_unreceived_quantity: 0,
        received_quantity: 2,
        available_quantity: 2,
      },
    ],
  };
  const balance = {
    order_id: id,
    payment_hold: true,
    is_fulfillable: false,
    lines: [
      {
        order_item_id: id,
        ordered_quantity: 4,
        fulfilled_quantity: 1,
        cancelled_quantity: 1,
        reserved_quantity: 1,
        available_quantity: 0,
      },
    ],
  };
  let response: unknown;
  const { backend, calls } = fakeBackend(() => Response.json(response));
  const session = await mcpSession(backend, true);
  try {
    const cases = [
      ['get_order_returns', { order_id: id }, returns, false],
      ['get_order_fulfillment_balance', { order_id: id }, balance, false],
      [
        'create_return',
        { fulfillment_id: id, items: [{ order_item_id: id, quantity: 3 }], idempotency_key: 'retained' },
        authorization,
        true,
      ],
      [
        'receive_return',
        {
          return_id: id,
          location_id: id,
          items: [{ return_line_id: id, quantity: 2 }],
          idempotency_key: 'retained',
        },
        receipt,
        true,
      ],
      [
        'dispose_return_receipt',
        { receipt_line_id: id, quantity: 1, disposition: 'discard', idempotency_key: 'retained' },
        disposition,
        true,
      ],
      ['close_return', { return_id: id }, authorization, true],
    ] as const;
    for (const [name, args, expected, mutation] of cases) {
      response = expected;
      expect(await toolData<typeof expected>(session.client, name, args)).toEqual(expected);
      response = { ...expected, request_hash: 'SECRET' };
      const before = calls.length;
      const failed = await session.client.callTool({ name, arguments: args });
      expect(failed.isError).toBe(true);
      expect(JSON.parse((failed.content as Array<{ text: string }>)[0].text)).toMatchObject({
        code: 'INVALID_BACKEND_RESPONSE',
        outcome_unknown: mutation,
      });
      expect(JSON.stringify(failed)).not.toContain('SECRET');
      expect(calls.length - before).toBe(3);
    }
    for (const invalid of [
      { ...disposition, inventory_movement_id: 9007199254740992 },
      { ...disposition, disposition: 'refund' },
      { ...disposition, quantity: -1 },
      { ...disposition, actor_id: 'SECRET' },
    ]) {
      response = {
        ...returns,
        returns: [
          {
            ...authorization,
            receipts: [{ ...receipt, lines: [{ ...receipt.lines[0], dispositions: [invalid] }] }],
          },
        ],
      };
      const failed = await session.client.callTool({
        name: 'get_order_returns',
        arguments: { order_id: id },
      });
      expect(failed.isError).toBe(true);
      expect(JSON.stringify(failed)).toContain('INVALID_BACKEND_RESPONSE');
      expect(JSON.stringify(failed)).not.toContain('SECRET');
    }
    response = { ...balance, payment_hold: 'false' };
    expect(
      (await session.client.callTool({ name: 'get_order_fulfillment_balance', arguments: { order_id: id } }))
        .isError,
    ).toBe(true);
  } finally {
    await session.close();
  }
});

test('账本保留负调整和既有渠道引用，但拒绝额外支付秘密及不安全整数', async () => {
  const id = crypto.randomUUID(),
    at = '2026-09-20T11:12:13.123456+00:00';
  const ledger = {
    order: {
      id,
      order_number: '9007199254740993',
      status: 'open',
      financial_status: 'paid',
      fulfillment_status: 'unfulfilled',
      currency: 'USD',
      subtotal: 12,
      total: 10,
      created_at: at,
    },
    balances: { adjustment_total: -2, captured: 10, refunded: 0, net_paid: 10, is_balanced: true },
    adjustments: [
      {
        id: 1,
        order_item_id: null,
        kind: 'discount',
        amount: -2,
        currency: 'USD',
        label: 'Discount',
        source_type: 'order_snapshot',
        source_ref: null,
        created_at: at,
      },
    ],
    payment_intents: [],
    refunds: [],
    fulfillments: [],
    transactions: [
      {
        id,
        payment_intent_id: null,
        parent_transaction_id: null,
        provider: 'manual',
        kind: 'capture',
        status: 'succeeded',
        amount: 10,
        currency: 'USD',
        provider_reference: 'existing-reference',
        processed_at: null,
        created_at: at,
      },
    ],
  };
  let response: unknown = ledger;
  const { backend } = fakeBackend(() => Response.json(response));
  const session = await mcpSession(backend);
  try {
    expect(await toolData<typeof ledger>(session.client, 'get_order_ledger', { order_id: id })).toEqual(
      ledger,
    );
    for (const invalid of [
      { ...ledger, adjustments: [{ ...ledger.adjustments[0], id: 9007199254740992 }] },
      { ...ledger, transactions: [{ ...ledger.transactions[0], metadata: { secret: 'SECRET' } }] },
      { ...ledger, transactions: [{ ...ledger.transactions[0], amount: '10.00' }] },
      { ...ledger, balances: { ...ledger.balances, is_balanced: 'true' } },
    ]) {
      response = invalid;
      const failed = await session.client.callTool({ name: 'get_order_ledger', arguments: { order_id: id } });
      expect(failed.isError).toBe(true);
      expect(JSON.parse((failed.content as Array<{ text: string }>)[0].text)).toMatchObject({
        code: 'INVALID_BACKEND_RESPONSE',
        outcome_unknown: false,
      });
      expect(JSON.stringify(failed)).not.toContain('SECRET');
    }
  } finally {
    await session.close();
  }
});

test('PayPal 明确范围、JWT 透传及返回白名单；Edge 失败/畸形成功均不可盲目重试', async () => {
  const args = { order_id: crypto.randomUUID(), idempotency_key: 'retained', amount: '1.20' };
  const success = {
    refund_request_id: crypto.randomUUID(),
    order_id: args.order_id,
    provider: 'paypal',
    provider_status: 'PENDING',
    pending_reconciliation: true,
  };
  for (const invalid of [
    { amount: undefined },
    { amount: 1.2 },
    { amount: '0' },
    { amount: '1.001' },
    { amount: '1e2' },
    { amount: '1.20', shipping_amount: '2.00' },
    { actor_id: user.id },
    { restock: true },
  ]) {
    expect(paypalRefund.safeParse({ ...args, ...invalid }).success).toBe(false);
  }
  expect(paypalRefund.safeParse({ ...args, amount: undefined, shipping_amount: '0.01' }).success).toBe(true);
  for (const [respond, expected] of [
    [() => Response.json({ ...success, provider_reference: 'SECRET', processing_status: 'SECRET' }), null],
    [() => Response.json({ code: 'PT409', error: 'SECRET' }, { status: 409 }), 'PT409'],
    [() => Response.json({ error: 'SECRET' }, { status: 502 }), 'HTTP_502'],
    [() => Response.json({ ...success, order_id: crypto.randomUUID() }), 'INVALID_BACKEND_RESPONSE'],
    [() => new Response('SECRET'), 'INVALID_BACKEND_RESPONSE'],
    [
      () => {
        throw new Error('SECRET');
      },
      'BACKEND_UNAVAILABLE',
    ],
  ] as const) {
    const { backend, calls } = fakeBackend(respond);
    const session = await mcpSession(backend, true);
    try {
      const result = await session.client.callTool({ name: 'refund_paypal', arguments: args });
      expect(JSON.stringify(result)).not.toContain('SECRET');
      if (expected) {
        expect(result.isError).toBe(true);
        expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toMatchObject({
          code: expected,
          outcome_unknown: true,
        });
      } else expect(result.structuredContent).toEqual({ data: success });
      expect(calls).toHaveLength(3);
      expect(new URL(calls[2].url).pathname).toBe('/functions/v1/paypal-create-refund');
      expect(calls[2].headers.get('authorization')).toBe('Bearer private-session');
      expect(await calls[2].json()).toEqual(args);
    } finally {
      await session.close();
    }
  }
  const denied = fakeBackend(() => {
    throw new Error('must not call Edge');
  }, false);
  await expect(denied.backend.refundPayPal(args)).rejects.toMatchObject({
    code: 'ADMIN_REQUIRED',
    outcomeUnknown: false,
  });
  expect(denied.calls).toHaveLength(2);
});

test('MCP 默认只读；写工具显式启用，不能调用未注册或 service-only 入口', async () => {
  const { backend, calls } = fakeBackend(() => Response.json(null));
  const readonly = await mcpSession(backend);
  const write = await mcpSession(backend, true);
  try {
    const readTools = (await readonly.client.listTools()).tools;
    const writeTools = (await write.client.listTools()).tools;
    expect(readTools.length).toBe(47);
    expect(writeTools.length).toBe(99);
    expect(writeTools.find((t) => t.name === 'refund_paypal')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
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
      ['get_admin_promotion', { promotion_id: id, service: true }],
      ['create_promotion', { promotion_id: id, changes: { name: 'Missing rule' } }],
      ['update_promotion', { promotion_id: id, expected_revision: 1, changes: { used_count: 0 } }],
      [
        'update_promotion',
        {
          promotion_id: id,
          expected_revision: 1,
          changes: { targets: [{ role: 'apply', product_id: id, variant_id: id }] },
        },
      ],
      ['list_admin_promotions', { type_filter: 'bogus' }],
      ['list_admin_promotions', { code_only: 'true' }],
      ['list_admin_promotion_targets', { promotion_id: id, role_filter: 'buy' }],
      ['list_admin_discount_redemptions', {}],
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
      ['list_admin_metafields', { owner_type_filter: 'customer' }],
      ['list_admin_metaobjects', {}],
      ['list_admin_reviews', { rating_filter: 6 }],
      ['list_admin_reconciliation_issues', { status_filter: 'matched' }],
      [
        'get_admin_operations_summary',
        { component: 'database', start_at: '2026-01-01T00:00:00Z', end_at: '2026-01-02T00:00:00Z' },
      ],
      ['list_admin_reconciliation_issues', { after_cursor: { id } }],
      ['get_admin_payment_summary', { start_at: '2026-01-01', end_at: '2026-01-02' }],
      ['get_admin_order_summary', { start_at: '2026-01-01', end_at: '2026-01-02' }],
      ['export_admin_orders', { start_at: '2026-01-01', end_at: '2026-01-02' }],
      [
        'export_admin_orders',
        { start_at: '2026-01-01T00:00:00Z', end_at: '2026-01-02T00:00:00Z', fields: ['email'] },
      ],
      [
        'get_admin_order_summary',
        { start_at: '2026-01-01T00:00:00Z', end_at: '2026-01-02T00:00:00Z', group_by: 'email' },
      ],
      [
        'get_admin_payment_summary',
        { start_at: '2026-01-01T00:00:00Z', end_at: '2026-01-02T00:00:00Z', provider: 'manual' },
      ],
      ['update_shop_settings', { expected_revision: 1, changes: { currency: 'EUR' } }],
      ['update_shop_settings', { expected_revision: 1, changes: { name: null } }],
      ['update_shop_settings', { changes: { name: 'Store' } }],
      ['list_admin_payment_operations', { order_id: id, kind: 'payment_intent', metadata: {} }],
      ['list_admin_payment_operations', { order_id: id, kind: 'provider_events' }],
      ['update_order_admin_note', { order_id: id, changes: { admin_note: 'missing expected' } }],
      [
        'update_order_admin_note',
        { order_id: id, changes: { expected_admin_note: null, admin_note: null, status: 'paid' } },
      ],
      ['list_admin_order_events', { order_id: id, after_id: 123 }],
      ['moderate_review', { review_id: id, status: 'approved' }],
      ['delete_review', { review_id: id }],
      ['delete_metaobject', { metaobject_id: id }],
      ['delete_metaobject_definition', { definition_id: id, expected_revision: 1, cascade: true }],
      ['create_metaobject', { metaobject_id: id, changes: { definition_id: id, handle: 'x' } }],
      ['update_metaobject', { metaobject_id: id, expected_revision: 1, changes: { definition_id: id } }],
      ['update_metaobject', { metaobject_id: id, expected_revision: 1, changes: { values: null } }],
      ['update_metaobject', { metaobject_id: id, expected_revision: 1, changes: { status: 'published' } }],
      ['create_metaobject_definition', { definition_id: id, changes: { type: 'x', name: 'X' } }],
      [
        'update_metaobject_definition',
        { definition_id: id, expected_revision: 1, changes: { type: 'rename' } },
      ],
      [
        'update_metaobject_definition',
        {
          definition_id: id,
          expected_revision: 1,
          changes: { fields: [{ key: 'x', type: 'metaobject_reference' }] },
        },
      ],
      [
        'update_metaobject_definition',
        {
          definition_id: id,
          expected_revision: 1,
          changes: { fields: [{ key: 'x', type: 'text', validations: { regex: '.*' } }] },
        },
      ],
      ['list_admin_metaobjects', { definition_id_filter: id, status_filter: 'published' }],
      ['list_admin_metaobject_definitions', { access_filter: 'customer' }],
      ['list_admin_metafields', { owner_type_filter: 'user', owner_id_filter: id }],
      ['list_admin_metafield_definitions', { access_filter: 'private' }],
      [
        'create_metafield',
        { metafield_id: id, changes: { owner_type: 'shop', owner_id: id, key: 'x', type: 'json' } },
      ],
      [
        'create_metafield',
        {
          metafield_id: id,
          changes: { owner_type: 'product', owner_id: id, key: 'x', type: 'json', value: null },
        },
      ],
      ['update_metafield', { metafield_id: id, expected_revision: 1, changes: { owner_id: id } }],
      ['delete_metafield', { metafield_id: id }],
      ['create_metafield_definition', { definition_id: id, changes: { name: 'Missing identity' } }],
      [
        'update_metafield_definition',
        { definition_id: id, expected_revision: 1, changes: { key: 'rename' } },
      ],
      [
        'update_metafield_definition',
        { definition_id: id, expected_revision: 1, changes: { validations: { regex: '.*' } } },
      ],
      ['create_tax_rate', { tax_rate_id: id, changes: { name: 'Missing country', rate: 0.1 } }],
      ['update_tax_rate', { tax_rate_id: id, expected_revision: 1, changes: { rate: 13 } }],
      ['update_tax_rate', { tax_rate_id: id, expected_revision: 1, changes: { country: null } }],
      ['update_tax_rate', { tax_rate_id: id, expected_revision: 1, changes: { revision: 2 } }],
      ['create_shipping_method', { shipping_method_id: id, changes: { name: 'Missing price' } }],
      [
        'update_shipping_method',
        { shipping_method_id: id, expected_revision: 1, changes: { countries: null } },
      ],
      ['update_shipping_method', { shipping_method_id: id, expected_revision: 1, changes: { revision: 2 } }],
      ['update_shipping_method', { shipping_method_id: id, expected_revision: 1, changes: { price: -1 } }],
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

test('订单分页保留精确字符串，严格输出合同拒绝畸形 DTO 且不泄漏字段', async () => {
  const item = {
    id: crypto.randomUUID(),
    order_number: '9007199254740993',
    customer_id: crypto.randomUUID(),
    email: 'buyer@example.com',
    status: 'open',
    financial_status: 'pending',
    fulfillment_status: 'unfulfilled',
    currency: 'USD',
    total: 12.34,
    created_at: '2026-09-20T11:12:13.123456+00:00',
  };
  let response: Record<string, unknown> = { items: [item], next_cursor: item.order_number };
  const { backend, calls } = fakeBackend(() => Response.json(response));
  const session = await mcpSession(backend);
  try {
    const tools = await session.client.listTools();
    expect(JSON.stringify(tools.tools.find((t) => t.name === 'list_admin_orders')?.outputSchema)).toContain(
      'order_number',
    );
    for (const cursor of ['9007199254740993', '9223372036854775807', '-9223372036854775808', '0']) {
      expect(
        await toolData<Record<string, unknown>>(session.client, 'list_admin_orders', {
          after_order_number: cursor,
        }),
      ).toEqual(response);
      expect(await calls.at(-1)!.json()).toEqual({ after_order_number: cursor });
    }
    const count = calls.length;
    for (const cursor of [
      1,
      9007199254740992,
      '01',
      '-0',
      '+1',
      '1e3',
      '1.1',
      '1\n',
      '',
      '9223372036854775808',
      '-9223372036854775809',
    ]) {
      expect(
        (
          await session.client.callTool({
            name: 'list_admin_orders',
            arguments: { after_order_number: cursor },
          })
        ).isError,
      ).toBe(true);
    }
    expect(calls).toHaveLength(count);
    for (const invalid of [
      { items: [{ ...item, order_number: 9007199254740992 }], next_cursor: null },
      { items: [item], next_cursor: 9007199254740992 },
      { items: [{ ...item, status: 'unknown' }], next_cursor: null },
      { items: [{ ...item, email: undefined }], next_cursor: null },
      { items: [{ ...item, secret: 'sensitive-backend-value' }], next_cursor: null },
    ]) {
      response = invalid;
      const result = await session.client.callTool({ name: 'list_admin_orders', arguments: {} });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain('INVALID_BACKEND_RESPONSE');
      expect(JSON.stringify(result)).not.toContain('sensitive-backend-value');
      expect(result.structuredContent).toBeUndefined();
    }
    response = { items: [], next_cursor: null };
    expect(await toolData<Record<string, unknown>>(session.client, 'list_admin_orders')).toEqual(response);
  } finally {
    await session.close();
  }
});

test('订单嵌套输出保留快照，拒绝字段漂移；写入畸形响应必须标记结果未知且不重试', async () => {
  const id = crypto.randomUUID(),
    at = '2026-09-20T11:12:13.123456+00:00';
  const header = {
    id,
    order_number: '9007199254740993',
    customer_id: crypto.randomUUID(),
    email: 'customer@example.com',
    status: 'open',
    financial_status: 'paid',
    fulfillment_status: 'partially_fulfilled',
    currency: 'USD',
    subtotal: 20,
    discount_total: 2,
    shipping_total: 3,
    tax_total: 2.1,
    total: 23.1,
    tax_context: { status: 'calculated' },
    shipping_address: { country: 'US', custom: { retained: true } },
    billing_address: null,
    shipping_method_id: id,
    shipping_method_name: 'Ground',
    discount_code: null,
    customer_note: 'untrusted text',
    cancel_reason: null,
    paid_at: at,
    payment_expires_at: at,
    cancelled_at: null,
    completed_at: null,
    created_at: at,
    updated_at: at,
  };
  const allocations = {
    discount_allocations: [{ promotion_id: id, label: 'Sale', amount: 2 }],
    tax_lines: [
      { id, tax_rate_id: id, name: 'Tax', country: '*', rate: 0.1, taxable_amount: 18, amount: 1.8 },
    ],
  };
  const pricing = {
    order_id: id,
    currency: 'USD',
    subtotal: 20,
    discount_total: 2,
    shipping_total: 3,
    tax_total: 2.1,
    total: 23.1,
    tax_context: header.tax_context,
    shipping_method_id: id,
    shipping_method_name: 'Ground',
    lines: [
      {
        id,
        line_key: 'historical-key',
        variant_id: null,
        product_id: null,
        name: 'Archived item',
        sku: null,
        variant_title: '',
        options: { size: 'M' },
        attributes: { engraving: 'text' },
        unit_price: 10,
        quantity: 2,
        total: 20,
        discount_total: 2,
        line_total: 18,
        ...allocations,
      },
    ],
    shipping_line: {
      id,
      shipping_method_id: id,
      name: 'Ground',
      gross_amount: 3,
      discount_total: 0,
      threshold_discount: 0,
      total: 3,
      policy: { countries: ['US'] },
      discount_allocations: [],
      tax_lines: [{ ...allocations.tax_lines[0], taxable_amount: 3, amount: 0.3 }],
    },
    promotions: [
      { promotion_id: id, name: 'Sale', code: null, amount: 2, snapshot: { application_index: 1 } },
    ],
  };
  const detail = {
    ...header,
    admin_note: null,
    pricing,
    fulfillments: [
      {
        id,
        order_id: id,
        version: 1,
        status: 'shipped',
        carrier: '',
        tracking_number: '',
        tracking_url: null,
        shipped_at: at,
        delivered_at: null,
        created_at: at,
        lines: [{ order_item_id: id, quantity: 1 }],
      },
    ],
  };
  let response: unknown = detail;
  const { backend, calls } = fakeBackend(() => Response.json(response));
  const session = await mcpSession(backend, true);
  try {
    expect(await toolData<typeof detail>(session.client, 'get_admin_order', { order_id: id })).toEqual(
      detail,
    );
    response = null;
    expect(await toolData<null>(session.client, 'get_admin_order', { order_id: id })).toBeNull();
    response = pricing;
    expect(await toolData<typeof pricing>(session.client, 'get_order_pricing', { order_id: id })).toEqual(
      pricing,
    );
    const writes = [
      ['mark_order_paid', { ...header, admin_note: 'retained' }],
      ['refund_order', header],
      ['cancel_order', header],
    ] as const;
    for (const [name, expected] of writes) {
      response = expected;
      const args =
        name === 'cancel_order' ? { order_id: id } : { order_id: id, idempotency_key: 'original-key' };
      expect(await toolData<typeof expected>(session.client, name, args)).toEqual(expected);
      response = { ...expected, provider_secret: 'SECRET' };
      const before = calls.length;
      const failed = await session.client.callTool({ name, arguments: args });
      expect(failed.isError).toBe(true);
      expect(JSON.parse((failed.content as Array<{ text: string }>)[0].text)).toMatchObject({
        code: 'INVALID_BACKEND_RESPONSE',
        outcome_unknown: true,
      });
      expect(failed.structuredContent).toBeUndefined();
      expect(JSON.stringify(failed)).not.toContain('SECRET');
      expect(calls.length - before).toBe(3);
    }
    for (const invalid of [
      { ...detail, order_number: 9007199254740992 },
      { ...detail, pricing: { ...pricing, lines: [{ ...pricing.lines[0], quantity: '2' }] } },
      {
        ...detail,
        pricing: { ...pricing, shipping_line: { ...pricing.shipping_line, provider_secret: 'SECRET' } },
      },
      {
        ...detail,
        pricing: {
          ...pricing,
          lines: [{ ...pricing.lines[0], tax_lines: [{ ...allocations.tax_lines[0], secret: 'SECRET' }] }],
        },
      },
      {
        ...detail,
        fulfillments: [
          { ...detail.fulfillments[0], lines: [{ order_item_id: id, quantity: 1, secret: 'SECRET' }] },
        ],
      },
    ]) {
      response = invalid;
      const failed = await session.client.callTool({ name: 'get_admin_order', arguments: { order_id: id } });
      expect(failed.isError).toBe(true);
      expect(JSON.parse((failed.content as Array<{ text: string }>)[0].text)).toMatchObject({
        code: 'INVALID_BACKEND_RESPONSE',
        outcome_unknown: false,
      });
      expect(JSON.stringify(failed)).not.toContain('SECRET');
    }
  } finally {
    await session.close();
  }
});

test('支付输出按 kind 验证，保留八位非 USD 资金与负净额，拒绝数字金额和渠道秘密', async () => {
  const id = crypto.randomUUID(),
    at = '2026-09-20T11:12:13.123456+00:00';
  const movement = {
    id,
    order_id: id,
    provider: 'paypal',
    amount: '999999999999.12345678',
    currency: 'EUR',
    created_at: at,
    provider_event_id: id,
    kind: 'capture',
    payment_intent_id: null,
    refund_request_id: null,
    payment_transaction_id: null,
    reconciliation_status: 'action_required',
    has_error: true,
    matched_at: null,
  };
  const page = { order_id: id, kind: 'money_movement', items: [movement], next_cursor: null };
  const summary = {
    start_at: at,
    end_at: '2026-09-21T00:00:00Z',
    currency: 'USD',
    time_basis: 'payment_transactions.created_at',
    capture_count: '0',
    refund_count: '2',
    captured_amount: '0.00',
    refunded_amount: '19.25',
    net_amount: '-19.25',
  };
  let response: unknown = page;
  const { backend } = fakeBackend(() => Response.json(response));
  const session = await mcpSession(backend);
  try {
    const args = { order_id: id, kind: 'money_movement' };
    expect(await toolData<typeof page>(session.client, 'list_admin_payment_operations', args)).toEqual(page);
    for (const invalid of [
      { ...page, kind: 'payment_intent' },
      { ...page, items: [{ ...movement, amount: 12.3 }] },
      { ...page, items: [{ ...movement, provider_reference: 'SECRET' }] },
    ]) {
      response = invalid;
      const failed = await session.client.callTool({
        name: 'list_admin_payment_operations',
        arguments: args,
      });
      expect(failed.isError).toBe(true);
      expect(JSON.stringify(failed)).toContain('INVALID_BACKEND_RESPONSE');
      expect(JSON.stringify(failed)).not.toContain('SECRET');
    }
    const range = { start_at: summary.start_at, end_at: summary.end_at };
    response = summary;
    expect(await toolData<typeof summary>(session.client, 'get_admin_payment_summary', range)).toEqual(
      summary,
    );
    for (const invalid of [
      { ...summary, net_amount: -19.25 },
      { ...summary, capture_count: 0 },
      { ...summary, secret: 'SECRET' },
    ]) {
      response = invalid;
      const failed = await session.client.callTool({ name: 'get_admin_payment_summary', arguments: range });
      expect(failed.isError).toBe(true);
      expect(JSON.stringify(failed)).not.toContain('SECRET');
    }
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
