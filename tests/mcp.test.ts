import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { AdminBackend } from '../mcp/src/backend';
import {
  API,
  ANON_KEY,
  SERVICE_KEY,
  api,
  checked,
  command,
  signup,
  makeAdmin,
  stockOf,
  type TestUser,
} from './helpers';
import { mcpSession, toolData } from './support/mcp';
import { Cleanup } from './support/cleanup';
import { archiveProduct, stockedProduct } from './support/catalog';
import { fixtureOrder } from './payment-fixtures';

const cleanup = new Cleanup();
let admin: TestUser, buyer: TestUser;
let session: Awaited<ReturnType<typeof mcpSession>>;
const backend = (accessToken: string) => new AdminBackend({ url: API, anonKey: ANON_KEY, accessToken });
beforeAll(async () => {
  admin = await signup();
  buyer = await signup();
  await makeAdmin(admin.userId);
  session = await mcpSession(backend(admin.token), true);
});
afterAll(async () => {
  try {
    await cleanup.run();
  } finally {
    await session?.close();
  }
});

test('真实 stdio 进程完成工具发现和只读调用，stdout 未混入日志', async () => {
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['mcp/src/stdio.ts'],
    cwd: process.cwd(),
    stderr: 'pipe',
    env: { TERA_SUPABASE_URL: API, TERA_SUPABASE_ANON_KEY: ANON_KEY, TERA_ADMIN_ACCESS_TOKEN: admin.token },
  });
  let stderr = '';
  transport.stderr?.on('data', (data) => {
    stderr += String(data);
  });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    expect(tools.some((tool) => tool.name === 'get_admin_product')).toBe(true);
    expect(tools.some((tool) => tool.name === 'create_product')).toBe(false);
    expect(await toolData(client, 'get_admin_product', { product_id: crypto.randomUUID() })).toBeNull();
    expect(stderr).toBe('');
  } finally {
    await client.close();
  }
}, 20_000);

test('MCP 商品创建/读取/修改，版本冲突不覆盖，未知 UUID 返回 null', async () => {
  const productId = crypto.randomUUID(),
    variantId = crypto.randomUUID();
  const created = await toolData<{ id: string; revision: number }>(session.client, 'create_product', {
    product_id: productId,
    changes: {
      product: { slug: `mcp-${productId}`, name: 'MCP draft' },
      variants: [{ id: variantId, price: 17.25 }],
    },
  });
  cleanup.defer(() => archiveProduct(productId));
  expect(created.id).toBe(productId);
  const updated = await toolData<{ revision: number; name: string }>(session.client, 'update_product', {
    product_id: productId,
    expected_revision: created.revision,
    changes: { product: { name: 'MCP revised' } },
  });
  expect(updated.name).toBe('MCP revised');
  expect(updated.revision).toBeGreaterThan(created.revision);
  const stale = await session.client.callTool({
    name: 'update_product',
    arguments: {
      product_id: productId,
      expected_revision: created.revision,
      changes: { product: { name: 'Lost update' } },
    },
  });
  expect(stale.isError).toBe(true);
  expect(JSON.stringify(stale)).toContain('PT409');
  expect(await toolData(session.client, 'get_admin_product', { product_id: productId })).toMatchObject({
    name: 'MCP revised',
  });
});

test('MCP 商品列表保留无变体草稿的空价格区间', async () => {
  const id = crypto.randomUUID();
  const created = await toolData<{ revision: number; updated_at: string }>(session.client, 'create_product', {
    product_id: id,
    changes: { product: { slug: id, name: id } },
  });
  cleanup.defer(() => archiveProduct(id));
  const expected = {
    items: [
      {
        id,
        slug: id,
        name: id,
        status: 'draft',
        revision: created.revision,
        updated_at: created.updated_at,
        currency: 'USD',
        price_from: null,
        price_to: null,
        variant_count: 0,
        primary_image: null,
      },
    ],
    next_cursor: null,
  };
  expect(await toolData<typeof expected>(session.client, 'list_admin_products', { search: id })).toEqual(
    expected,
  );
});

test('MCP 库存幂等重试只调整一次，异参同键拒绝', async () => {
  const product = await stockedProduct(admin, { onHand: 11, cleanup });
  const args = { variant_id: product.variantId, delta: -4, idempotency_key: crypto.randomUUID() };
  expect(await toolData(session.client, 'adjust_inventory', args)).toMatchObject({ on_hand: 7 });
  expect(await toolData(session.client, 'adjust_inventory', args)).toMatchObject({ on_hand: 7 });
  const conflict = await session.client.callTool({
    name: 'adjust_inventory',
    arguments: { ...args, delta: 3 },
  });
  expect(conflict.isError).toBe(true);
  expect(JSON.stringify(conflict)).toContain('PT409');
});

test('RPC 与 MCP 双向重试保留幂等键，特殊空白不合并为另一个操作', async () => {
  const product = await stockedProduct(admin, { onHand: 11, cleanup });
  const bareKey = crypto.randomUUID();
  const args = { variant_id: product.variantId, delta: 7, idempotency_key: `\t${bareKey}\n` };
  expect(await checked(command('adjust_inventory', args, admin.token))).toMatchObject({ on_hand: 18 });
  expect(await toolData(session.client, 'adjust_inventory', args)).toMatchObject({ on_hand: 18 });
  const reverse = { ...args, delta: -4, idempotency_key: `\u00a0${crypto.randomUUID()}\u00a0` };
  expect(await toolData(session.client, 'adjust_inventory', reverse)).toMatchObject({ on_hand: 14 });
  expect(await checked(command('adjust_inventory', reverse, admin.token))).toMatchObject({ on_hand: 14 });
  expect(
    await toolData(session.client, 'adjust_inventory', { ...args, idempotency_key: bareKey }),
  ).toMatchObject({ on_hand: 21 });
  // PostgreSQL validates length after btrim, in Unicode characters, not UTF-16 units.
  const padded = { ...args, delta: 1, idempotency_key: ` ${'😀'.repeat(164)}${crypto.randomUUID()} ` };
  expect(await checked(command('adjust_inventory', padded, admin.token))).toMatchObject({ on_hand: 22 });
  expect(await toolData(session.client, 'adjust_inventory', padded)).toMatchObject({ on_hand: 22 });
  for (const invalid of ['', '   ', 'x'.repeat(201)]) {
    const result = await session.client.callTool({
      name: 'adjust_inventory',
      arguments: { ...args, idempotency_key: invalid },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('22023');
  }
  expect(await stockOf(product.sku)).toBe(22);
});

test('MCP 创建和修改保留四类子资源的负数排序位置', async () => {
  const productId = crypto.randomUUID(),
    variantId = crypto.randomUUID(),
    imageId = crypto.randomUUID();
  const optionId = crypto.randomUUID(),
    valueId = crypto.randomUUID();
  const changes = {
    product: { slug: `mcp-position-${productId}`, name: 'Position test' },
    variants: [{ id: variantId, price: 10, position: -1 }],
    images: [{ id: imageId, url: 'https://example.test/product.png', position: -2 }],
    options: [{ id: optionId, name: 'Size', position: -3 }],
    option_values: [{ id: valueId, option_id: optionId, value: 'Small', position: -4 }],
  };
  // First establish that this is an existing SQL contract, not a new MCP rule.
  const original = await checked<{ revision: number }>(
    command('create_product', { product_id: productId, changes }, admin.token),
  );
  cleanup.defer(() => archiveProduct(productId));
  const updated = await toolData<{ revision: number }>(session.client, 'update_product', {
    product_id: productId,
    expected_revision: original.revision,
    changes: {
      variants: [{ id: variantId, position: -5 }],
      images: [{ id: imageId, position: -6 }],
      options: [{ id: optionId, position: -7 }],
      option_values: [{ id: valueId, position: -8 }],
    },
  });
  expect(updated.revision).toBeGreaterThan(original.revision);
  expect(await toolData(session.client, 'get_admin_product', { product_id: productId })).toMatchObject({
    variants: [{ id: variantId, position: -5 }],
    images: [{ id: imageId, position: -6 }],
    options: [{ id: optionId, position: -7, values: [{ id: valueId, position: -8 }] }],
  });
  const newId = crypto.randomUUID();
  const created = await toolData(session.client, 'create_product', {
    product_id: newId,
    changes: {
      product: { slug: `mcp-position-${newId}`, name: 'Negative create' },
      variants: [{ id: crypto.randomUUID(), price: 10, position: -2147483648 }],
    },
  });
  cleanup.defer(() => archiveProduct(newId));
  expect(created).toMatchObject({ variants: [{ position: -2147483648 }] });
});

test('MCP 订单手工记账→履约→版本化物流→账本读取', async () => {
  const product = await stockedProduct(admin, { onHand: 9, price: 17.25, cleanup });
  const order = await fixtureOrder(product, buyer, 3);
  const args = { order_id: order.id, idempotency_key: crypto.randomUUID() };
  expect(
    await toolData(session.client, 'get_order_fulfillment_balance', { order_id: order.id }),
  ).toMatchObject({
    is_fulfillable: false,
    lines: [{ ordered_quantity: 3, available_quantity: 0 }],
  });
  expect(await toolData(session.client, 'mark_order_paid', args)).toMatchObject({
    financial_status: 'paid',
    total: 51.75,
  });
  expect(await toolData(session.client, 'mark_order_paid', args)).toMatchObject({
    financial_status: 'paid',
    total: 51.75,
  });
  const fulfillment = await toolData<{ id: string; version: number }>(session.client, 'create_fulfillment', {
    order_id: order.id,
    items: [{ order_item_id: order.itemId, quantity: 2 }],
    idempotency_key: crypto.randomUUID(),
  });
  const update = {
    fulfillment_id: fulfillment.id,
    expected_version: fulfillment.version,
    changes: { tracking_number: 'MCP-123' },
    idempotency_key: crypto.randomUUID(),
  };
  const result = await toolData<{ version: number }>(session.client, 'update_fulfillment', update);
  expect(result).toMatchObject({ tracking_number: 'MCP-123' });
  expect(await toolData(session.client, 'update_fulfillment', update)).toMatchObject({
    version: result.version,
  });
  expect(await toolData(session.client, 'get_admin_order', { order_id: order.id })).toMatchObject({
    fulfillment_status: 'partially_fulfilled',
  });
  expect(
    await toolData(session.client, 'get_order_fulfillment_balance', { order_id: order.id }),
  ).toMatchObject({
    payment_hold: false,
    is_fulfillable: true,
    lines: [{ ordered_quantity: 3, fulfilled_quantity: 2, available_quantity: 1 }],
  });
  const ledger = await toolData<{ transactions: Array<{ kind: string; amount: number }> }>(
    session.client,
    'get_order_ledger',
    { order_id: order.id },
  );
  expect(ledger.transactions.filter((row) => row.kind === 'capture').map((row) => row.amount)).toEqual([
    51.75,
  ]);
});

test('MCP 收货不增加可售库存，处置重放只回库一次，纯金额退款不再次回库', async () => {
  const product = await stockedProduct(admin, { onHand: 8, price: 12.5, cleanup });
  const order = await fixtureOrder(product, buyer, 3);
  await toolData(session.client, 'mark_order_paid', {
    order_id: order.id,
    idempotency_key: crypto.randomUUID(),
  });
  const fulfillment = await toolData<{ id: string }>(session.client, 'create_fulfillment', {
    order_id: order.id,
    items: [{ order_item_id: order.itemId, quantity: 3 }],
    idempotency_key: crypto.randomUUID(),
  });
  const authorization = await toolData<{ id: string; lines: Array<{ id: string }> }>(
    session.client,
    'create_return',
    {
      fulfillment_id: fulfillment.id,
      items: [{ order_item_id: order.itemId, quantity: 2 }],
      idempotency_key: crypto.randomUUID(),
    },
  );
  const [location] = await checked<Array<{ id: string }>>(
    api('/rest/v1/locations?is_default=eq.true&select=id', { token: admin.token }),
  );
  const receipt = await toolData<{ lines: Array<{ id: string; undisposed_quantity: number }> }>(
    session.client,
    'receive_return',
    {
      return_id: authorization.id,
      location_id: location.id,
      items: [{ return_line_id: authorization.lines[0].id, quantity: 2 }],
      idempotency_key: crypto.randomUUID(),
    },
  );
  expect(receipt.lines[0].undisposed_quantity).toBe(2);
  expect(await stockOf(product.sku)).toBe(5);
  const disposition = {
    receipt_line_id: receipt.lines[0].id,
    quantity: 1,
    disposition: 'restock',
    idempotency_key: crypto.randomUUID(),
  };
  await toolData(session.client, 'dispose_return_receipt', disposition);
  await toolData(session.client, 'dispose_return_receipt', disposition);
  expect(await stockOf(product.sku)).toBe(6);
  await toolData(session.client, 'dispose_return_receipt', {
    ...disposition,
    disposition: 'discard',
    idempotency_key: crypto.randomUUID(),
  });
  await toolData(session.client, 'close_return', { return_id: authorization.id });
  const summary = await toolData<{ returns: Array<{ status: string }> }>(
    session.client,
    'get_order_returns',
    { order_id: order.id },
  );
  expect(summary.returns[0].status).toBe('closed');
  await toolData(session.client, 'refund_order', {
    order_id: order.id,
    amount: 25,
    idempotency_key: crypto.randomUUID(),
    reason: 'Manual external refund confirmed',
  });
  expect(await stockOf(product.sku)).toBe(6);
  expect(await toolData(session.client, 'get_order_ledger', { order_id: order.id })).toMatchObject({
    balances: { captured: 37.5, refunded: 25 },
  });
});

test('MCP 客户幂等创建、查询、匿名化后重试不会复原 PII；运维只读 DTO', async () => {
  const args = {
    idempotency_key: crypto.randomUUID(),
    email: `mcp-${crypto.randomUUID()}@example.test`,
    full_name: 'MCP customer',
  };
  const customer = await toolData<{ id: string }>(session.client, 'create_customer', args);
  expect(await toolData(session.client, 'create_customer', args)).toMatchObject({ id: customer.id });
  expect(await toolData(session.client, 'get_admin_customer', { customer_id: customer.id })).toMatchObject({
    id: customer.id,
    email: args.email,
  });
  const found = await toolData<{ items: Array<{ id: string }> }>(session.client, 'list_admin_customers', {
    search: args.email,
  });
  expect(found.items.map((row) => row.id)).toEqual([customer.id]);
  await toolData(session.client, 'anonymize_customer', { customer_id: customer.id });
  expect(await toolData(session.client, 'create_customer', args)).toMatchObject({
    id: customer.id,
    email: null,
    full_name: '',
  });
  const outbox = await toolData<{ items: Array<Record<string, unknown>> }>(
    session.client,
    'list_admin_outbox_events',
    { page_size: 2 },
  );
  expect(outbox.items.length).toBeGreaterThan(0);
  for (const item of outbox.items) {
    expect(typeof item.id).toBe('string');
    expect(item).not.toHaveProperty('payload');
    expect(item).not.toHaveProperty('lease_token');
  }
  expect(
    await toolData<boolean>(session.client, 'redrive_outbox_event', {
      event_id: crypto.randomUUID(),
      expected_attempt: 25,
      reason: 'Missing event test',
    }),
  ).toBe(false);
  const inbox = await toolData<{ items: unknown[] }>(session.client, 'list_admin_payment_provider_events', {
    resource_id: crypto.randomUUID(),
  });
  expect(inbox.items).toHaveLength(0);
});

test('MCP 拒绝普通用户与 service token，撤销管理员权限立即阻止已有会话', async () => {
  for (const token of [buyer.token, SERVICE_KEY, 'invalid-token']) {
    const denied = await mcpSession(backend(token), true);
    try {
      expect(
        (
          await denied.client.callTool({
            name: 'create_customer',
            arguments: { idempotency_key: crypto.randomUUID() },
          })
        ).isError,
      ).toBe(true);
    } finally {
      await denied.close();
    }
  }
  const revocable = await signup();
  await makeAdmin(revocable.userId);
  const active = await mcpSession(backend(revocable.token), true);
  try {
    expect(
      await toolData(active.client, 'get_admin_product', { product_id: crypto.randomUUID() }),
    ).toBeNull();
    await checked(
      api(`/rest/v1/profiles?id=eq.${revocable.userId}`, {
        service: true,
        method: 'PATCH',
        body: { role: 'customer' },
      }),
    );
    const denied = await active.client.callTool({
      name: 'get_admin_product',
      arguments: { product_id: crypto.randomUUID() },
    });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).toContain('ADMIN_REQUIRED');
  } finally {
    await active.close();
  }
});
