import { expect, test } from "bun:test";
import {
  isTransferCommand,
  isTransferReceipt,
  type TransferCommand,
} from "../../admin/src/lib/transfers";
import {
  commandKey,
  dispatchCommand,
  readCommand,
} from "../../admin/src/lib/commands";
const command: TransferCommand = {
  variant_id: crypto.randomUUID(),
  from_location_id: crypto.randomUUID(),
  to_location_id: crypto.randomUUID(),
  quantity: 4,
  idempotency_key: crypto.randomUUID(),
  note: "Move to east warehouse",
};
const receipt = {
  id: crypto.randomUUID(),
  variant_id: command.variant_id,
  from_location_id: command.from_location_id,
  to_location_id: command.to_location_id,
  quantity: 4,
  from_on_hand_after: 7,
  to_on_hand_after: 6,
  out_movement_id: "9007199254740993",
  in_movement_id: "9007199254740995",
};
test("transfer validation rejects same warehouses, invalid quantities and unrelated receipts", () => {
  expect(isTransferCommand(command)).toBe(true);
  for (const quantity of [0, -1, 1.2, 2147483648])
    expect(isTransferCommand({ ...command, quantity })).toBe(false);
  expect(isTransferCommand({ ...command, quantity: 2147483647 })).toBe(true);
  expect(
    isTransferCommand({ ...command, to_location_id: command.from_location_id }),
  ).toBe(false);
  expect(isTransferCommand({ ...command, note: "x".repeat(2001) })).toBe(false);
  expect(isTransferReceipt(receipt, command)).toBe(true);
  for (const patch of [
    { variant_id: crypto.randomUUID() },
    { from_location_id: command.to_location_id },
    { quantity: 3 },
    { out_movement_id: 9007199254740993 },
    { in_movement_id: receipt.out_movement_id },
    { in_movement_id: "9223372036854775808" },
  ])
    expect(isTransferReceipt({ ...receipt, ...patch }, command)).toBe(false);
});
test("lost transfer response survives reload, malformed receipt keeps journal, exact replay clears it", async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
    removeItem: (k: string) => {
      values.delete(k);
    },
  } as Storage;
  const key = commandKey("admin", "transfer", "product");
  const acknowledge = (data: unknown) => isTransferReceipt(data, command);
  await expect(
    dispatchCommand(
      storage,
      key,
      command,
      async () => {
        throw Error("lost response");
      },
      acknowledge,
    ),
  ).rejects.toThrow("lost response");
  const restored = readCommand(storage, key, isTransferCommand)!;
  expect(restored).toEqual(command);
  await expect(
    dispatchCommand(
      storage,
      key,
      { ...command, quantity: 5 },
      async () => {
        throw Error("must not send");
      },
      acknowledge,
    ),
  ).rejects.toThrow("Resolve");
  await expect(
    dispatchCommand(
      storage,
      key,
      restored,
      async () => ({
        data: { ...receipt, quantity: 5 },
        error: null,
        status: 200,
      }),
      acknowledge,
    ),
  ).rejects.toThrow("unconfirmed");
  expect(readCommand(storage, key, isTransferCommand)).toEqual(command);
  await dispatchCommand(
    storage,
    key,
    restored,
    async (args) => {
      expect(args).toEqual(command);
      return { data: receipt, error: null, status: 200 };
    },
    acknowledge,
  );
  expect(storage.getItem(key)).toBeNull();
});
