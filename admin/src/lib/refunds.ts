import type { orderLedger, orderPricing } from "../../../mcp/src/schemas";
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
export interface ManualRefundCommand {
  order_id: string;
  amount: number;
  reason: string;
  provider: "manual";
  restock: false;
  idempotency_key: string;
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export function isManualRefundCommand(v: unknown): v is ManualRefundCommand {
  return (
    object(v) &&
    Object.keys(v).every((k) =>
      [
        "order_id",
        "amount",
        "reason",
        "provider",
        "restock",
        "idempotency_key",
      ].includes(k),
    ) &&
    uuid(v.order_id) &&
    uuid(v.idempotency_key) &&
    typeof v.amount === "number" &&
    Number.isFinite(v.amount) &&
    v.amount > 0 &&
    v.amount <= 9999999999.99 &&
    Number(v.amount.toFixed(2)) === v.amount &&
    typeof v.reason === "string" &&
    v.reason.trim().length > 0 &&
    v.reason.length <= 2000 &&
    v.provider === "manual" &&
    v.restock === false
  );
}
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
export function acknowledgesManualRefund(
  v: unknown,
  command: ManualRefundCommand,
): boolean {
  // The legacy RPC returns the current order, not a refund DTO. Only a successful RPC can acknowledge this command; never infer success from a balance change.
  return (
    object(v) &&
    v.id === command.order_id &&
    v.currency === "USD" &&
    (v.financial_status === "partially_refunded" ||
      v.financial_status === "refunded")
  );
}
