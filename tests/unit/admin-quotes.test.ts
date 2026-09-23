import { expect, test } from "bun:test";
import {
  quoteFilters,
  isCancelQuoteCommand,
  cancellationOutcome,
  type CheckoutQuote,
} from "../../admin/src/lib/quotes";
test("quote URL filters preserve false, exact customer and effective status", () => {
  const id = crypto.randomUUID();
  expect(quoteFilters(`?customer=${id}&status=expired&linked=no`)).toEqual({
    customer_id_filter: id,
    status_filter: "expired",
    has_order: false,
  });
  expect(quoteFilters("?linked=yes")).toEqual({ has_order: true });
  expect(quoteFilters("")).toEqual({});
  for (const query of ["?customer=not-a-uuid", "?status=paid", "?linked=false"])
    expect(() => quoteFilters(query)).toThrow();
});
test("cancellation recovery uses stored terminal state, never effective expiry", () => {
  for (const stored_status of ["open", "converted"])
    expect(
      cancellationOutcome({
        status: "expired",
        stored_status,
      } as CheckoutQuote),
    ).toBeNull();
  for (const stored_status of ["expired", "completed", "cancelled"])
    expect(
      cancellationOutcome({
        status: stored_status,
        stored_status,
      } as CheckoutQuote),
    ).not.toBeNull();
  const command = {
    quote_id: crypto.randomUUID(),
    reason: "Customer requested cancellation",
  };
  expect(isCancelQuoteCommand(command)).toBe(true);
  for (const invalid of [
    { ...command, reason: " " },
    { ...command, reason: "x".repeat(501) },
    { ...command, quote_id: "invalid" },
    { ...command, extra: true },
  ])
    expect(isCancelQuoteCommand(invalid)).toBe(false);
});
