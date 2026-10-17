import { expect, test } from "bun:test";
import { shippingMoney } from "../../admin/src/lib/shipping";
import {
  ledgerRemaining,
  manualRefundBlock,
  refundScope,
  isRefundPreview,
  previewMatchesScope,
  isRefundOperation,
  acknowledgesPreviewedRefund,
  type PreviewedRefund,
  refundItemLabel,
  refundComponentLabel,
  refundAllocatedTotal,
  type RefundPricing,
  type OrderLedger,
} from "../../admin/src/lib/refunds";
const id = crypto.randomUUID();
test("refund scope never silently combines amount mode with stale item or shipping inputs", () => {
  const item = crypto.randomUUID();
  expect(refundScope(id, "amount", "7.25", { [item]: "2" }, "4", true)).toEqual(
    { order_id: id, amount: 7.25, restock: false },
  );
  expect(refundScope(id, "items", "99", { [item]: "2" }, "", true)).toEqual({
    order_id: id,
    items: [{ order_item_id: item, quantity: 2 }],
    restock: true,
  });
  expect(refundScope(id, "items", "", {}, "1.25", false)).toEqual({
    order_id: id,
    shipping_amount: 1.25,
    restock: false,
  });
  for (const q of ["1.2", "-1", "1e2", "2147483648"])
    expect(() =>
      refundScope(id, "items", "", { [item]: q }, "", false),
    ).toThrow();
  expect(() => refundScope(id, "items", "", {}, "", false)).toThrow();
  expect(() => refundScope(id, "items", "", {}, "2", true)).toThrow();
});
test("returned shipped units ride on their refund line and never exceed it", () => {
  const item = crypto.randomUUID(),
    other = crypto.randomUUID();
  expect(
    refundScope(id, "items", "", { [item]: "2" }, "", false, { [item]: "2" }),
  ).toEqual({
    order_id: id,
    items: [{ order_item_id: item, quantity: 2, restock_shipped_quantity: 2 }],
    restock: false,
  });
  expect(
    refundScope(id, "items", "", { [item]: "2" }, "", false, { [item]: "0" }),
  ).toEqual({
    order_id: id,
    items: [{ order_item_id: item, quantity: 2 }],
    restock: false,
  });
  for (const returned of [{ [item]: "3" }, { [item]: "-1" }, { [item]: "1.5" }, { [other]: "1" }])
    expect(() =>
      refundScope(id, "items", "", { [item]: "2" }, "", false, returned),
    ).toThrow();
});
test("journal binds exact scope, preview and receipt including tax allocation and stock effects", () => {
  const item = crypto.randomUUID(),
    tax = crypto.randomUUID();
  const scope = {
    order_id: id,
    items: [{ order_item_id: item, quantity: 2 }],
    restock: true,
  };
  const preview = {
    order_id: id,
    currency: "USD" as const,
    available_amount: 30,
    amount: 11.3,
    source: "items" as const,
    restock: true,
    preview_token: "a".repeat(64),
    lines: [
      {
        order_item_id: item,
        quantity: 2,
        amount: 10,
        cancelled_quantity: 1,
        restocked_quantity: 1,
        restock_shipped_quantity: 0,
      },
    ],
    components: [
      {
        kind: "tax" as const,
        tax_line_id: tax,
        shipping_line_id: null,
        amount: 1.3,
      },
    ],
  };
  const operation: PreviewedRefund = {
    request: {
      ...scope,
      preview_token: preview.preview_token,
      idempotency_key: crypto.randomUUID(),
      reason: "Offline reference",
    },
    preview,
  };
  expect(isRefundPreview(preview)).toBe(true);
  expect(isRefundPreview({ ...preview, amount: 10 })).toBe(false);
  expect(
    previewMatchesScope(preview, {
      ...scope,
      items: [{ order_item_id: item, quantity: 1 }],
    }),
  ).toBe(false);
  expect(
    previewMatchesScope(preview, {
      ...scope,
      items: [{ order_item_id: item, quantity: 2, restock_shipped_quantity: 1 }],
    }),
  ).toBe(false);
  expect(isRefundOperation(operation)).toBe(true);
  for (const change of [
    { provider: "paypal" },
    { amount: 11.3 },
    { items: undefined },
    { preview_token: "b".repeat(64) },
    { items: [...scope.items, ...scope.items] },
  ])
    expect(
      isRefundOperation({
        ...operation,
        request: { ...operation.request, ...change },
      }),
    ).toBe(false);
  const receipt = {
    order_id: id,
    preview_token: preview.preview_token,
    refund: {
      ...preview,
      id: crypto.randomUUID(),
      status: "succeeded",
      reason: operation.request.reason,
      restock_requested: true,
    },
  };
  expect(acknowledgesPreviewedRefund(receipt, operation)).toBe(true);
  expect(
    acknowledgesPreviewedRefund(
      {
        ...receipt,
        refund: {
          ...receipt.refund,
          lines: [{ ...preview.lines[0], restocked_quantity: 0 }],
        },
      },
      operation,
    ),
  ).toBe(false);
  expect(
    acknowledgesPreviewedRefund(
      {
        ...receipt,
        refund: {
          ...receipt.refund,
          lines: [{ ...preview.lines[0], restock_shipped_quantity: 1 }],
        },
      },
      operation,
    ),
  ).toBe(false);
  expect(
    acknowledgesPreviewedRefund(
      {
        ...receipt,
        refund: {
          ...receipt.refund,
          components: [
            { ...preview.components[0], tax_line_id: crypto.randomUUID() },
          ],
        },
      },
      operation,
    ),
  ).toBe(false);
  expect(
    acknowledgesPreviewedRefund(
      { ...receipt, preview_token: "b".repeat(64) },
      operation,
    ),
  ).toBe(false);
});
test("refund labels resolve historical source IDs, not array positions or current products", () => {
  const pricing = {
    lines: [
      {
        id: "other",
        name: "Other",
        tax_lines: [{ id: "tax-other", name: "VAT" }],
      },
      {
        id: "item",
        name: "Historical shirt",
        variant_title: "Blue",
        sku: "OLD-SKU",
        tax_lines: [{ id: "tax-item", name: "VAT" }],
      },
    ],
    shipping_line: {
      id: "shipping",
      name: "Ground",
      tax_lines: [{ id: "tax-shipping", name: "VAT" }],
    },
  } as unknown as RefundPricing;
  const label = (
    kind: "tax" | "shipping" | "unallocated",
    tax_line_id: string | null,
    shipping_line_id: string | null = null,
  ) =>
    refundComponentLabel(pricing, {
      kind,
      tax_line_id,
      shipping_line_id,
      amount: 0.2,
    });
  expect(refundItemLabel(pricing, "item")).toBe(
    "Historical shirt · Blue · OLD-SKU",
  );
  expect(refundItemLabel(null, "item")).toBe("Item item");
  expect(label("tax", "tax-item")).toBe(
    "Item tax · VAT · Historical shirt · Blue · OLD-SKU",
  );
  expect(label("tax", "tax-shipping")).toBe("Shipping tax · VAT · Ground");
  expect(label("shipping", null, "shipping")).toBe("Shipping · Ground");
  expect(label("shipping", null, "missing")).toBe("Shipping · missing");
  expect(label("tax", "missing")).toBe("Tax · missing");
  expect(label("unallocated", null)).toBe("Unallocated amount");
});
test("refund allocation sums net lines and each component once using integer cents", () => {
  const refund = {
    amount: 99,
    lines: [{ amount: 0.1 }, { amount: 1.17 }],
    components: [
      { kind: "tax", amount: 0.2 },
      { kind: "shipping", amount: 2.03 },
    ],
  } as OrderLedger["refunds"][number];
  expect(refundAllocatedTotal(refund)).toBe(3.5);
  expect(refundAllocatedTotal({ ...refund, lines: [], components: [] })).toBe(
    0,
  );
});
const ledger = () =>
  ({
    order: {
      id,
      total: 0.3,
      currency: "USD",
      financial_status: "partially_refunded",
    },
    balances: { captured: 0.4, refunded: 0.2, is_balanced: true },
    transactions: [
      { provider: "manual", kind: "capture", status: "succeeded" },
    ],
    payment_intents: [],
  }) as unknown as OrderLedger;
test("remaining balance uses captured cap, order cap and integer cents", () => {
  expect(ledgerRemaining(ledger())).toBe(0.1);
  const l = ledger();
  l.balances.captured = 0.25;
  expect(ledgerRemaining(l)).toBe(0.05);
  l.balances.refunded = 0.3;
  expect(ledgerRemaining(l)).toBe(0);
});
test("manual-only gate rejects provider history, pending requests and unreconciled ledgers", () => {
  expect(manualRefundBlock(ledger(), false)).toBe("");
  expect(manualRefundBlock(ledger(), true)).not.toBe("");
  const online = ledger();
  online.transactions[0].provider = "paypal";
  expect(manualRefundBlock(online, false)).not.toBe("");
  const mixed = ledger();
  mixed.payment_intents = [{ id }] as OrderLedger["payment_intents"];
  expect(manualRefundBlock(mixed, false)).not.toBe("");
  const unbalanced = ledger();
  unbalanced.balances.is_balanced = false;
  expect(manualRefundBlock(unbalanced, false)).not.toBe("");
  const unpaid = ledger();
  unpaid.transactions = [];
  expect(manualRefundBlock(unpaid, false)).not.toBe("");
});
test("refund amounts reject non-decimal or overprecision input", () => {
  for (const text of ["1e2", "1.001", "-1", ""])
    expect(() => shippingMoney(text)).toThrow();
});
