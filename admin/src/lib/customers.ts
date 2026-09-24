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
  region: string | null;
  city: string | null;
  line1: string;
  line2: string | null;
  postal_code: string | null;
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

export type CustomerAddressChanges = {
  label?: string;
  recipient_name?: string;
  phone?: string | null;
  country?: string;
  region?: string | null;
  city?: string | null;
  line1?: string;
  line2?: string | null;
  postal_code?: string | null;
};

function detail(value: unknown, id: string, expected: string | null) {
  return customerReceipt(value, id, expected) as unknown as CustomerDetail;
}

export async function getCustomer(id: string): Promise<CustomerDetail | null> {
  const result = await supabase.rpc("get_admin_customer", { customer_id: id });
  if (result.error) throw result.error;
  return result.data === null ? null : detail(result.data, id, null);
}

export async function createCustomer(
  idempotencyKey: string,
  fields: { email?: string; full_name?: string; phone?: string },
): Promise<CustomerDetail> {
  const result = await supabase.rpc("create_customer", {
    idempotency_key: idempotencyKey,
    ...fields,
  });
  if (result.error) throw result.error;
  const id = (result.data as { id?: unknown } | null)?.id;
  if (typeof id !== "string")
    throw Error(
      "Invalid customer response. Retry the same request before creating another customer.",
    );
  const created = await getCustomer(id);
  if (!created)
    throw Error("Created customer could not be read. Retry the same request.");
  return created;
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
  return detail(result.data, customer.id, customer.updated_at);
}

export async function createCustomerAddress(
  customerId: string,
  addressId: string,
  changes: CustomerAddressChanges & {
    recipient_name: string;
    country: string;
    line1: string;
  },
) {
  const result = await supabase.rpc("create_customer_address", {
    customer_id: customerId,
    address_id: addressId,
    changes,
  });
  if (result.error) throw result.error;
  return detail(result.data, customerId, null);
}

export async function updateCustomerAddress(
  customerId: string,
  address: CustomerAddress,
  changes: CustomerAddressChanges,
) {
  const result = await supabase.rpc("update_customer_address", {
    customer_id: customerId,
    address_id: address.id,
    expected_updated_at: address.updated_at,
    changes,
  });
  if (result.error) throw result.error;
  return detail(result.data, customerId, null);
}

export async function deleteCustomerAddress(
  customerId: string,
  address: CustomerAddress,
) {
  const result = await supabase.rpc("delete_customer_address", {
    customer_id: customerId,
    address_id: address.id,
    expected_updated_at: address.updated_at,
  });
  if (result.error) throw result.error;
  return detail(result.data, customerId, null);
}

export async function setDefaultCustomerAddress(
  customerId: string,
  addressId: string,
  makeDefault = true,
) {
  const result = await supabase.rpc("set_default_address", {
    address_id: addressId,
    make_default: makeDefault,
  });
  if (result.error) throw result.error;
  const refreshed = await getCustomer(customerId);
  if (
    !refreshed ||
    !refreshed.addresses.some(
      (address) =>
        address.id === addressId && address.is_default === makeDefault,
    )
  )
    throw Error(
      "Default address result could not be verified. Reload the customer.",
    );
  return refreshed;
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
