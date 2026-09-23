import { expect, test } from "bun:test";
import {
  promotionFields,
  promotionChanges,
  type Promotion,
  type PromotionType,
} from "../../admin/src/lib/promotions";
const rule: Promotion = {
  id: "d67020d2-f623-4cde-b91f-3a2f16f85e31",
  revision: 9,
  name: "Selected items",
  code: "SALE",
  type: "item_percentage",
  params: { percent: 17.5, min_quantity: 3, preserved: { internal: "keep" } },
  priority: -7,
  stackable: true,
  apply_scope: "selected",
  get_scope: "selected",
  usage_limit: 20,
  used_count: 7,
  per_customer_limit: 2,
  starts_at: "2026-01-01T08:00:00.123456+08:00",
  ends_at: null,
  is_active: false,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};
test("metadata-only patch preserves params, targets, scopes, usage and exact timestamps", () => {
  const fields = promotionFields(rule);
  expect(fields.starts_at).toBe("2026-01-01T08:00:00.123456+08:00");
  expect(promotionChanges(fields, rule)).toEqual({});
  fields.name = "Renamed";
  expect(promotionChanges(fields, rule)).toEqual({ name: "Renamed" });
  fields.parameters.percent = "23.75";
  fields.parameters.min_quantity = "";
  expect(promotionChanges(fields, rule)).toEqual({
    name: "Renamed",
    params: { percent: 23.75, preserved: { internal: "keep" } },
  });
  expect(rule.params.min_quantity).toBe(3);
});
test("creation maps all five algorithms, defaults disabled and keeps percent in percent units", () => {
  for (const [type, input, expected] of [
    [
      "order_percentage",
      { percent: "12.5", threshold: "42.75" },
      { percent: 12.5, threshold: 42.75 },
    ],
    ["order_fixed", { amount: "3.49" }, { amount: 3.49 }],
    [
      "item_percentage",
      { percent: "100", min_quantity: "2" },
      { percent: 100, min_quantity: 2 },
    ],
    [
      "buy_x_get_y",
      { buy: "3", get: "2", get_percent: "25" },
      { buy: 3, get: 2, get_percent: 25 },
    ],
    ["free_shipping", {}, {}],
  ] as [PromotionType, Record<string, string>, Record<string, number>][]) {
    const fields = {
      ...promotionFields(null),
      name: "New",
      type,
      parameters: input,
    };
    const changes = promotionChanges(fields, null);
    expect(changes).toMatchObject({
      type,
      params: expected,
      is_active: false,
      code: null,
      usage_limit: null,
    });
    expect(changes).not.toHaveProperty("targets");
    expect(changes).not.toHaveProperty("apply_scope");
    expect(changes).not.toHaveProperty("used_count");
  }
});
test("nullable clearing, offset preservation and schedule validation", () => {
  const fields = promotionFields(rule);
  fields.code = "";
  fields.usage_limit = "";
  fields.starts_at = "";
  expect(promotionChanges(fields, rule)).toEqual({
    code: null,
    usage_limit: null,
    starts_at: null,
  });
  fields.code = " spring ";
  fields.starts_at = "2026-10-01T09:00:00.123456+08:00";
  expect(promotionChanges(fields, rule)).toMatchObject({
    code: "SPRING",
    starts_at: "2026-10-01T09:00:00.123456+08:00",
  });
  fields.ends_at = "2026-10-01T00:59:59Z";
  expect(() => promotionChanges(fields, rule)).toThrow("End time");
  fields.ends_at = "2026-10-01T01:00:01Z";
  expect(promotionChanges(fields, rule).ends_at).toBe(fields.ends_at);
  fields.starts_at = "2026-10-01T09:00:00";
  expect(() => promotionChanges(fields, rule)).toThrow("timezone");
});
test("reject invalid percentage, quantity, usage boundaries and algorithm changes", () => {
  for (const value of ["0", "-1", "100.01", "NaN", "Infinity", "1e2"]) {
    const fields = promotionFields(rule);
    fields.parameters.percent = value;
    expect(() => promotionChanges(fields, rule)).toThrow();
  }
  for (const value of ["0", "1.5", "2147483648"]) {
    const fields = promotionFields(rule);
    fields.parameters.min_quantity = value;
    expect(() => promotionChanges(fields, rule)).toThrow();
  }
  const fields = promotionFields(rule);
  fields.usage_limit = "6";
  expect(() => promotionChanges(fields, rule)).toThrow("occupied count");
  fields.usage_limit = "7";
  expect(promotionChanges(fields, rule)).toEqual({ usage_limit: 7 });
  fields.type = "free_shipping";
  expect(() => promotionChanges(fields, rule)).toThrow("separate promotion");
});
