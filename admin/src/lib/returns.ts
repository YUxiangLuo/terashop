import type { orderReturns } from "../../../mcp/src/schemas";

export type OrderReturns = typeof orderReturns._output;
export type ReturnAuthorization = OrderReturns["returns"][number];
export type ReturnReceipt = ReturnAuthorization["receipts"][number];
export type ReceiptLine = ReturnReceipt["lines"][number];
export interface DisposeCommand {
  receipt_line_id: string;
  quantity: number;
  disposition: "restock" | "discard";
  note: string;
  idempotency_key: string;
}
export function isDisposeCommand(v: unknown): v is DisposeCommand {
  return (
    object(v) &&
    Object.keys(v).every((k) =>
      [
        "receipt_line_id",
        "quantity",
        "disposition",
        "note",
        "idempotency_key",
      ].includes(k),
    ) &&
    uuid(v.receipt_line_id) &&
    uuid(v.idempotency_key) &&
    Number.isInteger(v.quantity) &&
    Number(v.quantity) > 0 &&
    Number(v.quantity) <= 2147483647 &&
    (v.disposition === "restock" || v.disposition === "discard") &&
    typeof v.note === "string" &&
    [...v.note].length <= 2000
  );
}
export function dispositionQuantity(
  quantity: number | undefined,
  undisposed: number,
): number {
  if (
    quantity === undefined ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > undisposed
  )
    throw Error(
      "Choose a whole quantity within the undisposed receipt quantity.",
    );
  return quantity;
}
export function acknowledgesDisposition(
  v: unknown,
  command: DisposeCommand,
): boolean {
  if (
    !object(v) ||
    !uuid(v.id) ||
    v.receipt_line_id !== command.receipt_line_id ||
    v.quantity !== command.quantity ||
    v.disposition !== command.disposition ||
    v.note !== command.note
  )
    return false;
  // Never coerce bigint IDs through Number; discard must not claim a stock movement.
  return command.disposition === "discard"
    ? v.inventory_movement_id === null
    : typeof v.inventory_movement_id === "string" &&
        /^[1-9][0-9]{0,18}$/.test(v.inventory_movement_id) &&
        BigInt(v.inventory_movement_id) <= 9223372036854775807n;
}
export interface ReceiveCommand {
  return_id: string;
  location_id: string;
  items: { return_line_id: string; quantity: number }[];
  note: string;
  idempotency_key: string;
}
export function isReceiveCommand(v: unknown): v is ReceiveCommand {
  return (
    object(v) &&
    Object.keys(v).every((k) =>
      ["return_id", "location_id", "items", "note", "idempotency_key"].includes(
        k,
      ),
    ) &&
    uuid(v.return_id) &&
    uuid(v.location_id) &&
    uuid(v.idempotency_key) &&
    typeof v.note === "string" &&
    [...v.note].length <= 2000 &&
    Array.isArray(v.items) &&
    v.items.length > 0 &&
    v.items.length <= 100 &&
    v.items.every(
      (i) =>
        object(i) &&
        Object.keys(i).every((k) =>
          ["return_line_id", "quantity"].includes(k),
        ) &&
        uuid(i.return_line_id) &&
        Number.isInteger(i.quantity) &&
        Number(i.quantity) > 0 &&
        Number(i.quantity) <= 2147483647,
    ) &&
    new Set(v.items.map((i) => i.return_line_id.toLowerCase())).size ===
      v.items.length
  );
}
export function receiveItems(
  authorization: ReturnAuthorization,
  quantities: Record<string, number | undefined>,
): ReceiveCommand["items"] {
  if (authorization.status !== "open")
    throw Error("Only open returns can receive new items.");
  const items: ReceiveCommand["items"] = [];
  for (const [return_line_id, quantity] of Object.entries(quantities)) {
    if (quantity === undefined || quantity === 0) continue;
    const line = authorization.lines.find((l) => l.id === return_line_id);
    if (
      !line ||
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > line.receivable_quantity
    )
      throw Error(
        "Receipt quantities must be whole numbers within the remaining receivable quantity.",
      );
    items.push({ return_line_id, quantity });
  }
  if (!items.length || items.length > 100)
    throw Error("Select between 1 and 100 receipt lines.");
  return items;
}
export function acknowledgesReceipt(
  v: unknown,
  command: ReceiveCommand,
  orderId: string,
): boolean {
  if (
    !object(v) ||
    !uuid(v.id) ||
    v.order_id !== orderId ||
    v.return_id !== command.return_id ||
    v.location_id !== command.location_id ||
    v.note !== command.note ||
    !Array.isArray(v.lines) ||
    v.lines.length !== command.items.length
  )
    return false;
  const remaining = new Map(
    command.items.map((i) => [i.return_line_id, i.quantity]),
  );
  for (const line of v.lines) {
    if (
      !object(line) ||
      !uuid(line.id) ||
      typeof line.return_line_id !== "string" ||
      !remaining.has(line.return_line_id) ||
      remaining.get(line.return_line_id) !== line.quantity
    )
      return false;
    remaining.delete(line.return_line_id);
  }
  return remaining.size === 0;
}
export interface ReturnCommand {
  fulfillment_id: string;
  items: { order_item_id: string; quantity: number }[];
  reason: string;
  idempotency_key: string;
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export function isReturnCommand(v: unknown): v is ReturnCommand {
  return (
    object(v) &&
    Object.keys(v).every((k) =>
      ["fulfillment_id", "items", "reason", "idempotency_key"].includes(k),
    ) &&
    uuid(v.fulfillment_id) &&
    uuid(v.idempotency_key) &&
    typeof v.reason === "string" &&
    [...v.reason].length <= 500 &&
    Array.isArray(v.items) &&
    v.items.length > 0 &&
    v.items.length <= 100 &&
    v.items.every(
      (item) =>
        object(item) &&
        Object.keys(item).every((k) =>
          ["order_item_id", "quantity"].includes(k),
        ) &&
        uuid(item.order_item_id) &&
        Number.isInteger(item.quantity) &&
        Number(item.quantity) > 0 &&
        Number(item.quantity) <= 2147483647,
    ) &&
    new Set(v.items.map((item) => item.order_item_id.toLowerCase())).size ===
      v.items.length
  );
}

// Progress can change between dispatch and replay; only authorization facts must match.
export function acknowledgesReturn(
  v: unknown,
  command: ReturnCommand,
  orderId: string,
): boolean {
  if (
    !object(v) ||
    !uuid(v.id) ||
    v.order_id !== orderId ||
    v.fulfillment_id !== command.fulfillment_id ||
    v.reason !== command.reason ||
    !["open", "closed", "cancelled"].includes(String(v.status)) ||
    !Array.isArray(v.lines) ||
    v.lines.length !== command.items.length
  )
    return false;
  const remaining = new Map(
    command.items.map((item) => [item.order_item_id, item.quantity]),
  );
  for (const line of v.lines) {
    if (
      !object(line) ||
      !uuid(line.id) ||
      typeof line.order_item_id !== "string" ||
      !remaining.has(line.order_item_id) ||
      remaining.get(line.order_item_id) !== line.quantity
    )
      return false;
    remaining.delete(line.order_item_id);
  }
  return remaining.size === 0;
}

export function returnItems(
  lines: OrderReturns["lines"],
  fulfillmentId: string,
  quantities: Record<string, number | undefined>,
) {
  const items: ReturnCommand["items"] = [];
  for (const [order_item_id, quantity] of Object.entries(quantities)) {
    if (quantity === undefined || quantity === 0) continue;
    const line = lines.find(
      (line) =>
        line.fulfillment_id === fulfillmentId &&
        line.order_item_id === order_item_id,
    );
    if (
      !line ||
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > line.available_quantity
    )
      throw Error(
        "Return quantities must be whole numbers within the available quantity for this shipment.",
      );
    items.push({ order_item_id, quantity });
  }
  if (!items.length || items.length > 100)
    throw Error("Select between 1 and 100 return lines.");
  return items;
}
