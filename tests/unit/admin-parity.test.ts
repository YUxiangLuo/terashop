import { expect, test } from "bun:test";
import { reportRange } from "../../admin/src/lib/reporting";
import {
  receipt,
  deletionReceipt,
  jsonObject,
  jsonValue,
} from "../../admin/src/lib/metadata";
import {
  validateVariants,
  type ProductVariant,
} from "../../admin/src/lib/catalog";

test("report ranges require explicit offsets, increasing instants and a bounded duration", () => {
  const start = "2026-01-01T08:00:00+08:00";
  expect(reportRange(start, "2026-02-01T00:00:00Z")).toEqual({
    start_at: start,
    end_at: "2026-02-01T00:00:00Z",
  });
  for (const end of [
    "2026-01-01T00:00:00Z",
    "2025-12-31T23:59:59Z",
    "2026-02-01T00:00:00.001Z",
    "2026-01-02T00:00:00",
    "invalid",
  ]) {
    expect(() => reportRange(start, end)).toThrow();
  }
});

test("metadata receipts bind identity and revision; deletion must be acknowledged", () => {
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  expect(receipt({ id, revision: 8 }, id.toUpperCase(), 7)).toEqual({
    id,
    revision: 8,
  });
  expect(() => receipt({ id, revision: 6 }, id, 7)).toThrow();
  expect(() =>
    receipt({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", revision: 8 }, id, 7),
  ).toThrow();
  expect(() => deletionReceipt({ id, deleted: false }, id)).toThrow();
  expect(() =>
    deletionReceipt(
      { id, deleted: true },
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ),
  ).toThrow();
  expect(() => deletionReceipt({ id, deleted: true }, id)).not.toThrow();
  expect(jsonValue('"<script>plain text</script>"')).toBe(
    "<script>plain text</script>",
  );
  expect(() => jsonObject("[]", "Schema")).toThrow();
  expect(() => jsonObject("null", "Schema")).toThrow();
});

test("variant ordering accepts signed int4 boundaries, rejects fractional and overflowing positions", () => {
  const variant: ProductVariant = {
    id: "variant",
    sku: null,
    barcode: null,
    price: 1,
    compare_at_price: null,
    cost: null,
    is_active: true,
    track_inventory: true,
    option_value_ids: [],
  };
  for (const position of [-2147483648, -7, 0, 2147483647]) {
    expect(() =>
      validateVariants([], [{ ...variant, position }], true),
    ).not.toThrow();
  }
  for (const position of [-2147483649, 2147483648, 1.5, NaN, Infinity]) {
    expect(() =>
      validateVariants([], [{ ...variant, position }], true),
    ).toThrow("32-bit");
  }
});
