import type { Database } from "../../../types/database";

type Functions = Database["public"]["Functions"];
export type StockCommand = Functions["adjust_inventory"]["Args"];
export type ShipmentCommand = Functions["create_fulfillment"]["Args"];
export type FulfillmentUpdateCommand = {
  fulfillment_id: string;
  expected_version: number;
  changes: {
    status?: "delivered" | "cancelled";
    carrier?: string;
    tracking_number?: string;
    tracking_url?: string | null;
  };
  idempotency_key: string;
};

// Retain the exact command before dispatch, including across a page reload.
// No credentials or customer addresses are stored here. Callers scope by Auth user.
export function commandKey(
  user: string,
  kind: "stock" | "shipment" | "fulfillment-update" | "transfer" | "return",
  resource: string,
) {
  return `tera-admin-command:${user}:${kind}:${resource}`;
}

export function readCommand<T>(
  storage: Storage,
  key: string,
  valid: (value: unknown) => value is T,
): T | null {
  const raw = storage.getItem(key);
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  if (!valid(value))
    throw new Error(
      "The saved operation cannot be read. Do not repeat the operation until its result has been checked.",
    );
  return value;
}

export async function dispatchCommand<T>(
  storage: Storage,
  key: string,
  command: T,
  send: (command: T) => PromiseLike<{
    data: unknown;
    error: { code?: string; message: string } | null;
    status: number;
  }>,
  acknowledge: (data: unknown) => boolean,
) {
  const previous = storage.getItem(key);
  const serialized = JSON.stringify(command);
  if (previous !== null && previous !== serialized)
    throw new Error(
      "Resolve the saved operation before submitting different parameters.",
    );
  storage.setItem(key, serialized);
  const result = await send(command);
  if (result.error) {
    // Only an explicit rollback of the FIRST attempt can release the command.
    // A rejected replay (e.g. lost permissions) says nothing about its earlier result.
    if (
      previous === null &&
      result.status >= 400 &&
      result.status < 500 &&
      [
        "P0001",
        "22023",
        "22P02",
        "23514",
        "23505",
        "23503",
        "42501",
        "PT404",
        "PT409",
      ].includes(result.error.code ?? "")
    )
      storage.removeItem(key);
    throw result.error;
  }
  if (!acknowledge(result.data))
    throw new Error(
      "The server returned an unconfirmed result. The original request has been retained.",
    );
  storage.removeItem(key);
}

const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
export function isStockCommand(value: unknown): value is StockCommand {
  return (
    object(value) &&
    Object.keys(value).every((key) =>
      [
        "variant_id",
        "location_id",
        "delta",
        "note",
        "reason",
        "idempotency_key",
      ].includes(key),
    ) &&
    uuid(value.variant_id) &&
    uuid(value.location_id) &&
    uuid(value.idempotency_key) &&
    Number.isInteger(value.delta) &&
    Number(value.delta) !== 0 &&
    Math.abs(Number(value.delta)) <= 2147483647 &&
    value.reason === "adjust" &&
    typeof value.note === "string"
  );
}
export function isShipmentCommand(value: unknown): value is ShipmentCommand {
  return (
    object(value) &&
    Object.keys(value).every((key) =>
      [
        "order_id",
        "items",
        "carrier",
        "tracking_number",
        "idempotency_key",
      ].includes(key),
    ) &&
    uuid(value.order_id) &&
    uuid(value.idempotency_key) &&
    typeof value.carrier === "string" &&
    typeof value.tracking_number === "string" &&
    Array.isArray(value.items) &&
    value.items.length > 0 &&
    value.items.every(
      (item) =>
        object(item) &&
        Object.keys(item).every((key) =>
          ["order_item_id", "quantity"].includes(key),
        ) &&
        uuid(item.order_item_id) &&
        Number.isInteger(item.quantity) &&
        Number(item.quantity) > 0,
    )
  );
}

export function isFulfillmentUpdateCommand(
  value: unknown,
): value is FulfillmentUpdateCommand {
  if (
    !object(value) ||
    !Object.keys(value).every((key) =>
      [
        "fulfillment_id",
        "expected_version",
        "changes",
        "idempotency_key",
      ].includes(key),
    ) ||
    !uuid(value.fulfillment_id) ||
    !uuid(value.idempotency_key) ||
    !Number.isSafeInteger(value.expected_version) ||
    Number(value.expected_version) < 1 ||
    !object(value.changes)
  )
    return false;
  const changes = value.changes;
  const keys = Object.keys(changes);
  return (
    keys.length > 0 &&
    keys.every((key) => {
      const field = changes[key];
      if (key === "status")
        return field === "delivered" || field === "cancelled";
      if (key === "carrier" || key === "tracking_number")
        return typeof field === "string";
      if (key === "tracking_url")
        return field === null || typeof field === "string";
      return false;
    })
  );
}
