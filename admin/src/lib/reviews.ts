import { supabase } from "./api";
export type ReviewStatus = "pending" | "approved" | "rejected";
export interface Review {
  id: string;
  revision: number;
  product_id: string;
  customer_id: string;
  rating: number;
  title: string;
  body?: string;
  status: ReviewStatus;
  created_at: string;
  updated_at: string;
}
export interface ReviewPage {
  items: Review[];
  next_cursor: string | null;
}
const uuid = /^[0-9a-f-]{36}$/i;
export function review(value: unknown, id?: string, body = false): Review {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid review response. Reload before moderating.");
  const v = value as Record<string, unknown>;
  if (
    !uuid.test(String(v.id)) ||
    (id && String(v.id).toLowerCase() !== id.toLowerCase()) ||
    !Number.isSafeInteger(v.revision) ||
    Number(v.revision) < 1 ||
    !uuid.test(String(v.product_id)) ||
    !uuid.test(String(v.customer_id)) ||
    !Number.isInteger(v.rating) ||
    Number(v.rating) < 1 ||
    Number(v.rating) > 5 ||
    typeof v.title !== "string" ||
    (body && typeof v.body !== "string") ||
    !["pending", "approved", "rejected"].includes(String(v.status)) ||
    typeof v.created_at !== "string" ||
    typeof v.updated_at !== "string"
  )
    throw Error("Invalid review response. Reload before moderating.");
  return v as unknown as Review;
}
export function reviewPage(value: unknown): ReviewPage {
  const v = value as Record<string, unknown>;
  if (
    !v ||
    !Array.isArray(v.items) ||
    !(v.next_cursor === null || uuid.test(String(v.next_cursor)))
  )
    throw Error("Invalid reviews response.");
  return {
    items: v.items.map((x) => review(x)),
    next_cursor: v.next_cursor as string | null,
  };
}
export async function getReview(id: string) {
  const { data, error } = await supabase.rpc("get_admin_review", {
    review_id: id,
  });
  if (error) throw error;
  return data === null ? null : review(data, id, true);
}
export async function moderate(current: Review, status: ReviewStatus) {
  const { data, error } = await supabase.rpc("moderate_review", {
    review_id: current.id,
    expected_revision: current.revision,
    status,
  });
  if (error) throw error;
  const next = review(data, current.id, true);
  if (next.revision < current.revision || next.status !== status)
    throw Error("Invalid moderation receipt. Reload the review.");
  return next;
}
export async function deleteReview(current: Review) {
  const { data, error } = await supabase.rpc("delete_review", {
    review_id: current.id,
    expected_revision: current.revision,
  });
  if (error) throw error;
  const v = data as Record<string, unknown>;
  if (
    !v ||
    String(v.id).toLowerCase() !== current.id.toLowerCase() ||
    v.deleted !== true
  )
    throw Error("Invalid deletion receipt. Check the original review ID.");
}
