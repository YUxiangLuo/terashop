import { expect, test } from 'bun:test';
import { adminRecordLinks, validateAdminOrigin } from '../../mcp/src/admin-links';
import { AdminBackend } from '../../mcp/src/backend';
import { mcpSession } from '../support/mcp';

const origin = 'https://admin.example:8443';
test('Admin links use fixed routes and validated UUIDs, never merchant text or Auth identities', () => {
  expect(validateAdminOrigin(origin)).toBe(origin);
  expect(validateAdminOrigin(undefined)).toBeUndefined();
  for (const input of [
    '',
    'http://admin.example',
    'https://admin.example/',
    'https://admin.example/path',
    'https://user:secret@admin.example',
    'https://admin.example?token=x',
    'https://admin.example#x',
    ' https://admin.example',
    'https://ADMIN.example',
    'javascript:alert(1)',
  ])
    expect(() => validateAdminOrigin(input)).toThrow();
  const id = crypto.randomUUID(),
    other = crypto.randomUUID();
  for (const [entity, path] of [
    ['product', 'products'],
    ['order', 'orders'],
    ['customer', 'customers'],
  ]) {
    const row = { id, auth_user_id: other, name: 'https://evil.example', url: 'https://evil.example' };
    expect(adminRecordLinks(origin, `get_admin_${entity}`, row).map((l) => l.uri)).toEqual([
      `${origin}/${path}/${id}`,
    ]);
    expect(
      adminRecordLinks(origin, `list_admin_${path}`, {
        items: [row, { id: other }],
        next_cursor: 'evil',
      }).map((l) => l.uri),
    ).toEqual([`${origin}/${path}/${id}`, `${origin}/${path}/${other}`]);
    expect(JSON.stringify(adminRecordLinks(origin, `get_admin_${entity}`, row))).not.toContain('evil');
  }
  expect(adminRecordLinks(origin, 'get_admin_user', { id })).toEqual([]);
  expect(adminRecordLinks(origin, 'create_product', { id })).toEqual([]);
  expect(adminRecordLinks(origin, 'get_admin_order', null)).toEqual([]);
  expect(adminRecordLinks(undefined, 'get_admin_order', { id })).toEqual([]);
  expect(adminRecordLinks(origin, 'get_admin_order', { id: '../login?token=x' })).toEqual([]);
});

test('quote navigation uses the quote UUID, never its linked order or a cancellation route', () => {
  const quoteId = crypto.randomUUID(),
    orderId = crypto.randomUUID(),
    customerId = crypto.randomUUID();
  const row = {
    id: quoteId,
    order_id: orderId,
    customer_id: customerId,
    customer_note: 'https://evil.example',
    status: 'expired',
  };
  for (const name of ['get_admin_checkout_quote', 'get_order_checkout_quote']) {
    const links = adminRecordLinks(origin, name, row);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      uri: `${origin}/quotes/${quoteId}`,
      name: `Open checkout quote ${quoteId} in Admin`,
    });
    expect(JSON.stringify(links)).not.toContain(orderId);
    expect(JSON.stringify(links)).not.toContain(customerId);
    expect(JSON.stringify(links)).not.toContain('evil');
    expect(adminRecordLinks(undefined, name, row)).toEqual([]);
    expect(adminRecordLinks(origin, name, null)).toEqual([]);
  }
  expect(
    adminRecordLinks(origin, 'list_admin_checkout_quotes', {
      items: [row, { ...row, id: customerId, order_id: null }],
    }).map((x) => x.uri),
  ).toEqual([`${origin}/quotes/${quoteId}`, `${origin}/quotes/${customerId}`]);
  expect(adminRecordLinks(origin, 'list_admin_checkout_quotes', { items: [] })).toEqual([]);
  expect(adminRecordLinks(origin, 'get_admin_checkout_quote', { ...row, id: '../cancel' })).toEqual([]);
  expect(adminRecordLinks(origin, 'cancel_checkout_quote', row)).toEqual([]);
  // This SPA route accepts a product UUID to start a transfer, not a transfer record UUID.
  expect(adminRecordLinks(origin, 'get_inventory_transfer', { id: quoteId })).toEqual([]);
});

test('SDK receives optional resource links without changing data; invalid DTOs never publish links', async () => {
  const id = crypto.randomUUID();
  const page = {
    items: [
      {
        id,
        order_number: '9223372036854775807',
        customer_id: crypto.randomUUID(),
        email: 'private@example.test',
        status: 'open',
        financial_status: 'paid',
        fulfillment_status: 'unfulfilled',
        currency: 'USD',
        total: 17.25,
        created_at: '2026-09-23T00:00:00Z',
      },
    ],
    next_cursor: null,
  };
  let data: unknown = page;
  const backend = new AdminBackend(
    { url: 'https://db.example', anonKey: 'public', accessToken: 'secret' },
    async (url) => {
      if (url.endsWith('/auth/v1/user'))
        return Response.json({ id, role: 'authenticated', is_anonymous: false });
      if (url.endsWith('/is_admin')) return Response.json(true);
      return Response.json(data);
    },
  );
  const linked = await mcpSession(backend, false, undefined, origin);
  const unlinked = await mcpSession(backend);
  try {
    const result = await linked.client.callTool({ name: 'list_admin_orders', arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ data: page });
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify({ data: page }) },
      ...adminRecordLinks(origin, 'list_admin_orders', page),
    ]);
    expect(
      (await unlinked.client.callTool({ name: 'list_admin_orders', arguments: {} })).content,
    ).toHaveLength(1);
    data = { ...page, private_field: 'SECRET' };
    const invalid = await linked.client.callTool({ name: 'list_admin_orders', arguments: {} });
    expect(invalid.isError).toBe(true);
    expect(invalid.content).toHaveLength(1);
    expect(JSON.stringify(invalid)).not.toContain(origin);
    data = null;
    expect(
      (await linked.client.callTool({ name: 'get_admin_order', arguments: { order_id: id } })).content,
    ).toHaveLength(1);
  } finally {
    await linked.close();
    await unlinked.close();
  }
});
