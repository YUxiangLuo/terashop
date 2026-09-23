import { supabase } from "./api";
import type { Json } from "../../../types/database";
import { customerReceipt } from "./write-receipts";

export interface CustomerSummary {
  id: string;
  email: string | null;
  full_name: string;
  phone: string | null;
  has_account: boolean;
  anonymized_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CustomerAddress {
  id: string;
  label: string;
  recipient_name: string;
  phone: string | null;
  country: string;
  region: string;
  city: string;
  line1: string;
  line2: string | null;
  postal_code: string;
  is_default: boolean;
  updated_at: string;
}

export interface CustomerDetail extends CustomerSummary {
  addresses: CustomerAddress[];
}

export interface CustomerPage {
  items: CustomerSummary[];
  next_cursor: { created_at: string; id: string } | null;
}

export async function getCustomer(id: string): Promise<CustomerDetail | null> {
  const result = await supabase.rpc("get_admin_customer", { customer_id: id });
  if (result.error) throw result.error;
  return result.data === null
    ? null
    : (customerReceipt(result.data, id, null) as unknown as CustomerDetail);
}

export async function updateCustomer(
  customer: CustomerDetail,
  changes: { email: string | null; full_name: string; phone: string | null },
): Promise<CustomerDetail> {
  const result = await supabase.rpc("update_customer", {
    customer_id: customer.id,
    expected_updated_at: customer.updated_at,
    changes,
  });
  if (result.error) throw result.error;
  return customerReceipt(
    result.data,
    customer.id,
    customer.updated_at,
  ) as unknown as CustomerDetail;
}

export async function listCustomers(args: {
  search?: string;
  anonymized?: boolean;
  after_cursor?: CustomerPage["next_cursor"];
}): Promise<CustomerPage> {
  const result = await supabase.rpc("list_admin_customers", {
    page_size: 20,
    ...args,
    ...(args.after_cursor ? { after_cursor: args.after_cursor as Json } : {}),
  });
  if (result.error) throw result.error;
  return result.data as unknown as CustomerPage;
}
