import { expect, test } from "bun:test";
import { shippingMoney, shippingCountries } from "../../admin/src/lib/shipping";

test("shipping amounts retain zero and cents and reject rounding or unsupported notation", () => {
  expect(shippingMoney("0")).toBe(0);
  expect(shippingMoney("19.49")).toBe(19.49);
  expect(shippingMoney(" 9999999999.99 ")).toBe(9999999999.99);
  for (const value of [
    "",
    " ",
    "-0.01",
    "1.005",
    "10000000000",
    "1e2",
    "NaN",
    "Infinity",
    "1,50",
  ])
    expect(() => shippingMoney(value)).toThrow();
});
test("blank country scope is worldwide; normalize codes without accepting malformed entries", () => {
  expect(shippingCountries(" ")).toEqual([]);
  expect(shippingCountries(" us, ca ,US")).toEqual(["US", "CA"]);
  for (const value of ["USA", "U1", "US,", "US,,CA", "US CA"])
    expect(() => shippingCountries(value)).toThrow();
});
