import type { Json } from "../../../types/database";
import type { Promotion } from "./promotions";

export interface PromotionTarget {
  id: string;
  promotion_id: string;
  role: "apply" | "get";
  product_id: string | null;
  category_id: string | null;
  variant_id: string | null;
}
export interface TargetDraft {
  apply_scope: Promotion["apply_scope"];
  get_scope: Promotion["get_scope"];
  rows: {
    role: "apply" | "get";
    kind: "product_id" | "category_id" | "variant_id";
    reference: string;
  }[];
}

// A full replacement needs one unchanged aggregate revision across every page.
export async function readTargetSnapshot(
  readRule: () => Promise<Promotion | null>,
  readPage: (
    cursor: string | null,
  ) => Promise<{ items: PromotionTarget[]; next_cursor: string | null }>,
): Promise<{ rule: Promotion; draft: TargetDraft }> {
  const rule = await readRule();
  if (!rule) throw Error("Promotion not found.");
  if (rule.type !== "item_percentage" && rule.type !== "buy_x_get_y")
    throw Error(
      "Target editing is available only for item percentage and buy/get rules.",
    );
  const targets: PromotionTarget[] = [];
  let cursor: string | null = null;
  do {
    const page = await readPage(cursor);
    targets.push(...page.items);
    if (targets.length > 100 || (targets.length === 100 && page.next_cursor))
      throw Error(
        "More than 100 targets: replacement is disabled. Edit rule details without replacing targets, or use an operator-managed workflow; this editor never truncates the set.",
      );
    cursor = page.next_cursor;
  } while (cursor);
  const current = await readRule();
  if (!current || current.id !== rule.id || current.revision !== rule.revision)
    throw Error(
      "Promotion changed while targets were loading. Reload the complete set before editing.",
    );
  return {
    rule,
    draft: {
      apply_scope: rule.apply_scope,
      get_scope: rule.get_scope,
      rows: targets.map((target) => {
        const kind = target.product_id
          ? "product_id"
          : target.category_id
            ? "category_id"
            : "variant_id";
        return { role: target.role, kind, reference: target[kind]! };
      }),
    },
  };
}

export function targetChanges(draft: TargetDraft): Record<string, Json> {
  if (draft.rows.length > 100) throw Error("At most 100 targets can be saved.");
  const seen = new Set<string>();
  const targets = draft.rows.map((row) => {
    const reference = row.reference.trim().toLowerCase();
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        reference,
      )
    )
      throw Error(
        "Each target needs a valid product, category or variant UUID.",
      );
    const key = `${row.role}:${row.kind}:${reference}`;
    if (seen.has(key))
      throw Error(
        "Duplicate target in the same role. Remove the duplicate before saving.",
      );
    seen.add(key);
    if (
      (row.role === "apply" && draft.apply_scope !== "selected") ||
      (row.role === "get" && draft.get_scope !== "selected")
    )
      throw Error(
        "Remove that role's targets before expanding its scope, or choose Selected targets.",
      );
    return { role: row.role, [row.kind]: reference };
  });
  return {
    apply_scope: draft.apply_scope,
    get_scope: draft.get_scope,
    targets,
  };
}
