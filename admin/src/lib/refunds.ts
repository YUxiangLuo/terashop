import type { orderLedger, orderPricing } from "../../../mcp/src/schemas";
import { shippingMoney } from "./shipping";
export type OrderLedger = typeof orderLedger._output;
export type RefundPricing = typeof orderPricing._output;
export function refundItemLabel(
  pricing: RefundPricing | null,
  id: string,
): string {
  const line = pricing?.lines.find((line) => line.id === id);
  return line
    ? [line.name, line.variant_title, line.sku].filter(Boolean).join(" · ")
    : `Item ${id}`;
}
export function refundComponentLabel(
  pricing: RefundPricing | null,
  component: OrderLedger["refunds"][number]["components"][number],
): string {
  if (component.kind === "unallocated") return "Unallocated amount";
  const shipping = pricing?.shipping_line;
  if (component.kind === "shipping")
    return shipping && shipping.id === component.shipping_line_id
      ? `Shipping · ${shipping.name}`
      : `Shipping · ${component.shipping_line_id ?? "Unknown source"}`;
  for (const line of pricing?.lines ?? []) {
    const tax = line.tax_lines.find((tax) => tax.id === component.tax_line_id);
    if (tax)
      return `Item tax · ${tax.name} · ${refundItemLabel(pricing, line.id)}`;
  }
  const tax = shipping?.tax_lines.find(
    (tax) => tax.id === component.tax_line_id,
  );
  return tax
    ? `Shipping tax · ${tax.name} · ${shipping!.name}`
    : `Tax · ${component.tax_line_id ?? "Unknown source"}`;
}
export function refundAllocatedTotal(
  refund: OrderLedger["refunds"][number],
): number {
  return (
    [...refund.lines, ...refund.components].reduce(
      (cents, part) => cents + Math.round(part.amount * 100),
      0,
    ) / 100
  );
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
// This is a succeeded-only ledger balance, not a quote or a reservation-aware refund allowance.
export function ledgerRemaining(ledger: OrderLedger): number {
  return (
    Math.max(
      0,
      Math.min(
        Math.round(ledger.order.total * 100),
        Math.round(ledger.balances.captured * 100),
      ) - Math.round(ledger.balances.refunded * 100),
    ) / 100
  );
}
export function manualRefundBlock(
  ledger: OrderLedger,
  hasProviderRequests: boolean,
): string {
  if (ledger.order.currency !== "USD" || !ledger.balances.is_balanced)
    return "Ledger currency or balance must be reconciled before manual bookkeeping.";
  if (
    hasProviderRequests ||
    ledger.payment_intents.length ||
    ledger.transactions.some((t) => t.provider !== "manual")
  )
    return "Online or mixed payment history detected. Use the provider refund workflow; manual bookkeeping does not return provider funds.";
  if (
    !ledger.transactions.some(
      (t) =>
        t.kind === "capture" &&
        t.status === "succeeded" &&
        t.provider === "manual",
    )
  )
    return "No successful manual capture found.";
  if (
    !["paid", "partially_refunded"].includes(ledger.order.financial_status) ||
    ledgerRemaining(ledger) <= 0
  )
    return "No refundable manual balance in the loaded ledger.";
  return "";
}
export interface RefundScope {
  order_id: string;
  amount?: number;
  items?: { order_item_id: string; quantity: number }[];
  shipping_amount?: number;
  restock: boolean;
}
export interface RefundPreview {
  order_id: string;
  currency: "USD";
  available_amount: number;
  source: "items" | "shipping" | "custom_amount";
  amount: number;
  restock: boolean;
  lines: OrderLedger["refunds"][number]["lines"];
  components: OrderLedger["refunds"][number]["components"];
  preview_token: string;
}
export interface PreviewedRefund {
  request: RefundScope & {
    preview_token: string;
    idempotency_key: string;
    reason: string;
  };
  preview: RefundPreview;
}
const cents = (v: unknown): v is number =>
  typeof v === "number" &&
  Number.isFinite(v) &&
  v >= 0 &&
  v <= 9999999999.99 &&
  Number(v.toFixed(2)) === v;
const quantity = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 2147483647;
const token = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
export function refundScope(
  order_id: string,
  mode: "amount" | "items",
  amount: string,
  quantities: Record<string, string>,
  shipping: string,
  restock: boolean,
): RefundScope {
  if (mode === "amount") {
    const value = shippingMoney(amount);
    if (value <= 0) throw Error("Enter a positive refund amount.");
    return { order_id, amount: value, restock: false };
  }
  const items = Object.entries(quantities)
    .filter(([, v]) => v !== "" && v !== "0")
    .map(([order_item_id, v]) => {
      if (!/^[1-9]\d*$/.test(v) || !quantity(Number(v)))
        throw Error("Refund quantities must be positive whole numbers.");
      return { order_item_id, quantity: Number(v) };
    })
    .sort((a, b) => a.order_item_id.localeCompare(b.order_item_id));
  if (items.length > 100) throw Error("Select at most 100 item lines.");
  const shipping_amount = shipping.trim() ? shippingMoney(shipping) : undefined;
  if (shipping_amount === 0)
    throw Error("Enter positive net shipping or leave it blank.");
  if (!items.length && shipping_amount === undefined)
    throw Error("Select items or enter net shipping to refund.");
  if (restock && !items.length)
    throw Error("Stock release requires item lines.");
  return {
    order_id,
    ...(items.length ? { items } : {}),
    ...(shipping_amount !== undefined ? { shipping_amount } : {}),
    restock,
  };
}
export function isRefundPreview(v: unknown): v is RefundPreview {
  if (
    !object(v) ||
    !uuid(v.order_id) ||
    v.currency !== "USD" ||
    !cents(v.amount) ||
    v.amount <= 0 ||
    !cents(v.available_amount) ||
    v.amount > v.available_amount ||
    !token(v.preview_token) ||
    typeof v.restock !== "boolean" ||
    !["items", "shipping", "custom_amount"].includes(String(v.source)) ||
    !Array.isArray(v.lines) ||
    !Array.isArray(v.components)
  )
    return false;
  if (
    !v.lines.every(
      (l) =>
        object(l) &&
        uuid(l.order_item_id) &&
        quantity(l.quantity) &&
        l.quantity > 0 &&
        cents(l.amount) &&
        quantity(l.cancelled_quantity) &&
        l.cancelled_quantity <= l.quantity &&
        quantity(l.restocked_quantity) &&
        l.restocked_quantity <= l.cancelled_quantity,
    )
  )
    return false;
  if (
    !v.components.every(
      (c) =>
        object(c) &&
        ["tax", "shipping", "unallocated"].includes(String(c.kind)) &&
        cents(c.amount) &&
        (c.tax_line_id === null || uuid(c.tax_line_id)) &&
        (c.shipping_line_id === null || uuid(c.shipping_line_id)),
    )
  )
    return false;
  return (
    refundAllocatedTotal(v as unknown as OrderLedger["refunds"][number]) ===
    v.amount
  );
}
export function previewMatchesScope(
  preview: RefundPreview,
  scope: RefundScope,
): boolean {
  const selected = scope.items ?? [];
  return (
    preview.order_id === scope.order_id &&
    preview.restock === scope.restock &&
    preview.source ===
      (scope.amount !== undefined
        ? "custom_amount"
        : selected.length
          ? "items"
          : "shipping") &&
    (scope.amount === undefined || preview.amount === scope.amount) &&
    preview.lines.length === selected.length &&
    selected.every((item) =>
      preview.lines.some(
        (line) =>
          line.order_item_id === item.order_item_id &&
          line.quantity === item.quantity,
      ),
    ) &&
    preview.components
      .filter((c) => c.kind === "shipping")
      .reduce((n, c) => n + Math.round(c.amount * 100), 0) ===
      Math.round((scope.shipping_amount ?? 0) * 100)
  );
}
export function isRefundOperation(v: unknown): v is PreviewedRefund {
  if (
    !object(v) ||
    Object.keys(v).some((k) => !["request", "preview"].includes(k)) ||
    !object(v.request) ||
    !isRefundPreview(v.preview)
  )
    return false;
  const r = v.request;
  if (
    Object.keys(r).some(
      (k) =>
        ![
          "order_id",
          "amount",
          "items",
          "shipping_amount",
          "restock",
          "preview_token",
          "idempotency_key",
          "reason",
        ].includes(k),
    ) ||
    !uuid(r.order_id) ||
    !uuid(r.idempotency_key) ||
    r.preview_token !== v.preview.preview_token ||
    typeof r.reason !== "string" ||
    !r.reason.trim() ||
    r.reason.length > 2000 ||
    typeof r.restock !== "boolean"
  )
    return false;
  if (
    r.amount !== undefined &&
    (!cents(r.amount) ||
      r.amount <= 0 ||
      r.items !== undefined ||
      r.shipping_amount !== undefined ||
      r.restock)
  )
    return false;
  if (
    r.shipping_amount !== undefined &&
    (!cents(r.shipping_amount) || r.shipping_amount <= 0)
  )
    return false;
  if (
    r.items !== undefined &&
    (!Array.isArray(r.items) ||
      !r.items.length ||
      r.items.length > 100 ||
      !r.items.every(
        (i) =>
          object(i) &&
          Object.keys(i).every((k) =>
            ["order_item_id", "quantity"].includes(k),
          ) &&
          uuid(i.order_item_id) &&
          quantity(i.quantity) &&
          i.quantity > 0,
      ) ||
      new Set(r.items.map((i) => i.order_item_id)).size !== r.items.length)
  )
    return false;
  if (
    (r.amount === undefined &&
      r.items === undefined &&
      r.shipping_amount === undefined) ||
    (r.restock && r.items === undefined)
  )
    return false;
  return previewMatchesScope(v.preview, r as unknown as RefundScope);
}
export function acknowledgesPreviewedRefund(
  v: unknown,
  operation: PreviewedRefund,
): boolean {
  if (
    !object(v) ||
    v.order_id !== operation.request.order_id ||
    v.preview_token !== operation.request.preview_token ||
    !object(v.refund)
  )
    return false;
  const r = v.refund,
    p = operation.preview;
  // The immutable refund DTO must match what the administrator confirmed, not today's order balance.
  if (
    !uuid(r.id) ||
    r.status !== "succeeded" ||
    r.currency !== "USD" ||
    r.reason !== operation.request.reason ||
    r.restock_requested !== p.restock ||
    r.source !== p.source ||
    r.amount !== p.amount ||
    !Array.isArray(r.lines) ||
    !Array.isArray(r.components)
  )
    return false;
  const rowsMatch = (actual: unknown[], expected: object[], keys: string[]) =>
    actual.length === expected.length &&
    actual.every(
      (a, i) =>
        object(a) &&
        keys.every((k) => a[k] === (expected[i] as Record<string, unknown>)[k]),
    );
  return (
    rowsMatch(r.lines, p.lines, [
      "order_item_id",
      "quantity",
      "amount",
      "cancelled_quantity",
      "restocked_quantity",
    ]) &&
    rowsMatch(r.components, p.components, [
      "kind",
      "tax_line_id",
      "shipping_line_id",
      "amount",
    ])
  );
}
