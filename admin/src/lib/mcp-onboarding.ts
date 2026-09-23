import type { AdminScope } from "../../../mcp/src/permissions.ts";

const scopes: AdminScope[] = [
  "store:read",
  "store:write",
  "store:payments",
  "store:access",
  "store:privacy",
];

// Public deployment data only. Never derive endpoints from grants or URL parameters.
export function mcpOnboarding(raw: string | undefined) {
  if (!raw?.trim()) return null;
  const invalid = () => {
    throw new Error(
      "Invalid PUBLIC_MCP_CONNECTION: expected resource, issuer and scopes only",
    );
  };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return invalid();
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid();
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(",") !== "issuer,resource,scopes")
    return invalid();
  const endpoint = (input: unknown, resource: boolean) => {
    if (typeof input !== "string" || input.length > 2048) return invalid();
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      return invalid();
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.href !== input && (resource || url.origin !== input)) ||
      (resource && url.pathname === "/")
    )
      return invalid();
    return input;
  };
  const resource = endpoint(v.resource, true);
  const issuer = endpoint(v.issuer, false);
  if (
    !Array.isArray(v.scopes) ||
    !v.scopes.length ||
    !v.scopes.every((s) => scopes.includes(s)) ||
    new Set(v.scopes).size !== v.scopes.length
  )
    return invalid();
  const allowed = scopes.filter((s) => (v.scopes as unknown[]).includes(s));
  const presets = [
    { name: "Read only (recommended)", scopes: ["store:read"] },
    { name: "Routine operations", scopes: ["store:read", "store:write"] },
  ].filter((preset) =>
    preset.scopes.every((s) => allowed.includes(s as AdminScope)),
  );
  return { resource, issuer, scopes: allowed, presets };
}
