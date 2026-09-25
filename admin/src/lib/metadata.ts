import {
  metafieldOwner,
  metafieldType,
  metafieldDefinitionResult,
  metafieldResult,
  metaobjectDefinitionResult,
  metaobjectResult,
  metadataDeletion,
} from "../../../mcp/src/schemas";
import type { Json } from "../../../types/database";
export const metafieldOwners = metafieldOwner.options;
export const metafieldTypes = metafieldType.options;
export type MetafieldOwner = typeof metafieldOwner._output;
export type MetafieldDefinition = typeof metafieldDefinitionResult._output;
export type Metafield = typeof metafieldResult._output;
export type MetaobjectDefinition = typeof metaobjectDefinitionResult._output;
export type Metaobject = typeof metaobjectResult._output;
export function jsonValue(text: string): Json {
  try {
    return JSON.parse(text);
  } catch {
    throw Error("Value must be valid JSON. Text values need double quotes.");
  }
}
export function jsonObject(text: string, label: string): Record<string, Json> {
  const value = jsonValue(text);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error(`${label} must be a JSON object.`);
  return value as Record<string, Json>;
}
export function receipt<T extends { id: string; revision: number }>(
  value: T,
  id: string,
  previous: number | null,
): T {
  if (
    value.id.toLowerCase() !== id.toLowerCase() ||
    (previous !== null && value.revision < previous)
  )
    throw Error(
      "Unconfirmed metadata identity/version. Reload before editing.",
    );
  return value;
}
export function deletionReceipt(value: unknown, id: string) {
  const parsed = metadataDeletion.parse(value);
  if (parsed.id.toLowerCase() !== id.toLowerCase())
    throw Error(
      "Unconfirmed deletion identity. Read the original record before continuing.",
    );
}
