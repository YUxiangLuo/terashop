import { createClient } from "@supabase/supabase-js";
import {
  PUBLIC_SUPABASE_URL,
  PUBLIC_SUPABASE_ANON_KEY,
} from "$env/static/public";
import type { Database, Json } from "../../../types/database";

export const supabase = createClient<Database>(
  PUBLIC_SUPABASE_URL,
  PUBLIC_SUPABASE_ANON_KEY,
  {
    auth: {
      storageKey: `tera-admin-${new URL(PUBLIC_SUPABASE_URL).host}`,
      detectSessionInUrl: false,
    },
  },
);

export type ProductStatus = "draft" | "active" | "archived";
export interface ProductImage {
  id: string;
  url: string;
  alt: string;
  position: number;
  variant_id: string | null;
}
export interface ProductSummary {
  id: string;
  name: string;
  slug: string;
  status: ProductStatus;
  revision: number;
  currency: string;
  price_from: number | null;
  variant_count: number;
  primary_image: string | null;
}
export interface ProductDetail {
  id: string;
  name: string;
  slug: string;
  status: ProductStatus;
  revision: number;
  description: string;
  vendor: string;
  product_type: string;
  images: ProductImage[];
  variants: Array<{ id: string; sku: string | null; price: number }>;
}
export interface ProductPage {
  items: ProductSummary[];
  next_cursor: { updated_at: string; id: string } | null;
}
export async function getProduct(id: string): Promise<ProductDetail | null> {
  const { data, error } = await supabase.rpc("get_admin_product", {
    product_id: id,
  });
  if (error) throw error;
  return data as unknown as ProductDetail | null;
}
export async function saveProduct(
  id: string,
  revision: number | null,
  changes: Json,
): Promise<ProductDetail> {
  const result =
    revision === null
      ? await supabase.rpc("create_product", { product_id: id, changes })
      : await supabase.rpc("update_product", {
          product_id: id,
          expected_revision: revision,
          changes,
        });
  if (result.error) throw result.error;
  return result.data as unknown as ProductDetail;
}
export function message(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "PT409"
  )
    return "Another edit changed this product. Reload the saved version and review it before saving again.";
  return error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
    ? error.message
    : "The request failed. Check your connection and try again.";
}
export function imageUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.username || url.password) return undefined;
    if (url.protocol === "https:") return value;
    const local = new URL(PUBLIC_SUPABASE_URL);
    if (
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(local.hostname) &&
      url.origin === local.origin &&
      url.pathname.startsWith("/storage/v1/object/public/")
    )
      return value;
  } catch {
    /* Invalid catalog URLs are not rendered. */
  }
  return undefined;
}
