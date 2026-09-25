import { supabase } from "./api";

export type UserRole = "admin" | "customer";
export interface AdminUser {
  user_id: string;
  email: string;
  role: UserRole;
  customer_id: string | null;
  customer_anonymized_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface UserPage {
  items: AdminUser[];
  next_cursor: string | null;
}

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function user(value: unknown, expected?: string): AdminUser {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid user response. Reload before editing.");
  const v = value as Record<string, unknown>;
  if (
    !uuid.test(String(v.user_id)) ||
    (expected && String(v.user_id).toLowerCase() !== expected.toLowerCase()) ||
    typeof v.email !== "string" ||
    !["admin", "customer"].includes(String(v.role)) ||
    !(v.customer_id === null || uuid.test(String(v.customer_id))) ||
    !(
      v.customer_anonymized_at === null ||
      typeof v.customer_anonymized_at === "string"
    ) ||
    typeof v.created_at !== "string" ||
    typeof v.updated_at !== "string"
  )
    throw Error("Invalid user response. Reload before editing.");
  return v as unknown as AdminUser;
}
export function userPage(value: unknown): UserPage {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid users response.");
  const v = value as Record<string, unknown>;
  if (
    !Array.isArray(v.items) ||
    !(v.next_cursor === null || uuid.test(String(v.next_cursor)))
  )
    throw Error("Invalid users response.");
  return {
    items: v.items.map((x) => user(x)),
    next_cursor: v.next_cursor as string | null,
  };
}
export async function getUser(id: string) {
  const { data, error } = await supabase.rpc("get_admin_user", { user_id: id });
  if (error) throw error;
  return data === null ? null : user(data, id);
}
export async function setRole(id: string, role: UserRole) {
  const { data, error } = await supabase.rpc("set_user_role", {
    user_id: id,
    role,
  });
  if (error) throw error;
  const v = data as Record<string, unknown>;
  if (
    !v ||
    String(v.id).toLowerCase() !== id.toLowerCase() ||
    v.role !== role ||
    typeof v.email !== "string" ||
    typeof v.updated_at !== "string"
  )
    throw Error("Invalid role-change receipt. Reload the user.");
}
export async function anonymizeUser(id: string) {
  const { data, error } = await supabase.rpc("anonymize_user", {
    p_user_id: id,
  });
  if (error) throw error;
  const raw = data as { id?: string };
  if (!raw || raw.id?.toLowerCase() !== id.toLowerCase())
    throw Error("Invalid anonymization receipt. Reload the user.");
}
