import type { Json } from "../../../types/database";

export interface McpActionApproval {
  id: string;
  tool_name: string;
  arguments: Record<string, Json>;
  client_id: string;
  resource: string;
  state: string;
  created_at: string;
  expires_at: string;
}
export function actionApprovals(value: Json | null): McpActionApproval[] {
  const uuid = (v: unknown) =>
    typeof v === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    value.some((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return true;
      return (
        !uuid(row.id) ||
        ![
          "refund_paypal",
          "commit_manual_refund",
          "set_user_role",
          "anonymize_customer",
          "anonymize_user",
        ].includes(String(row.tool_name)) ||
        !row.arguments ||
        typeof row.arguments !== "object" ||
        Array.isArray(row.arguments) ||
        typeof row.client_id !== "string" ||
        typeof row.resource !== "string" ||
        !["pending", "approved", "rejected", "consuming", "consumed"].includes(
          String(row.state),
        ) ||
        typeof row.created_at !== "string" ||
        !Number.isFinite(Date.parse(row.created_at)) ||
        typeof row.expires_at !== "string" ||
        !Number.isFinite(Date.parse(row.expires_at))
      );
    })
  )
    throw new Error("Invalid approval response");
  return value as unknown as McpActionApproval[];
}

export function approvalResource(item: McpActionApproval): string | null {
  const field =
    item.tool_name === "anonymize_customer"
      ? "customer_id"
      : ["refund_paypal", "commit_manual_refund"].includes(item.tool_name)
        ? "order_id"
        : null;
  const id = field && item.arguments[field];
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  return `/${field === "customer_id" ? "customers" : "orders"}/${id}`;
}
