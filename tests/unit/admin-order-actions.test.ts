import { describe, expect, test } from "bun:test";
import {
  paypalAmount,
  readOrderAction,
  saveOrderAction,
} from "../../admin/src/lib/order-actions";

class MemoryStorage implements Storage {
  #values = new Map<string, string>();
  get length() {
    return this.#values.size;
  }
  clear() {
    this.#values.clear();
  }
  getItem(key: string) {
    return this.#values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.#values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.#values.delete(key);
  }
  setItem(key: string, value: string) {
    this.#values.set(key, value);
  }
}

const orderId = "00000000-0000-4000-8000-000000000001";

describe("admin order action safety helpers", () => {
  test("retains exact arguments and rejects replacement", () => {
    const storage = new MemoryStorage();
    const action = {
      kind: "mark-paid" as const,
      arguments: {
        order_id: orderId,
        idempotency_key: "00000000-0000-4000-8000-000000000002",
      },
    };
    saveOrderAction(storage, "action", action);
    expect(readOrderAction(storage, "action")).toEqual(action);
    expect(() =>
      saveOrderAction(storage, "action", {
        ...action,
        arguments: { ...action.arguments, provider: "manual" },
      }),
    ).toThrow("Resolve the retained");
  });

  test("accepts only exact positive PayPal decimal strings", () => {
    expect(paypalAmount(" 12.30 ")).toBe("12.30");
    for (const value of ["", "0", "01", "1.001", "-1", "1e2"])
      expect(() => paypalAmount(value)).toThrow();
  });

  test("refuses retained write bodies missing original keys or containing extra fields", () => {
    const storage = new MemoryStorage();
    for (const args of [
      { order_id: orderId },
      { order_id: orderId, idempotency_key: orderId, actor_id: orderId },
    ]) {
      storage.setItem(
        "action",
        JSON.stringify({ kind: "mark-paid", arguments: args }),
      );
      expect(() => readOrderAction(storage, "action")).toThrow();
    }
  });
});
