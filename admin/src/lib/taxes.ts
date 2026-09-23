export interface TaxRate {
  id: string;
  revision: number;
  name: string;
  country: string;
  rate: number;
  include_shipping: boolean;
  is_active: boolean;
  created_at: string;
}

// Parse integer hundredths of a percent before converting to the API ratio.
export function taxRatio(value: string): number {
  const text = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text))
    throw Error(
      "Enter a percentage from 0 to 100 with at most two decimal places; no rounding.",
    );
  const [whole, fraction = ""] = text.split(".");
  const units = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (units > 10000) throw Error("Tax percentage cannot exceed 100.");
  return units / 10000;
}

export function taxPercent(rate: number): string {
  return (rate * 100).toFixed(2);
}

export function taxCountry(value: string): string {
  const country = value.trim().toUpperCase();
  if (!/^(?:[A-Z]{2}|\*)$/.test(country))
    throw Error("Enter a two-letter country code or * for the fallback rule.");
  return country;
}
