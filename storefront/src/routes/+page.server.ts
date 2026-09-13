import { catalog } from "$lib/server/catalog";
export async function load() {
  return { products: (await catalog()).products };
}
