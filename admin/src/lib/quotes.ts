import type {
  adminCheckoutQuote,
  adminCheckoutQuotePage,
} from "../../../mcp/src/schemas";
export type CheckoutQuote = typeof adminCheckoutQuote._output;
export type CheckoutQuotePage = typeof adminCheckoutQuotePage._output;
export const quoteStatuses = [
  "open",
  "converted",
  "completed",
  "cancelled",
  "expired",
] as const;
export function quoteFilters(query: string) {
  const params = new URLSearchParams(query);
  const customer = (params.get("customer") ?? "").trim();
  const status = params.get("status") ?? "";
  const linked = params.get("linked") ?? "";
  if (
    customer &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      customer,
    )
  )
    throw Error("Enter a valid customer UUID.");
  if (status && !quoteStatuses.some((s) => s === status))
    throw Error("Invalid quote status filter.");
  if (linked && !["yes", "no"].includes(linked))
    throw Error("Invalid linked-order filter.");
  return {
    ...(customer ? { customer_id_filter: customer } : {}),
    ...(status ? { status_filter: status } : {}),
    ...(linked ? { has_order: linked === "yes" } : {}),
  };
}
