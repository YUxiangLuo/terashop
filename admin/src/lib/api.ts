import { createClient } from "@supabase/supabase-js";
import {
  PUBLIC_SUPABASE_URL,
  PUBLIC_SUPABASE_ANON_KEY,
} from "$env/static/public";
import type { Database, Json } from "../../../types/database";
import type { ProductOption, ProductVariant } from "./catalog";
export type { ProductOption, ProductVariant } from "./catalog";

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
  variants: ProductVariant[];
  options: ProductOption[];
  categories: Array<{ id: string; name: string; slug: string }>;
}
export interface Location {
  id: string;
  name: string;
  code: string;
  is_default: boolean;
}
export interface Inventory {
  variant_id: string;
  location_id: string;
  on_hand: number;
  reserved: number;
  available: number;
}
export interface OrderSummary {
  id: string;
  order_number: string;
  email: string;
  status: string;
  financial_status: string;
  fulfillment_status: string;
  total: number;
  created_at: string;
}
export interface OrderPage {
  items: OrderSummary[];
  next_cursor: string | null;
}
export interface OrderDetail extends OrderSummary {
  admin_note: string | null;
  customer_note: string | null;
  shipping_address: Record<string, Json>;
  shipping_method_name: string | null;
  subtotal: number;
  discount_total: number;
  shipping_total: number;
  tax_total: number;
  pricing: {
    lines: Array<{
      id: string;
      name: string;
      sku: string | null;
      variant_title: string;
      quantity: number;
      unit_price: number;
      line_total: number;
    }>;
  };
  fulfillments: Array<{
    id: string;
    status: string;
    carrier: string;
    tracking_number: string;
    created_at: string;
    lines: Array<{ order_item_id: string; quantity: number }>;
  }>;
}
export interface FulfillmentBalance {
  is_fulfillable: boolean;
  payment_hold: boolean;
  lines: Array<{ order_item_id: string; available_quantity: number }>;
}
export interface ProductPage {
  items: ProductSummary[];
  next_cursor: { updated_at: string; id: string } | null;
}
export const money = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value);
export const dateTime = (value: string) => new Date(value).toLocaleString();
export const statusLabel = (value: string) => value.replaceAll("_", " ");

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
    return "Another edit changed this record. Reload the saved version and review it before saving again.";
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
