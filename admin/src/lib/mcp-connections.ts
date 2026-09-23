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

export function revocationPreview(value: unknown): McpConnection[] {
  const page = connectionPage(value);
  if (
    page.next_cursor !== null ||
    new Set(page.items.map((item) => item.id)).size !== page.items.length ||
    page.items.some((item) => item.cleanup !== "not_requested")
  )
    throw Error("The complete revocation preview could not be verified.");
  return page.items;
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

export interface ToolCallCursor {
  admitted_at: string;
  id: string;
}
export interface McpToolCall extends ToolCallCursor {
  grant_id: string;
  client_id: string;
  resource: string;
  tool_name: string;
  mutation: boolean;
  finished_at: string | null;
  outcome: "pending" | "returned" | "rejected" | "unknown";
}
const timestamp = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));

export function toolCallPage(value: unknown): {
  items: McpToolCall[];
  next_cursor: ToolCallCursor | null;
} {
  if (
    !object(value) ||
    !Array.isArray(value.items) ||
    value.items.length > 100 ||
    !value.items.every(
      (item: unknown) =>
        object(item) &&
        uuid(item.id) &&
        uuid(item.grant_id) &&
        typeof item.client_id === "string" &&
        typeof item.resource === "string" &&
        typeof item.tool_name === "string" &&
        typeof item.mutation === "boolean" &&
        timestamp(item.admitted_at) &&
        typeof item.outcome === "string" &&
        ["pending", "returned", "rejected", "unknown"].includes(item.outcome) &&
        (item.outcome === "pending"
          ? item.finished_at === null
          : timestamp(item.finished_at)),
    ) ||
    (value.next_cursor !== null &&
      (!object(value.next_cursor) ||
        !uuid(value.next_cursor.id) ||
        !timestamp(value.next_cursor.admitted_at) ||
        !value.items.length ||
        value.next_cursor.id !== value.items.at(-1).id ||
        value.next_cursor.admitted_at !== value.items.at(-1).admitted_at))
  )
    throw Error("The call records could not be verified.");
  // Keep the original timestamp strings, including PostgreSQL microseconds.
  return value as unknown as {
    items: McpToolCall[];
    next_cursor: ToolCallCursor | null;
  };
}
