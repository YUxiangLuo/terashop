import {
  PUBLIC_SUPABASE_URL,
  PUBLIC_SUPABASE_ANON_KEY,
} from "$env/static/public";

export interface Category {
  id: string;
  slug: string;
  name: string;
  parent_id?: string | null;
}
export interface Variant {
  id: string;
  price: number;
  compare_at_price: number | null;
  in_stock: boolean;
  option_value_ids: string[];
}
export interface Product {
  id: string;
  slug: string;
  name: string;
  description: string;
  product_type: string;
  seo_title: string | null;
  seo_description: string | null;
  variants: Variant[];
  options: {
    id: string;
    name: string;
    values: { id: string; value: string }[];
  }[];
  images: { url: string; alt: string; variant_id: string | null }[];
  categories: Category[];
  metafields: { namespace: string; key: string; value: unknown }[];
}

export const money = (value: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    value,
  );
export async function publicApi<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${PUBLIC_SUPABASE_URL}/rest/v1/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      apikey: PUBLIC_SUPABASE_ANON_KEY,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    throw new Error(
      "The store could not retrieve current information. Please try again.",
    );
  }
  return response.json();
}
export const getProduct = (id: string) =>
  publicApi<Product | null>("rpc/get_storefront_product", { product_id: id });

export function imageUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.username || url.password) return undefined;
    if (url.protocol === "https:") return value;
    // HTTP is only for this configured local Supabase's public Storage endpoint.
    const local = new URL(PUBLIC_SUPABASE_URL);
    return url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(local.hostname) &&
      url.origin === local.origin &&
      url.pathname.startsWith("/storage/v1/object/public/")
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}
