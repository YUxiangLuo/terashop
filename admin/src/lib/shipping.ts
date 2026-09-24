import { catalogMoney } from "../../../shared/admin-contracts";

export interface ShippingMethod {
  id: string;
  revision: number;
  name: string;
  description: string;
  countries: string[];
  price: number;
  free_above: number | null;
  estimated_days: string;
  position: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export function shippingMoney(value: string): number {
  const text = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text))
    throw Error(
      "Enter a non-negative USD amount with at most two decimal places.",
    );
  const amount = Number(text);
  if (amount > catalogMoney.maximum)
    throw Error("USD amounts cannot exceed 9999999999.99.");
  return amount;
}

export function shippingCountries(value: string): string[] {
  if (!value.trim()) return [];
  const countries = value.split(",").map((code) => code.trim().toUpperCase());
  if (countries.some((code) => !/^[A-Z]{2}$/.test(code)))
    throw Error(
      "Use comma-separated two-letter country codes, or leave blank for all countries.",
    );
  return [...new Set(countries)];
}
