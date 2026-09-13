export interface BagLine {
  product_id: string;
  variant_id: string;
  quantity: number;
}
const key = "atelier-tera-bag-v1";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parseBag(value: string | null): BagLine[] {
  try {
    const rows: unknown = JSON.parse(value || "[]");
    if (!Array.isArray(rows) || rows.length > 50) return [];
    const seen = new Set<string>();
    return rows
      .filter((row): row is BagLine => {
        if (
          !row ||
          typeof row !== "object" ||
          typeof row.product_id !== "string" ||
          typeof row.variant_id !== "string" ||
          !uuid.test(row.product_id) ||
          !uuid.test(row.variant_id) ||
          !Number.isInteger(row.quantity) ||
          row.quantity < 1 ||
          row.quantity > 10 ||
          seen.has(row.variant_id)
        )
          return false;
        seen.add(row.variant_id);
        return true;
      })
      .map(({ product_id, variant_id, quantity }) => ({
        product_id,
        variant_id,
        quantity,
      }));
  } catch {
    return [];
  }
}
export const readBag = () => parseBag(localStorage.getItem(key));
export function writeBag(lines: BagLine[]) {
  localStorage.setItem(key, JSON.stringify(lines));
}
export function addToBag(product_id: string, variant_id: string) {
  const lines = readBag();
  const line = lines.find((row) => row.variant_id === variant_id);
  if (line) {
    if (line.quantity >= 10)
      throw new Error("A maximum of 10 of each item can be added.");
    line.quantity++;
  } else {
    if (lines.length >= 50) throw new Error("Your bag is full.");
    lines.push({ product_id, variant_id, quantity: 1 });
  }
  writeBag(lines);
}
