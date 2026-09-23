import type { AdminChangeScope } from './realtime';

// Pages already managing their own live reads are deliberately omitted.
// These subscriptions never reload the route or touch its form/command state.
export function pageChangeScopes(path: string): AdminChangeScope[] {
  const section = path.split('/')[1];
  switch (section) {
    case 'products':
      return ['products', 'categories', 'configuration'];
    case 'inventory':
      return ['products', 'configuration'];
    case 'orders':
      return /^\/orders\/[^/]+\/returns\/[^/]+\/receive\/?$/.test(path)
        ? ['orders', 'configuration']
        : ['orders'];
    case 'quotes':
      return ['quotes'];
    case 'customers':
      return ['customers', 'orders'];
    case 'locations':
    case 'shipping':
    case 'taxes':
    case 'promotions':
      return ['configuration'];
    case 'outbox':
    case 'payment-events':
    case 'reconciliation':
      return ['operations'];
    default:
      return [];
  }
}
