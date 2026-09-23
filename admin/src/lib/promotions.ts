import type { Json } from "../../../types/database";

export const promotionTypes = {
  order_percentage: "Order percentage",
  order_fixed: "Order fixed amount",
  item_percentage: "Item percentage",
  buy_x_get_y: "Buy X get Y",
  free_shipping: "Free shipping",
} as const;
export type PromotionType = keyof typeof promotionTypes;
export interface Promotion {
  id: string;
  revision: number;
  name: string;
  code: string | null;
  type: PromotionType;
  params: Record<string, Json | undefined>;
  priority: number;
  stackable: boolean;
  apply_scope: "all" | "selected";
  get_scope: "same_as_apply" | "selected";
  usage_limit: number | null;
  used_count: number;
  per_customer_limit: number;
  starts_at: string | null;
  ends_at: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}
interface Parameter {
  key: string;
  label: string;
  kind: "percent" | "amount" | "integer" | "threshold";
  optional?: boolean;
}
const percent: Parameter = {
  key: "percent",
  label: "Discount (%)",
  kind: "percent",
};
const threshold: Parameter = {
  key: "threshold",
  label: "Minimum merchandise subtotal (USD)",
  kind: "threshold",
  optional: true,
};
export const promotionParameters: Record<PromotionType, Parameter[]> = {
  order_percentage: [percent, threshold],
  order_fixed: [
    { key: "amount", label: "Discount amount (USD)", kind: "amount" },
    threshold,
  ],
  item_percentage: [
    percent,
    {
      key: "min_quantity",
      label: "Minimum matching quantity",
      kind: "integer",
      optional: true,
    },
  ],
  buy_x_get_y: [
    { key: "buy", label: "Buy quantity", kind: "integer" },
    { key: "get", label: "Get quantity", kind: "integer" },
    {
      key: "get_percent",
      label: "Gift discount (%)",
      kind: "percent",
      optional: true,
    },
  ],
  free_shipping: [],
};

export function promotionFields(rule: Promotion | null) {
  const type = rule?.type ?? "order_percentage";
  return {
    name: rule?.name ?? "",
    code: rule?.code ?? "",
    type,
    parameters: Object.fromEntries(
      promotionParameters[type].map((p) => [
        p.key,
        rule?.params[p.key] == null ? "" : String(rule.params[p.key]),
      ]),
    ),
    priority: String(rule?.priority ?? 100),
    stackable: rule?.stackable ?? false,
    usage_limit: rule?.usage_limit == null ? "" : String(rule.usage_limit),
    per_customer_limit: String(rule?.per_customer_limit ?? 1),
    starts_at: rule?.starts_at ?? "",
    ends_at: rule?.ends_at ?? "",
    is_active: rule?.is_active ?? false,
  };
}
export type PromotionFields = ReturnType<typeof promotionFields>;

function integer(text: string, min: number): number {
  if (!/^-?\d+$/.test(text.trim()))
    throw Error("Enter whole-number priorities and limits.");
  const value = Number(text);
  if (!Number.isInteger(value) || value < min || value > 2147483647)
    throw Error(`Integer must be between ${min} and 2147483647.`);
  return value;
}
function timestamp(text: string): string | null {
  if (!text.trim()) return null;
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.test(
      text.trim(),
    ) ||
    !Number.isFinite(Date.parse(text))
  )
    throw Error(
      "Use an ISO timestamp with seconds and an explicit timezone, e.g. 2026-10-01T09:00:00+08:00.",
    );
  // Preserve offset and sub-millisecond precision; do not round-trip through Date.
  return text.trim();
}

export function promotionChanges(
  fields: PromotionFields,
  rule: Promotion | null,
): Record<string, Json> {
  if (rule && fields.type !== rule.type)
    throw Error("Create a separate promotion to change its type.");
  const original = promotionFields(rule);
  const changes: Record<string, Json> = {};
  if (!fields.name.trim()) throw Error("Enter a promotion name.");
  for (const key of [
    "name",
    "code",
    "priority",
    "stackable",
    "usage_limit",
    "per_customer_limit",
    "starts_at",
    "ends_at",
    "is_active",
  ] as const) {
    if (rule && fields[key] === original[key]) continue;
    switch (key) {
      case "code":
        changes[key] = fields[key].trim().toUpperCase() || null;
        break;
      case "priority":
        changes[key] = integer(fields[key], -2147483648);
        break;
      case "usage_limit":
        changes[key] = fields[key].trim() ? integer(fields[key], 1) : null;
        break;
      case "per_customer_limit":
        changes[key] = integer(fields[key], 1);
        break;
      case "starts_at":
      case "ends_at":
        changes[key] = timestamp(fields[key]);
        break;
      default:
        changes[key] = fields[key];
    }
  }
  if (
    typeof changes.usage_limit === "number" &&
    changes.usage_limit < (rule?.used_count ?? 0)
  )
    throw Error(
      "Usage limit cannot be below the recorded occupied count. Reload to check current usage.",
    );
  const start =
    changes.starts_at === undefined ? rule?.starts_at : changes.starts_at;
  const end = changes.ends_at === undefined ? rule?.ends_at : changes.ends_at;
  if (
    typeof start === "string" &&
    typeof end === "string" &&
    Date.parse(start) > Date.parse(end)
  )
    throw Error("End time must not precede start time.");
  if (!rule) changes.type = fields.type;
  const params = { ...rule?.params };
  let paramsChanged = !rule;
  for (const parameter of promotionParameters[fields.type]) {
    const text = fields.parameters[parameter.key] ?? "";
    if (rule && text === original.parameters[parameter.key]) continue;
    paramsChanged = true;
    if (!text.trim() && parameter.optional) {
      delete params[parameter.key];
      continue;
    }
    if (!/^-?\d+(\.\d+)?$/.test(text.trim()) || !Number.isFinite(Number(text)))
      throw Error(`${parameter.label}: enter a finite decimal number.`);
    const value = Number(text);
    if (parameter.kind === "integer") integer(text, 1);
    if (parameter.kind !== "threshold" && value <= 0)
      throw Error(`${parameter.label} must be positive.`);
    if (parameter.kind === "percent" && value > 100)
      throw Error(`${parameter.label} cannot exceed 100.`);
    params[parameter.key] = value;
  }
  if (paramsChanged) changes.params = params;
  // Never send targets or scopes: a displayed page is not the full target set.
  return changes;
}
