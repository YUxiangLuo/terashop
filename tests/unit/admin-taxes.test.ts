import { expect, test } from "bun:test";
import { taxRatio, taxPercent, taxCountry } from "../../admin/src/lib/taxes";

test("percentage input maps exactly to API four-place ratios without rounding", () => {
  for (const [text, ratio] of [
    ["13", 0.13],
    ["7.25", 0.0725],
    ["0.01", 0.0001],
    ["0", 0],
    ["100.00", 1],
    [" 99.99 ", 0.9999],
  ] as const) {
    expect(taxRatio(text)).toBe(ratio);
    expect(taxRatio(taxPercent(ratio))).toBe(ratio);
  }
  expect(taxPercent(0.0725)).toBe("7.25");
  for (const text of [
    "",
    " ",
    "-1",
    "100.01",
    "13.001",
    "1e1",
    "13%",
    ".5",
    "NaN",
    "Infinity",
    "1,5",
    "9".repeat(400),
  ])
    expect(() => taxRatio(text)).toThrow();
});

test("country input requires an explicit code or fallback", () => {
  expect(taxCountry(" ca ")).toBe("CA");
  expect(taxCountry(" * ")).toBe("*");
  for (const value of ["", "USA", "U1", "US,CA", "**"])
    expect(() => taxCountry(value)).toThrow();
});
