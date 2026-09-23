<script lang="ts">
  import { onMount } from "svelte";
  import { supabase, message, dateTime } from "./api";
  import type { reconciliationPage } from "../../../mcp/src/schemas";
  type Page = typeof reconciliationPage._output;
  let { status }: { status: string } = $props();
  let items = $state.raw<Page["items"]>([]);
  let cursor = $state.raw<Page["next_cursor"]>(null);
  let busy = $state(true),
    error = $state("");
  let alive = true;
  onMount(() => {
    void load();
    return () => {
      alive = false;
    };
  });
  async function load() {
    busy = true;
    error = "";
    try {
      if (status !== "unmatched" && status !== "action_required")
        throw Error(
          "Invalid reconciliation status. Choose unmatched or action_required.",
        );
      const result = await supabase.rpc("list_admin_reconciliation_issues", {
        page_size: 20,
        status_filter: status,
        ...(cursor ? { after_cursor: cursor } : {}),
      });
      if (!alive) return;
      if (result.error) throw result.error;
      const data = result.data as unknown as Page;
      items = [
        ...items,
        ...data.items.filter((row) => !items.some((old) => old.id === row.id)),
      ];
      cursor = data.next_cursor;
    } catch (cause) {
      if (alive) error = message(cause);
    } finally {
      if (alive) busy = false;
    }
  }
</script>

{#if error}<p role="alert" class="notice error">{error}</p>
  <button disabled={busy} onclick={load}>Retry reconciliation read</button>{/if}
<div class="table-wrap">
  <table>
    <thead
      ><tr
        ><th>Movement / created</th><th>Amount · original currency</th><th
          >State</th
        ><th>Order / safe references</th></tr
      ></thead
    >
    <tbody
      >{#each items as item (item.id)}<tr data-record-id={item.id}>
          <td
            >{item.id}<small class="cell-detail"
              >{dateTime(item.created_at)}</small
            ><small class="cell-detail">{item.provider} · {item.kind}</small
            ></td
          >
          <td class="amount">{item.amount} {item.currency}</td>
          <td
            ><span class="badge">{item.reconciliation_status}</span><small
              class="cell-detail"
              >Diagnostic error flag: {item.has_error ? "Yes" : "No"}</small
            ></td
          >
          <td
            >{#if item.order_id}<a href={`/orders/${item.order_id}`}
                >View order</a
              >{:else}<span>No linked order</span>{/if}
            <details>
              <summary>Safe references</summary>
              <p>Event: {item.provider_event_id}</p>
              <p>Payment intent: {item.payment_intent_id ?? "None"}</p>
              <p>Refund request: {item.refund_request_id ?? "None"}</p>
            </details>
          </td>
        </tr>{/each}</tbody
    >
  </table>
</div>
{#if busy}<p role="status">
    Loading reconciliation issues…
  </p>{:else if !error && !items.length}<p>
    No issues found for this status. This does not prove all provider events
    were received or that the system is healthy.
  </p>{/if}
<div class="list-footer">
  <span class="small muted">{items.length} loaded · Oldest created first</span
  >{#if cursor}<button disabled={busy} onclick={load}
      >More reconciliation issues</button
    >{/if}
</div>

<style>
  table {
    min-width: 58rem;
  }
  td {
    max-width: 22rem;
    overflow-wrap: anywhere;
  }
  .amount {
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  details {
    margin-top: 0.5rem;
  }
</style>
