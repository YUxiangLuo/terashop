import {
  publicApi,
  getProduct,
  type Product,
  type Category,
} from "$lib/catalog";

// Shared within a build, never contains sessions or private data. Fetch every
// cursor page; fail the build on a missing detail rather than publish half a shop.
let snapshot:
  Promise<{ products: Product[]; categories: Category[] }> | undefined;
export function catalog() {
  return (snapshot ??= (async () => {
    const products: Product[] = [];
    let after_id: string | null = null;
    do {
      const page: { items: { id: string }[]; next_cursor: string | null } =
        await publicApi("rpc/list_storefront_products", {
          page_size: 100,
          after_id,
        });
      for (const item of page.items) {
        const product = await getProduct(item.id);
        if (!product)
          throw new Error("Catalog changed during build; retry the build");
        products.push(product);
      }
      after_id = page.next_cursor;
    } while (after_id);
    const categories = await publicApi<Category[]>(
      "categories?select=id,slug,name,parent_id&is_active=eq.true&order=position,slug",
    );
    return {
      products: products.sort((a, b) => a.slug.localeCompare(b.slug)),
      categories,
    };
  })());
}
