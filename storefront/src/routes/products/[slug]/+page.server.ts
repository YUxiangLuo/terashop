import { error } from "@sveltejs/kit";
import { catalog } from "$lib/server/catalog";
import type { PageServerLoad } from "./$types";
export async function entries() {
  return (await catalog()).products.map((product) => ({ slug: product.slug }));
}
export const load: PageServerLoad = async ({ params }) => {
  const product = (await catalog()).products.find(
    (row) => row.slug === params.slug,
  );
  if (!product) error(404, "Product not found");
  return { product };
};
