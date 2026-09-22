import { expect, test } from "bun:test";
import {
  commandKey,
  dispatchCommand,
  readCommand,
  isStockCommand,
  isShipmentCommand,
  isFulfillmentUpdateCommand,
} from "../../admin/src/lib/commands";

const stock = {
  variant_id: "11111111-1111-4111-8111-111111111111",
  location_id: "22222222-2222-4222-8222-222222222222",
  idempotency_key: "33333333-3333-4333-8333-333333333333",
  delta: -3,
  reason: "adjust",
  note: "Count correction",
};
function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

test("unknown writes survive reload and replay exact parameters; changed commands cannot replace them", async () => {
  const storage = memoryStorage();
  const key = commandKey("admin-a", "stock", "product-a");
  let calls = 0;
  const send = async (args: typeof stock) => {
    calls++;
    expect(JSON.parse(storage.getItem(key)!)).toEqual(stock);
    expect(args).toEqual(stock);
    throw new Error("response lost after commit");
  };
  await expect(
    dispatchCommand(storage, key, stock, send, () => true),
  ).rejects.toThrow("response lost");
  const restored = readCommand(storage, key, isStockCommand);
  expect(restored).toEqual(stock);
  await expect(
    dispatchCommand(storage, key, { ...stock, delta: 9 }, send, () => true),
  ).rejects.toThrow("Resolve");
  expect(calls).toBe(1);
  expect(
    storage.getItem(commandKey("admin-b", "stock", "product-a")),
  ).toBeNull();
  expect(
    storage.getItem(commandKey("admin-a", "shipment", "product-a")),
  ).toBeNull();
  await dispatchCommand(
    storage,
    key,
    restored!,
    async (args) => {
      expect(args).toEqual(stock);
      return { data: { on_hand: 7 }, error: null, status: 200 };
    },
    (data) => (data as { on_hand: number }).on_hand === 7,
  );
  expect(storage.getItem(key)).toBeNull();
});

test("first explicit rollback allows correction; rejected replay never discards an unknown prior write", async () => {
  const storage = memoryStorage();
  const rejected = async () => ({
    data: null,
    error: { code: "P0001", message: "insufficient inventory" },
    status: 400,
  });
  await expect(
    dispatchCommand(storage, "key", stock, rejected, () => true),
  ).rejects.toMatchObject({ code: "P0001" });
  expect(storage.getItem("key")).toBeNull();
  storage.setItem("key", JSON.stringify(stock));
  await expect(
    dispatchCommand(storage, "key", stock, rejected, () => true),
  ).rejects.toMatchObject({ code: "P0001" });
  expect(readCommand(storage, "key", isStockCommand)).toEqual(stock);
});

test("storage failure prevents dispatch; malformed success and server errors retain request", async () => {
  const storage = memoryStorage();
  let calls = 0;
  const send = async () => {
    calls++;
    return { data: null, error: null, status: 200 };
  };
  const broken = {
    ...storage,
    setItem: () => {
      throw new Error("quota");
    },
  };
  await expect(
    dispatchCommand(broken, "key", stock, send, () => true),
  ).rejects.toThrow("quota");
  expect(calls).toBe(0);
  await expect(
    dispatchCommand(storage, "key", stock, send, (data) => data !== null),
  ).rejects.toThrow("unconfirmed");
  expect(readCommand(storage, "key", isStockCommand)).toEqual(stock);
  storage.clear();
  await expect(
    dispatchCommand(
      storage,
      "key",
      stock,
      async () => ({
        data: null,
        error: { code: "P0001", message: "gateway" },
        status: 502,
      }),
      () => true,
    ),
  ).rejects.toMatchObject({ message: "gateway" });
  expect(readCommand(storage, "key", isStockCommand)).toEqual(stock);
});

test("saved commands reject malformed quantities, identities and extra RPC fields", () => {
  expect(isStockCommand(stock)).toBe(true);
  for (const delta of [0, 1.5, "3", null, 2147483648])
    expect(isStockCommand({ ...stock, delta })).toBe(false);
  expect(isStockCommand({ ...stock, variant_id: "other" })).toBe(false);
  expect(isStockCommand({ ...stock, actor_id: stock.variant_id })).toBe(false);
  const shipment = {
    order_id: stock.variant_id,
    items: [{ order_item_id: stock.location_id, quantity: 2 }],
    carrier: "DHL",
    tracking_number: "TEST",
    idempotency_key: stock.idempotency_key,
  };
  expect(isShipmentCommand(shipment)).toBe(true);
  expect(isShipmentCommand({ ...shipment, items: [] })).toBe(false);
  expect(
    isShipmentCommand({
      ...shipment,
      items: [{ order_item_id: stock.location_id, quantity: 0 }],
    }),
  ).toBe(false);
  const storage = memoryStorage();
  storage.setItem("key", "{}");
  expect(() => readCommand(storage, "key", isStockCommand)).toThrow(
    "cannot be read",
  );
  expect(storage.getItem("key")).toBe("{}");
});

test("fulfillment updates strictly validate fields and replay their original version and key", async () => {
  const storage = memoryStorage();
  const update = {
    fulfillment_id: stock.variant_id,
    expected_version: 7,
    changes: { tracking_number: "NEW", tracking_url: null },
    idempotency_key: stock.idempotency_key,
  };
  expect(isFulfillmentUpdateCommand(update)).toBe(true);
  for (const invalid of [
    { ...update, expected_version: 0 },
    { ...update, expected_version: 1.5 },
    { ...update, changes: {} },
    { ...update, changes: { status: "shipped" } },
    { ...update, changes: { carrier: null } },
    { ...update, changes: { carrier: undefined } },
    { ...update, changes: { items: [] } },
    { ...update, order_id: stock.location_id },
  ])
    expect(isFulfillmentUpdateCommand(invalid)).toBe(false);

  const key = commandKey(
    "admin-a",
    "fulfillment-update",
    update.fulfillment_id,
  );
  await expect(
    dispatchCommand(
      storage,
      key,
      update,
      async () => {
        throw new Error("response lost");
      },
      () => true,
    ),
  ).rejects.toThrow("response lost");
  const restored = readCommand(storage, key, isFulfillmentUpdateCommand)!;
  expect(restored.expected_version).toBe(7);
  expect(restored.idempotency_key).toBe(update.idempotency_key);
  await dispatchCommand(
    storage,
    key,
    restored,
    async (args) => {
      expect(args).toEqual(update);
      return {
        data: { id: update.fulfillment_id, version: 8 },
        error: null,
        status: 200,
      };
    },
    (data) => (data as { version: number }).version === 8,
  );
  expect(storage.getItem(key)).toBeNull();
});
