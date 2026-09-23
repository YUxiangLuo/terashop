export interface McpConnection {
  id: string;
  client_id: string;
  resource: string;
  scopes: string[];
  state: "active" | "revoked";
  created_at: string;
  revoked_at: string | null;
  cleanup: "not_requested" | "pending" | "completed";
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export function connectionPage(value: unknown): {
  items: McpConnection[];
  next_cursor: string | null;
} {
  if (
    !object(value) ||
    !Array.isArray(value.items) ||
    value.items.length > 100 ||
    (value.next_cursor !== null && !uuid(value.next_cursor)) ||
    !value.items.every(
      (item: unknown) =>
        object(item) &&
        uuid(item.id) &&
        typeof item.client_id === "string" &&
        typeof item.resource === "string" &&
        Array.isArray(item.scopes) &&
        item.scopes.every((s: unknown) => typeof s === "string") &&
        (item.state === "active" || item.state === "revoked") &&
        typeof item.created_at === "string" &&
        (item.revoked_at === null || typeof item.revoked_at === "string") &&
        (item.cleanup === "not_requested" ||
          item.cleanup === "pending" ||
          item.cleanup === "completed"),
    )
  ) {
    throw Error(
      "The connection list could not be verified. Refresh before acting.",
    );
  }
  return value as unknown as {
    items: McpConnection[];
    next_cursor: string | null;
  };
}

export function confirmsRevocation(value: unknown, ids: string[]): boolean {
  return (
    object(value) &&
    value.state === "revoked" &&
    Array.isArray(value.ids) &&
    value.ids.every(uuid) &&
    JSON.stringify([...value.ids].sort()) ===
      JSON.stringify([...new Set(ids)].sort())
  );
}
