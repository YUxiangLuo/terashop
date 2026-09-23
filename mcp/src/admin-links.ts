import * as z from 'zod/v4';

export function validateAdminOrigin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value)
    throw new Error('Admin origin must be an exact HTTPS origin without path or credentials');
  return value;
}

// Only validated read DTOs enter here. Never use merchant text or a supplied URL.
export function adminRecordLinks(origin: string | undefined, tool: string, data: unknown) {
  if (!origin || data === null) return [];
  let route: string;
  let label: string;
  switch (tool) {
    case 'get_admin_product':
    case 'list_admin_products':
      route = 'products';
      label = 'product';
      break;
    case 'get_admin_order':
    case 'list_admin_orders':
      route = 'orders';
      label = 'order';
      break;
    case 'get_admin_customer':
    case 'list_admin_customers':
      route = 'customers';
      label = 'customer';
      break;
    case 'get_admin_checkout_quote':
    case 'list_admin_checkout_quotes':
    case 'get_order_checkout_quote':
      route = 'quotes';
      label = 'checkout quote';
      break;
    default:
      return [];
  }
  const rows = tool.startsWith('list_') ? (data as { items: unknown[] }).items : [data];
  return rows.flatMap((row) => {
    const id = z.uuid().safeParse((row as { id?: unknown }).id);
    if (!id.success) return [];
    return [
      {
        type: 'resource_link' as const,
        uri: `${origin}/${route}/${id.data}`,
        name: `Open ${label} ${id.data} in Admin`,
        mimeType: 'text/html',
        description:
          'Navigation only. Requires your separate Admin login and current permissions. Not an authorization or approval receipt.',
      },
    ];
  });
}
