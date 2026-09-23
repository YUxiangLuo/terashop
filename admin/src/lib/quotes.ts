import type {
  adminCheckoutQuote,
  adminCheckoutQuotePage,
} from "../../../mcp/src/schemas";
export type CheckoutQuote = typeof adminCheckoutQuote._output;
export type CheckoutQuotePage = typeof adminCheckoutQuotePage._output;
export type CancelQuoteCommand = { quote_id: string; reason: string };
export function isCancelQuoteCommand(
  value: unknown,
): value is CancelQuoteCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    Object.keys(row).length === 2 &&
    typeof row.quote_id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      row.quote_id,
    ) &&
    typeof row.reason === "string" &&
    row.reason.trim().length > 0 &&
    Array.from(row.reason).length <= 500
  );
}
// Only stored terminal facts settle a pending request; effective expiry is not enough.
export function cancellationOutcome(quote: CheckoutQuote): string | null {
  if (quote.stored_status === "cancelled")
    return "Cancellation confirmed from current facts. This does not identify who cancelled it; the recorded reason is authoritative.";
  if (quote.stored_status === "expired")
    return "The quote has reached stored expired state. No further cancellation was sent; this is not confirmation of your cancellation request.";
  if (quote.stored_status === "completed")
    return "The quote completed. It cannot be cancelled; use the order refund workflow if needed.";
  return null;
}
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
