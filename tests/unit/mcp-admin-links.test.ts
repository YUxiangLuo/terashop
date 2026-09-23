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

test('configuration read tools link exact records while preserving SDK data and rejecting invalid results', async () => {
  const id = crypto.randomUUID(),
    parent = crypto.randomUUID();
  const created_at = '2026-09-23T00:00:00Z';
  const common = { id, name: 'https://evil.example?token=secret', is_active: false, created_at };
  const cases = [
    {
      entity: 'category',
      plural: 'categories',
      route: 'categories',
      row: {
        ...common,
        slug: 'private-slug',
        description: '',
        parent_id: parent,
        image_url: null,
        position: -1,
        updated_at: created_at,
      },
    },
    {
      entity: 'location',
      plural: 'locations',
      route: 'locations',
      row: {
        ...common,
        code: 'private-code',
        address: { private: 'address' },
        is_default: false,
        revision: 2,
      },
    },
    {
      entity: 'shipping_method',
      plural: 'shipping_methods',
      route: 'shipping',
      row: {
        ...common,
        revision: 3,
        description: '',
        countries: ['US'],
        price: 3.75,
        free_above: null,
        estimated_days: '2–5',
        position: 2,
        updated_at: created_at,
      },
    },
    {
      entity: 'tax_rate',
      plural: 'tax_rates',
      route: 'taxes',
      row: { ...common, revision: 4, country: 'US', rate: 0.13, include_shipping: false },
    },
    {
      entity: 'promotion',
      plural: 'promotions',
      route: 'promotions',
      row: {
        ...common,
        revision: 5,
        code: 'private-discount',
        type: 'order_fixed',
        params: { amount: 5 },
        priority: 2,
        stackable: false,
        apply_scope: 'all',
        get_scope: 'same_as_apply',
        usage_limit: null,
        used_count: 0,
        per_customer_limit: 1,
        starts_at: null,
        ends_at: null,
        updated_at: created_at,
      },
    },
  ];
  let data: unknown;
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
    for (const item of cases) {
      for (const list of [false, true]) {
        const name = list ? `list_admin_${item.plural}` : `get_admin_${item.entity}`;
        const args = list ? {} : { [`${item.entity}_id`]: id };
        data = list ? { items: [item.row], next_cursor: null } : item.row;
        const result = await linked.client.callTool({ name, arguments: args });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toEqual({ data });
        expect(result.content).toHaveLength(2);
        expect(result.content[1]).toMatchObject({
          type: 'resource_link',
          uri: `${origin}/${item.route}/${id}`,
        });
        expect(JSON.stringify(result.content[1])).not.toMatch(/evil|private|new=|targets|secret/);
        expect(JSON.stringify(result.content[1])).not.toContain(parent);
        expect((await unlinked.client.callTool({ name, arguments: args })).content).toHaveLength(1);
        data = list ? { items: [], next_cursor: null } : null;
        expect((await linked.client.callTool({ name, arguments: args })).content).toHaveLength(1);
        data = list
          ? { items: [{ ...item.row, id: 'invalid' }], next_cursor: null }
          : { ...item.row, id: 'invalid' };
        const invalid = await linked.client.callTool({ name, arguments: args });
        expect(invalid.isError).toBe(true);
        expect(invalid.content).toHaveLength(1);
      }
      for (const action of ['create', 'update'])
        expect(adminRecordLinks(origin, `${action}_${item.entity}`, item.row)).toEqual([]);
    }
    expect(adminRecordLinks(origin, 'list_admin_promotion_targets', { items: [{ id }] })).toEqual([]);
  } finally {
    await linked.close();
    await unlinked.close();
  }
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
