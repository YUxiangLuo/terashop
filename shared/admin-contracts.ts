// Pure business constants shared by browser forms and MCP hosts. No SDK, Auth or database client.
export const adminScopes = [
  'store:read',
  'store:write',
  'store:payments',
  'store:access',
  'store:privacy',
] as const;
export type AdminScope = (typeof adminScopes)[number];

export const catalogMoney = { maximum: 9999999999.99, decimalPlaces: 2 } as const;
export const taxRateScale = 10000;

export function isCatalogMoney(value: number): boolean {
  return (
    Number.isFinite(value) &&
    value >= 0 &&
    value <= catalogMoney.maximum &&
    Number(value.toFixed(catalogMoney.decimalPlaces)) === value
  );
}
