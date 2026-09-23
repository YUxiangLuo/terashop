import { expect, test } from "bun:test";
import { quoteFilters } from "../../admin/src/lib/quotes";
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
