import type {
  orderLedger,
  orderPricing,
  fulfillmentBalance,
} from "../../../mcp/src/schemas";
import { paypalRefund } from "../../../mcp/src/schemas";

export type OrderActionsLedger = typeof orderLedger._output;
export type OrderActionsPricing = typeof orderPricing._output;
export type ActionKind =
  "cancel-order" | "cancel-line" | "mark-paid" | "paypal-refund";
export interface SavedOrderAction {
  kind: ActionKind;
  arguments: Record<string, unknown>;
}

const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

export function actionStorageKey(userId: string, orderId: string) {
  return `tera-admin-order-actions:${userId}:${orderId}`;
}

export function readOrderAction(
  storage: Storage,
  key: string,
): SavedOrderAction | null {
  const raw = storage.getItem(key);
  if (!raw) return null;
  const value: unknown = JSON.parse(raw);
  if (
    !object(value) ||
    !["cancel-order", "cancel-line", "mark-paid", "paypal-refund"].includes(
      String(value.kind),
    ) ||
    !object(value.arguments) ||
    value.arguments.order_id === undefined ||
    !uuid(value.arguments.order_id)
  )
    throw Error(
      "The retained order action cannot be verified. Do not submit another write until the order and payment ledger have been reconciled.",
    );
  const args = value.arguments;
  const allowed =
    value.kind === "cancel-order"
      ? ["order_id", "reason"]
      : value.kind === "cancel-line"
        ? ["order_id", "order_item_id", "quantity", "idempotency_key", "reason"]
        : value.kind === "mark-paid"
          ? ["order_id", "idempotency_key", "provider", "provider_ref"]
          : [
              "order_id",
              "idempotency_key",
              "amount",
              "items",
              "shipping_amount",
              "reason",
              "restock",
            ];
  if (
    Object.keys(args).some((k) => !allowed.includes(k)) ||
    (value.kind !== "cancel-order" && !uuid(args.idempotency_key)) ||
    (args.reason !== undefined && typeof args.reason !== "string") ||
    (value.kind === "cancel-line" &&
      (!uuid(args.order_item_id) ||
        !Number.isInteger(args.quantity) ||
        Number(args.quantity) <= 0)) ||
    (value.kind === "mark-paid" &&
      [args.provider, args.provider_ref].some(
        (v) => v !== undefined && typeof v !== "string",
      )) ||
    (value.kind === "paypal-refund" && !paypalRefund.safeParse(args).success)
  )
    throw Error(
      "Invalid retained action arguments. Reconcile the original order before proceeding.",
    );
  return value as unknown as SavedOrderAction;
}

export function saveOrderAction(
  storage: Storage,
  key: string,
  action: SavedOrderAction,
) {
  const serialized = JSON.stringify(action);
  const existing = storage.getItem(key);
  if (existing && existing !== serialized)
    throw Error(
      "Resolve the retained order action before submitting different arguments.",
    );
  storage.setItem(key, serialized);
}

export function paypalAmount(value: string): string {
  const normalized = value.trim();
  if (
    !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(normalized) ||
    Number(normalized) <= 0
  )
    throw Error("Enter a positive USD amount with at most two decimal places.");
  return normalized;
}

export function lineAvailable(
  balance: typeof fulfillmentBalance._output,
  itemId: string,
) {
  return (
    balance.lines.find((line) => line.order_item_id === itemId)
      ?.available_quantity ?? 0
  );
}
