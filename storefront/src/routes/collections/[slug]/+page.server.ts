import { error } from "@sveltejs/kit";
import { catalog } from "$lib/server/catalog";
import type { PageServerLoad } from "./$types";
export async function entries() {
  return (await catalog()).categories.map((category) => ({
    slug: category.slug,
  }));
}
export const load: PageServerLoad = async ({ params }) => {
  const { products, categories } = await catalog();
  const category = categories.find((row) => row.slug === params.slug);
  if (!category) error(404, "Collection not found");
  return {
    category,
    products: products.filter((product) =>
      product.categories.some((row) => row.id === category.id),
    ),
  };
};
