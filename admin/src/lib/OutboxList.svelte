<script lang="ts">
  import { onMount } from "svelte";
  import { supabase, message, dateTime } from "./api";
  import type { outboxPage } from "../../../mcp/src/schemas";
  type Page = typeof outboxPage._output;
  let { query }: { query: string } = $props();
  let items = $state.raw<Page["items"]>([]);
  let cursor = $state<string | null>(null);
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
      const params = new URLSearchParams(query);
      const status = params.get("status") ?? "";
      const aggregate = (params.get("aggregate") ?? "").trim();
      if (
        status &&
        !["pending", "processing", "published", "failed", "exhausted"].includes(
          status,
        )
      )
        throw Error("Invalid Outbox status.");
      if (
        aggregate &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          aggregate,
        )
      )
        throw Error("Enter a valid aggregate UUID.");
      const result = await supabase.rpc("list_admin_outbox_events", {
        page_size: 20,
        ...(status ? { status_filter: status } : {}),
        ...(aggregate ? { aggregate_id: aggregate } : {}),
        ...(cursor ? { after_id: cursor } : {}),
      });
      if (!alive) return;
      if (result.error) throw result.error;
      const data = result.data as unknown as Page;
      items = [
        ...items,
        ...data.items.filter((row) => !items.some((old) => old.id === row.id)),
      ];
      cursor = data.next_after_id;
    } catch (cause) {
      if (alive) error = message(cause);
    } finally {
      if (alive) busy = false;
    }
  }
</script>

{#if error}<p role="alert" class="notice error">{error}</p>
  <button disabled={busy} onclick={load}>Retry Outbox read</button>{/if}
<div class="table-wrap">
  <table>
    <thead
      ><tr
        ><th>Event / identity</th><th>Delivery state</th><th
          >Aggregate / diagnostics</th
        ></tr
      ></thead
    >
    <tbody
      >{#each items as item (item.id)}<tr data-record-id={item.id}>
          <td
            >{item.event_type}<small class="cell-detail">Record {item.id}</small
            ><small class="cell-detail">Event {item.event_id}</small><small
              class="cell-detail">Created {dateTime(item.created_at)}</small
            ></td
          >
          <td
            ><span class="badge">{item.status}</span>
            <p>Cumulative attempts: {item.attempts}</p>
            <p>Retry window starts at: {item.retry_start}</p>
            <p>Error flag: {item.has_error ? "Yes" : "No"}</p></td
          >
          <td
            ><p>{item.aggregate_type}</p>
            <a href={`/outbox?aggregate=${item.aggregate_id}`}
              >{item.aggregate_id}</a
            >
            <details>
              <summary>Delivery metadata</summary>
              <p>Available at: {item.available_at}</p>
              <p>
                Lease expires: {item.lease_expires_at ?? "No lease recorded"}
              </p>
              <p>Published at: {item.published_at ?? "Not recorded"}</p>
              <h3>Last redrive audit</h3>
              {#if item.last_redrive}<p>
                  Attempts at redrive: {item.last_redrive.attempts}
                </p>
                <p>Actor: {item.last_redrive.worker_id}</p>
                <p class="reason">Reason: {item.last_redrive.reason}</p>
                <p>Time: {item.last_redrive.created_at}</p>{:else}<p>
                  No redrive recorded.
                </p>{/if}
            </details>
          </td>
        </tr>{/each}</tbody
    >
  </table>
</div>
{#if busy}<p role="status">
    Loading Outbox events…
  </p>{:else if !error && !items.length}<p>
    No Outbox events found for these filters. This is not proof of successful
    delivery or system health.
  </p>{/if}
<div class="list-footer">
  <span class="small muted">{items.length} loaded · Record ID descending</span
  >{#if cursor}<button disabled={busy} onclick={load}>More Outbox events</button
    >{/if}
</div>

<style>
  table {
    min-width: 54rem;
  }
  td {
    max-width: 25rem;
    overflow-wrap: anywhere;
  }
  details {
    margin-top: 0.75rem;
  }
  .reason {
    white-space: pre-wrap;
  }
</style>
