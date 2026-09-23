import { expect, test } from "bun:test";
import {
  readTargetSnapshot,
  targetChanges,
  type TargetDraft,
  type PromotionTarget,
} from "../../admin/src/lib/promotion-targets";
import type { Promotion } from "../../admin/src/lib/promotions";
const rule = {
  id: "55555555-5555-4555-8555-555555555555",
  revision: 7,
  type: "buy_x_get_y",
  apply_scope: "selected",
  get_scope: "selected",
} as Promotion;
const reference = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const target = (index: number): PromotionTarget => ({
  id: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
  promotion_id: rule.id,
  role: index === 20 ? "get" : "apply",
  product_id: null,
  category_id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`,
  variant_id: null,
});
test("full snapshot follows every page then verifies the original revision", async () => {
  const calls: (string | null)[] = [];
  let reads = 0;
  const snapshot = await readTargetSnapshot(
    async () => {
      reads++;
      return rule;
    },
    async (cursor) => {
      calls.push(cursor);
      return cursor
        ? { items: [target(20)], next_cursor: null }
        : {
            items: Array.from({ length: 20 }, (_, i) => target(i)),
            next_cursor: "19",
          };
    },
  );
  expect(calls).toEqual([null, "19"]);
  expect(reads).toBe(2);
  expect(snapshot.rule.revision).toBe(7);
  expect(snapshot.draft.rows).toHaveLength(21);
  expect(snapshot.draft.rows[20]).toEqual({
    role: "get",
    kind: "category_id",
    reference: "aaaaaaaa-aaaa-4aaa-8aaa-000000000020",
  });
});
test("partial, changed and oversized sets never become editable snapshots", async () => {
  let reads = 0;
  await expect(
    readTargetSnapshot(
      async () => ({ ...rule, revision: ++reads === 1 ? 7 : 8 }),
      async () => ({ items: [], next_cursor: null }),
    ),
  ).rejects.toThrow("changed while");
  await expect(
    readTargetSnapshot(
      async () => rule,
      async (cursor) => {
        if (cursor) throw Error("page failed");
        return { items: [target(0)], next_cursor: "next" };
      },
    ),
  ).rejects.toThrow("page failed");
  await expect(
    readTargetSnapshot(
      async () => rule,
      async () => ({
        items: Array.from({ length: 100 }, (_, i) => target(i)),
        next_cursor: "more",
      }),
    ),
  ).rejects.toThrow("More than 100");
  const exactly = await readTargetSnapshot(
    async () => rule,
    async () => ({
      items: Array.from({ length: 100 }, (_, i) => target(i)),
      next_cursor: null,
    }),
  );
  expect(exactly.draft.rows).toHaveLength(100);
});
test("replacement contains both roles only, normalizes UUIDs and rejects duplicates/scope conflicts", () => {
  const draft: TargetDraft = {
    apply_scope: "selected",
    get_scope: "selected",
    rows: [
      {
        role: "apply",
        kind: "category_id",
        reference: reference.toUpperCase(),
      },
      { role: "get", kind: "variant_id", reference },
    ],
  };
  expect(targetChanges(draft)).toEqual({
    apply_scope: "selected",
    get_scope: "selected",
    targets: [
      { role: "apply", category_id: reference },
      { role: "get", variant_id: reference },
    ],
  });
  draft.rows.push({
    role: "apply",
    kind: "category_id",
    reference: ` ${reference} `,
  });
  expect(() => targetChanges(draft)).toThrow("Duplicate");
  draft.rows.pop();
  draft.apply_scope = "all";
  expect(() => targetChanges(draft)).toThrow("Remove that role");
  draft.apply_scope = "selected";
  draft.rows[0]!.reference = "not-a-uuid";
  expect(() => targetChanges(draft)).toThrow("valid");
});
test("empty selected never silently expands, and expansion is explicit", () => {
  const draft: TargetDraft = {
    apply_scope: "selected",
    get_scope: "selected",
    rows: [],
  };
  expect(targetChanges(draft)).toEqual({
    apply_scope: "selected",
    get_scope: "selected",
    targets: [],
  });
  draft.apply_scope = "all";
  draft.get_scope = "same_as_apply";
  expect(targetChanges(draft)).toEqual({
    apply_scope: "all",
    get_scope: "same_as_apply",
    targets: [],
  });
  draft.rows = Array.from({ length: 101 }, () => ({
    role: "apply",
    kind: "product_id",
    reference,
  }));
  expect(() => targetChanges(draft)).toThrow("At most 100");
});
