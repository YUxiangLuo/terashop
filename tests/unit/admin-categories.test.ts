import { expect, test } from "bun:test";
import { sortCategories, type Category } from "../../admin/src/lib/categories";

test("loaded siblings sort by signed position then ID without mutating UUID-page order", () => {
  const items = [
    { id: "b", position: 7 },
    { id: "z", position: -3 },
    { id: "a", position: 7 },
    { id: "c", position: 0 },
  ] as Category[];
  expect(sortCategories(items).map((item) => item.id)).toEqual([
    "z",
    "c",
    "a",
    "b",
  ]);
  expect(items.map((item) => item.id)).toEqual(["b", "z", "a", "c"]);
});
