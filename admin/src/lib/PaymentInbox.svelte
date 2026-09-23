<script lang="ts">
  import { onMount } from "svelte";
  import { supabase, message, dateTime } from "./api";
  import type { providerEventPage } from "../../../mcp/src/schemas";
  type Page = typeof providerEventPage._output;
  let { query }: { query: string } = $props();
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
      const params = new URLSearchParams(query);
      const status = params.get("status") ?? "";
      const resource = (params.get("resource") ?? "").trim();
      if (
        status &&
        !["received", "processed", "ignored", "failed"].includes(status)
      )
        throw Error("Invalid payment event status.");
      if (
        resource &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          resource,
        )
      )
        throw Error("Enter a valid resource UUID, not an order or event ID.");
      const result = await supabase.rpc("list_admin_payment_provider_events", {
        page_size: 20,
        ...(status ? { status_filter: status } : {}),
        ...(resource ? { resource_id: resource } : {}),
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

{#if error}<p class="notice error" role="alert">{error}</p>
  <button onclick={load} disabled={busy}>Retry event read</button>{/if}
<div class="table-wrap">
  <table>
    <thead
      ><tr
        ><th>Event</th><th>Processing state</th><th>Resource / diagnostics</th
        ></tr
      ></thead
    >
    <tbody
      >{#each items as item (item.id)}<tr data-record-id={item.id}>
          <td
            >{item.event_type}<small class="cell-detail">{item.id}</small><small
              class="cell-detail"
              >{item.provider} · {item.source} · {item.livemode
                ? "Live"
                : "Test"}</small
            ><small class="cell-detail"
              >Created {dateTime(item.created_at)}</small
            ></td
          >
          <td
            ><span class="badge">{item.status}</span>
            <p>Attempts: {item.attempts}</p>
            <p>
              Automatic retries exhausted: {item.automatic_retry_exhausted
                ? "Yes"
                : "No"}
            </p>
            <p>Error flag: {item.has_error ? "Yes" : "No"}</p></td
          >
          <td
            >{#if item.resource_id}<p>
                {item.resource_type ?? "Unspecified resource"}
              </p>
              <a href={`/payment-events?resource=${item.resource_id}`}
                >{item.resource_id}</a
              >{:else}<p>No linked resource</p>{/if}
            <details>
              <summary>Event metadata</summary>
              <p>Provider event ID: {item.provider_event_id}</p>
              <p>Occurred: {item.occurred_at}</p>
              <p>Processed: {item.processed_at ?? "Not recorded"}</p>
              <p>Next attempt timestamp: {item.next_attempt_at}</p>
            </details>
          </td>
        </tr>{/each}</tbody
    >
  </table>
</div>
{#if busy}<p role="status">
    Loading payment events…
  </p>{:else if !error && !items.length}<p>
    No payment events found for these filters. This does not prove all provider
    events were received.
  </p>{/if}
<div class="list-footer">
  <span class="small muted">{items.length} loaded · Newest created first</span
  >{#if cursor}<button disabled={busy} onclick={load}
      >More payment events</button
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
</style>
