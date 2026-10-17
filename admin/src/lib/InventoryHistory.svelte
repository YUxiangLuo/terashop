<script lang="ts">
  import { onMount } from "svelte";
  import { supabase, message, dateTime, statusLabel } from "./api";
  let { variant, location }: { variant: string; location: string } = $props();
  type Movement = {
    id: string;
    delta: number;
    on_hand_after: number;
    reason: string;
    note: string | null;
    order_id: string | null;
    transfer_id: string | null;
    created_at: string;
  };
  let rows = $state<Movement[]>([]);
  let cursor = $state<string | null>(null);
  let reason = $state("");
  let applied = $state("");
  let busy = $state(false);
  let error = $state("");
  let stale = $state(false);
  let alive = true;
  onMount(() => {
    void load(false);
    return () => {
      alive = false;
    };
  });
  async function load(more: boolean) {
    if (busy) return;
    const requestedReason = more ? applied : reason;
    const requestedCursor = more ? cursor : null;
    busy = true;
    error = "";
    try {
      const result = await supabase.rpc("list_admin_inventory_movements", {
        page_size: 20,
        variant_id: variant,
        location_id: location,
        ...(requestedReason ? { reason_filter: requestedReason } : {}),
        ...(requestedCursor ? { after_id: requestedCursor } : {}),
      });
      if (result.error) throw result.error;
      if (!alive) return;
      const page = result.data as unknown as {
        items: Movement[];
        next_cursor: string | null;
      };
      rows = more
        ? [
            ...rows,
            ...page.items.filter(
              (item) => !rows.some((old) => old.id === item.id),
            ),
          ]
        : page.items;
      cursor = page.next_cursor;
      if (!more) applied = requestedReason;
      stale = false;
    } catch (cause) {
      if (alive) {
        error = message(cause);
        stale = true;
      }
    } finally {
      if (alive) busy = false;
    }
  }
</script>

<section class="inventory-section" aria-label="Inventory movements">
  <div class="section-heading">
    <h2>Movement history</h2>
    <button type="button" disabled={busy} onclick={() => load(false)}
      >Refresh history</button
    >
  </div>
  <p class="small muted">
    Selected variant and location · Newest ID first. “On hand after” is
    historical physical stock, not current availability. Reservations may not
    create movements.
  </p>
  <form
    class="toolbar"
    onsubmit={(event) => {
      event.preventDefault();
      void load(false);
    }}
  >
    <label
      >Movement reason<select bind:value={reason}
        ><option value="">All reasons</option
        >{#each ["order", "cancel", "restock", "adjust", "transfer_out", "transfer_in"] as value}<option
            {value}>{statusLabel(value)}</option
          >{/each}</select
      ></label
    ><button disabled={busy}>Filter history</button>
  </form>
  {#if error}<p class="notice error" role="alert">{error}</p>{/if}
  {#if stale}<p class="notice" role="status">
      Showing the previous movement history. Refresh or retry to check current
      results.
    </p>{/if}
  <div class="table-wrap">
    <table>
      <thead
        ><tr
          ><th scope="col">When / ID</th><th scope="col">Reason / note</th><th
            scope="col"
            class="numeric">Change</th
          ><th scope="col" class="numeric">On hand after</th></tr
        ></thead
      ><tbody>
        {#each rows as row (row.id)}<tr
            ><td
              >{dateTime(row.created_at)}<small class="cell-detail"
                >#{row.id}</small
              ></td
            ><td
              >{statusLabel(row.reason)}{#if row.note}<small
                  class="cell-detail preserve-text">{row.note}</small
                >{/if}{#if row.order_id}<a
                  class="small"
                  href={`/orders/${row.order_id}`}>View order</a
                >{/if}{#if row.transfer_id}<small class="cell-detail break-word"
                  >Transfer {row.transfer_id}</small
                >{/if}</td
            ><td class="numeric">{row.delta > 0 ? "+" : ""}{row.delta}</td><td
              class="numeric">{row.on_hand_after}</td
            ></tr
          >{/each}
      </tbody>
    </table>
  </div>
  {#if busy}<p role="status">
      Loading movements…
    </p>{:else if !rows.length && !error}<p class="empty">
      No movements match this selection.
    </p>{/if}
  {#if cursor}<button
      class="form-action"
      type="button"
      disabled={busy}
      onclick={() => load(true)}>Load older movements</button
    >{/if}
</section>
