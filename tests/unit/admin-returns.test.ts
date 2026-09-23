import { expect, test } from "bun:test";
import {
  isReturnCommand,
  acknowledgesReturn,
  returnItems,
  type ReturnCommand,
  isReceiveCommand,
  receiveItems,
  acknowledgesReceipt,
  type ReturnAuthorization,
  type ReceiveCommand,
  isDisposeCommand,
  dispositionQuantity,
  acknowledgesDisposition,
  type DisposeCommand,
} from "../../admin/src/lib/returns";
import { dispatchCommand } from "../../admin/src/lib/commands";
const a = "aaaaaaaa-1111-4111-8111-111111111111",
  b = "bbbbbbbb-2222-4222-8222-222222222222";
const shipment = crypto.randomUUID(),
  order = crypto.randomUUID();
test("disposition quantities and commands reject over-disposal and invalid outcomes", () => {
  expect(dispositionQuantity(2, 2)).toBe(2);
  for (const quantity of [undefined, 0, -1, 1.5, 3])
    expect(() => dispositionQuantity(quantity, 2)).toThrow();
  expect(() => dispositionQuantity(1, 0)).toThrow();
  const command: DisposeCommand = {
    receipt_line_id: a,
    quantity: 2,
    disposition: "restock",
    note: "Inspected",
    idempotency_key: b,
  };
  expect(isDisposeCommand(command)).toBe(true);
  for (const change of [
    { quantity: 0 },
    { quantity: 2147483648 },
    { quantity: "2" },
    { disposition: "refund" },
    { note: "a".repeat(2001) },
    { location_id: b },
  ])
    expect(isDisposeCommand({ ...command, ...change })).toBe(false);
});
test("disposition acknowledgment matches exact facts and preserves bigint movement IDs", () => {
  const command: DisposeCommand = {
    receipt_line_id: a,
    quantity: 2,
    disposition: "restock",
    note: "Inspected",
    idempotency_key: b,
  };
  const result = {
    id: crypto.randomUUID(),
    receipt_line_id: a,
    quantity: 2,
    disposition: "restock",
    note: "Inspected",
    inventory_movement_id: "9223372036854775807",
  };
  expect(acknowledgesDisposition(result, command)).toBe(true);
  for (const change of [
    { receipt_line_id: b },
    { quantity: 1 },
    { disposition: "discard" },
    { note: "Other" },
    { inventory_movement_id: null },
    { inventory_movement_id: 9007199254740993 },
    { inventory_movement_id: "9223372036854775808" },
    { inventory_movement_id: "0" },
  ])
    expect(acknowledgesDisposition({ ...result, ...change }, command)).toBe(
      false,
    );
  const discard = { ...command, disposition: "discard" as const };
  expect(
    acknowledgesDisposition(
      { ...result, disposition: "discard", inventory_movement_id: null },
      discard,
    ),
  ).toBe(true);
  expect(
    acknowledgesDisposition({ ...result, disposition: "discard" }, discard),
  ).toBe(false);
});
const command: ReturnCommand = {
  fulfillment_id: shipment,
  reason: "Wrong size",
  idempotency_key: crypto.randomUUID(),
  items: [
    { order_item_id: a, quantity: 2 },
    { order_item_id: b, quantity: 1 },
  ],
};
const receipt = () => ({
  id: crypto.randomUUID(),
  order_id: order,
  fulfillment_id: shipment,
  status: "open",
  reason: "Wrong size",
  lines: command.items.map((i) => ({
    ...i,
    id: crypto.randomUUID(),
    received_quantity: 0,
    receivable_quantity: i.quantity,
  })),
});
test("receipt selection uses return-line IDs and remaining receipt balance, only while open", () => {
  const authorization: ReturnAuthorization = {
    ...receipt(),
    created_at: new Date().toISOString(),
    closed_at: null,
    receipts: [],
    status: "open",
    lines: [
      {
        id: b,
        order_item_id: a,
        quantity: 5,
        received_quantity: 3,
        receivable_quantity: 2,
      },
    ],
  };
  expect(receiveItems(authorization, { [b]: 2 })).toEqual([
    { return_line_id: b, quantity: 2 },
  ]);
  for (const quantities of [
    { [b]: 3 },
    { [a]: 1 },
    { [b]: 0 },
    { [b]: 1.5 },
    { [b]: -1 },
  ])
    expect(() => receiveItems(authorization, quantities)).toThrow();
  expect(() =>
    receiveItems({ ...authorization, status: "closed" }, { [b]: 1 }),
  ).toThrow();
});
test("receipt commands and acknowledgments reject wrong ownership, duplicates, location, note or quantities", () => {
  const command: ReceiveCommand = {
    return_id: shipment,
    location_id: order,
    items: [
      { return_line_id: a, quantity: 2 },
      { return_line_id: b, quantity: 1 },
    ],
    note: "Inspection",
    idempotency_key: crypto.randomUUID(),
  };
  expect(isReceiveCommand(command)).toBe(true);
  for (const change of [
    { location_id: "" },
    { note: "x".repeat(2001) },
    { items: [] },
    { items: [command.items[0], command.items[0]] },
    { items: [{ return_line_id: a, quantity: 2147483648 }] },
    { extra: 1 },
  ])
    expect(isReceiveCommand({ ...command, ...change })).toBe(false);
  const result = {
    id: crypto.randomUUID(),
    order_id: order,
    return_id: shipment,
    location_id: order,
    note: "Inspection",
    lines: [
      {
        id: crypto.randomUUID(),
        return_line_id: b,
        quantity: 1,
        undisposed_quantity: 0,
      },
      {
        id: crypto.randomUUID(),
        return_line_id: a,
        quantity: 2,
        undisposed_quantity: 1,
      },
    ],
  };
  expect(acknowledgesReceipt(result, command, order)).toBe(true);
  for (const change of [
    { order_id: b },
    { return_id: b },
    { location_id: b },
    { note: "Other" },
    { lines: [result.lines[0], result.lines[0]] },
    { lines: result.lines.map((l) => ({ ...l, quantity: 3 })) },
  ])
    expect(acknowledgesReceipt({ ...result, ...change }, command, order)).toBe(
      false,
    );
});
test("saved return validates exact shape, distinct items and numeric boundaries", () => {
  expect(isReturnCommand(command)).toBe(true);
  for (const quantity of [0, -1, 1.5, 2147483648, "1"])
    expect(
      isReturnCommand({ ...command, items: [{ order_item_id: a, quantity }] }),
    ).toBe(false);
  expect(
    isReturnCommand({
      ...command,
      items: [
        command.items[0],
        { order_item_id: a.toUpperCase(), quantity: 1 },
      ],
    }),
  ).toBe(false);
  expect(isReturnCommand({ ...command, reason: "a".repeat(501) })).toBe(false);
  expect(isReturnCommand({ ...command, reason: "a".repeat(500) })).toBe(true);
  expect(isReturnCommand({ ...command, items: [] })).toBe(false);
  expect(isReturnCommand({ ...command, stock: true })).toBe(false);
});
test("selection uses shipment availability, not order total or another shipment", () => {
  const base = {
    order_item_id: a,
    shipped_quantity: 9,
    authorized_unreceived_quantity: 4,
    received_quantity: 3,
  };
  const lines = [
    { ...base, fulfillment_id: b, available_quantity: 9 },
    { ...base, fulfillment_id: shipment, available_quantity: 2 },
  ];
  expect(returnItems(lines, shipment, { [a]: 2, [b]: 0 })).toEqual([
    { order_item_id: a, quantity: 2 },
  ]);
  for (const quantities of [
    { [a]: 3 },
    { [a]: -1 },
    { [a]: 1.5 },
    { [b]: 1 },
    {},
  ])
    expect(() => returnItems(lines, shipment, quantities)).toThrow();
});
test("acknowledgment matches all immutable facts, independent of ordering or later progress", () => {
  const result = receipt();
  result.status = "closed";
  result.lines.reverse();
  result.lines[0].received_quantity = 1;
  result.lines[0].receivable_quantity = 0;
  expect(acknowledgesReturn(result, command, order)).toBe(true);
  for (const override of [
    { order_id: b },
    { fulfillment_id: b },
    { reason: "Changed" },
    { lines: [result.lines[0], result.lines[0]] },
    { lines: result.lines.slice(1) },
    { lines: result.lines.map((l) => ({ ...l, quantity: 3 })) },
  ]) {
    expect(acknowledgesReturn({ ...result, ...override }, command, order)).toBe(
      false,
    );
  }
});
test("unknown return survives reload and replays the same key, then clears only on matching facts", async () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
    removeItem: (k: string) => {
      data.delete(k);
    },
  } as Storage;
  const ack = (v: unknown) => acknowledgesReturn(v, command, order);
  await expect(
    dispatchCommand(
      storage,
      "return",
      command,
      async () => {
        throw Error("Response lost");
      },
      ack,
    ),
  ).rejects.toThrow("Response lost");
  expect(JSON.parse(data.get("return")!)).toEqual(command);
  await expect(
    dispatchCommand(
      storage,
      "return",
      command,
      async () => ({
        data: { ...receipt(), order_id: b },
        error: null,
        status: 200,
      }),
      ack,
    ),
  ).rejects.toThrow("unconfirmed");
  const saved = JSON.parse(data.get("return")!);
  await dispatchCommand(
    storage,
    "return",
    saved,
    async (c) => {
      expect(c).toEqual(command);
      return {
        data: { ...receipt(), status: "closed" },
        error: null,
        status: 200,
      };
    },
    ack,
  );
  expect(data.size).toBe(0);
});
