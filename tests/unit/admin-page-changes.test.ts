import { expect, test } from 'bun:test';
import { pageChangeScopes } from '../../admin/src/lib/page-changes';

test('all remaining business route families have bounded domains without duplicating managed subscriptions', () => {
  for (const path of ['/', '/categories', '/categories/id', '/connections'])
    expect(pageChangeScopes(path)).toEqual([]);
  expect(pageChangeScopes('/products/id')).toEqual(['products', 'categories', 'configuration']);
  expect(pageChangeScopes('/inventory/transfer/id')).toEqual(['products', 'configuration']);
  for (const path of ['/orders', '/orders/id/refunds', '/orders/id/returns/dispose/line'])
    expect(pageChangeScopes(path)).toEqual(['orders']);
  expect(pageChangeScopes('/orders/id/returns/return/receive')).toEqual(['orders', 'configuration']);
  expect(pageChangeScopes('/orders/id/returns/return/receive/')).toEqual(['orders', 'configuration']);
  expect(pageChangeScopes('/orders/id/returns/return/close')).toEqual(['orders']);
  expect(pageChangeScopes('/customers/id')).toEqual(['customers', 'orders']);
  expect(pageChangeScopes('/quotes/id/cancel')).toEqual(['quotes']);
  for (const path of ['/locations', '/shipping/id', '/taxes/id', '/promotions/id/targets'])
    expect(pageChangeScopes(path)).toEqual(['configuration']);
  for (const path of ['/outbox', '/payment-events', '/reconciliation'])
    expect(pageChangeScopes(path)).toEqual(['operations']);
  expect(pageChangeScopes('/order-surprise')).toEqual([]);
});
