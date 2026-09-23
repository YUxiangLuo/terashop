import { expect, test } from "bun:test";
import { shippingMoney } from "../../admin/src/lib/shipping";
import {
  ledgerRemaining,
  manualRefundBlock,
  isManualRefundCommand,
  acknowledgesManualRefund,
  type OrderLedger,
  type ManualRefundCommand,
} from "../../admin/src/lib/refunds";
const id = crypto.randomUUID();
const ledger = () =>
  ({
    order: {
      id,
      total: 0.3,
      currency: "USD",
      financial_status: "partially_refunded",
    },
    balances: { captured: 0.4, refunded: 0.2, is_balanced: true },
    transactions: [
      { provider: "manual", kind: "capture", status: "succeeded" },
    ],
    payment_intents: [],
  }) as unknown as OrderLedger;
test("remaining balance uses captured cap, order cap and integer cents", () => {
  expect(ledgerRemaining(ledger())).toBe(0.1);
  const l = ledger();
  l.balances.captured = 0.25;
  expect(ledgerRemaining(l)).toBe(0.05);
  l.balances.refunded = 0.3;
  expect(ledgerRemaining(l)).toBe(0);
});
test("manual-only gate rejects provider history, pending requests and unreconciled ledgers", () => {
  expect(manualRefundBlock(ledger(), false)).toBe("");
  expect(manualRefundBlock(ledger(), true)).not.toBe("");
  const online = ledger();
  online.transactions[0].provider = "paypal";
  expect(manualRefundBlock(online, false)).not.toBe("");
  const mixed = ledger();
  mixed.payment_intents = [{ id }] as OrderLedger["payment_intents"];
  expect(manualRefundBlock(mixed, false)).not.toBe("");
  const unbalanced = ledger();
  unbalanced.balances.is_balanced = false;
  expect(manualRefundBlock(unbalanced, false)).not.toBe("");
  const unpaid = ledger();
  unpaid.transactions = [];
  expect(manualRefundBlock(unpaid, false)).not.toBe("");
});
test("refund command always has explicit positive two-decimal amount, manual provider, no stock or items", () => {
  const command: ManualRefundCommand = {
    order_id: id,
    amount: shippingMoney("7.25"),
    reason: "Offline refund reference",
    restock: false,
    provider: "manual",
    idempotency_key: crypto.randomUUID(),
  };
  expect(isManualRefundCommand(command)).toBe(true);
  for (const change of [
    { amount: undefined },
    { amount: 0 },
    { amount: 1.001 },
    { amount: Infinity },
    { provider: "paypal" },
    { restock: true },
    { items: [] },
    { shipping_amount: 1 },
    { reason: " " },
  ])
    expect(isManualRefundCommand({ ...command, ...change })).toBe(false);
  for (const text of ["1e2", "1.001", "-1", ""])
    expect(() => shippingMoney(text)).toThrow();
  expect(
    acknowledgesManualRefund(
      { id, currency: "USD", financial_status: "partially_refunded" },
      command,
    ),
  ).toBe(true);
  expect(
    acknowledgesManualRefund(
      {
        id: crypto.randomUUID(),
        currency: "USD",
        financial_status: "refunded",
      },
      command,
    ),
  ).toBe(false);
  expect(
    acknowledgesManualRefund(
      { id, currency: "USD", financial_status: "paid" },
      command,
    ),
  ).toBe(false);
});
