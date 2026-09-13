import { catalog } from "$lib/server/catalog";
export async function load() {
  return { categories: (await catalog()).categories };
}
