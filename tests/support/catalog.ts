import { api, checked, command, onlyRow, type TestUser } from '../helpers';
import type { Cleanup } from './cleanup';

export interface CatalogFixture { productId: string; variantId: string; sku: string; slug: string }
export interface CatalogOptions {
  price?: number;
  onHand?: number;
  trackInventory?: boolean;
  label?: string;
  cleanup?: Cleanup;
}

export const archiveProduct = (id: string) => checked(api(`/rest/v1/products?id=eq.${id}`, {
  service: true, method: 'PATCH', body: { status: 'archived' },
}));

// Build through the real published-catalog and inventory command boundaries.
// Domain-specific expected prices, taxes and quantities remain in the tests.
export async function stockedProduct(admin: TestUser, options: CatalogOptions = {}): Promise<CatalogFixture> {
  const suffix = crypto.randomUUID();
  const slug = `fixture-${options.label ?? 'product'}-${suffix}`, sku = `TEST-${suffix}`;
  const { id: productId } = await onlyRow<{ id: string }>(api('/rest/v1/products?select=id', {
    service: true, method: 'POST', body: { slug, name: 'Test product', status: 'draft' },
  }));
  options.cleanup?.defer(() => archiveProduct(productId));
  try {
    const { id: variantId } = await onlyRow<{ id: string }>(api('/rest/v1/product_variants?select=id', {
      service: true, method: 'POST', body: {
        product_id: productId, sku, price: options.price ?? 10, track_inventory: options.trackInventory ?? true,
      },
    }));
    await checked(api(`/rest/v1/products?id=eq.${productId}`, { service: true, method: 'PATCH', body: { status: 'active' } }));
    const onHand = options.onHand ?? 100;
    if (onHand && options.trackInventory !== false) await checked(command('adjust_inventory', {
      variant_id: variantId, delta: onHand, reason: 'restock', note: 'test fixture',
    }, admin.token));
    return { productId, variantId, sku, slug };
  } catch (error) {
    if (!options.cleanup) {
      try { await archiveProduct(productId); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Product setup and cleanup failed'); }
    }
    throw error;
  }
}
