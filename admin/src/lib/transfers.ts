import type { Database } from "../../../types/database";
export type TransferCommand =
  Database["public"]["Functions"]["transfer_inventory"]["Args"];
export interface TransferReceipt {
  id: string;
  variant_id: string;
  from_location_id: string;
  to_location_id: string;
  quantity: number;
  from_on_hand_after: number;
  to_on_hand_after: number;
  out_movement_id: string;
  in_movement_id: string;
}
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const int4 = (v: unknown) =>
  Number.isInteger(v) && Number(v) >= -2147483648 && Number(v) <= 2147483647;
export function isTransferCommand(v: unknown): v is TransferCommand {
  return (
    object(v) &&
    Object.keys(v).every((k) =>
      [
        "variant_id",
        "from_location_id",
        "to_location_id",
        "quantity",
        "idempotency_key",
        "note",
      ].includes(k),
    ) &&
    uuid(v.variant_id) &&
    uuid(v.from_location_id) &&
    uuid(v.to_location_id) &&
    v.from_location_id !== v.to_location_id &&
    uuid(v.idempotency_key) &&
    int4(v.quantity) &&
    Number(v.quantity) > 0 &&
    typeof v.note === "string" &&
    v.note.length <= 2000
  );
}
export function isTransferReceipt(
  v: unknown,
  command: TransferCommand,
): v is TransferReceipt {
  return (
    object(v) &&
    uuid(v.id) &&
    v.variant_id === command.variant_id &&
    v.from_location_id === command.from_location_id &&
    v.to_location_id === command.to_location_id &&
    v.quantity === command.quantity &&
    int4(v.from_on_hand_after) &&
    int4(v.to_on_hand_after) &&
    typeof v.out_movement_id === "string" &&
    /^[1-9][0-9]{0,18}$/.test(v.out_movement_id) &&
    typeof v.in_movement_id === "string" &&
    /^[1-9][0-9]{0,18}$/.test(v.in_movement_id) &&
    BigInt(v.out_movement_id) <= 9223372036854775807n &&
    BigInt(v.in_movement_id) <= 9223372036854775807n &&
    v.out_movement_id !== v.in_movement_id
  );
}
