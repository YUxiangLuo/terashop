<script lang="ts">
  import { onMount } from "svelte";
  import { supabase, message, money, dateTime } from "./api";
  import { quoteFilters, type CheckoutQuotePage } from "./quotes";
  let { query }: { query: string } = $props();
  let items = $state.raw<CheckoutQuotePage["items"]>([]),
    cursor = $state<string | null>(null),
    busy = $state(true),
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
      const filters = quoteFilters(query);
      const result = await supabase.rpc("list_admin_checkout_quotes", {
        ...filters,
        page_size: 20,
        ...(cursor ? { after_id: cursor } : {}),
      });
      if (!alive) return;
      if (result.error) throw result.error;
      const data = result.data as unknown as CheckoutQuotePage;
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
  <button onclick={load} disabled={busy}>Retry quotes</button>{/if}
<div class="table-wrap">
  <table>
    <thead
      ><tr
        ><th>Quote</th><th>Customer / order</th><th>Status</th><th
          >Reservation flag</th
        ><th>Total · USD</th><th>Expires</th></tr
      ></thead
    ><tbody>
      {#each items as quote (quote.id)}<tr>
          <td
            ><a class="record-link" href={`/quotes/${quote.id}${query}`}
              >{quote.id}</a
            ><small class="cell-detail">{dateTime(quote.created_at)}</small></td
          >
          <td
            ><a href={`/customers/${quote.customer_id}`}>{quote.customer_id}</a
            >{#if quote.order_id}<a
                class="cell-detail"
                href={`/orders/${quote.order_id}`}>View order</a
              >{:else}<small class="cell-detail">No linked order</small
              >{/if}</td
          >
          <td
            ><span class="badge">{quote.status}</span><small class="cell-detail"
              >Stored: {quote.stored_status}</small
            ></td
          >
          <td>{quote.is_reserved ? "Active flag" : "No active flag"}</td><td
            >{money(quote.total)}</td
          ><td>{dateTime(quote.expires_at)}</td>
        </tr>{/each}
    </tbody>
  </table>
</div>
{#if busy}<p role="status">
    Loading quotes…
  </p>{:else if !items.length && !error}<p>No checkout quotes found.</p>{/if}
<div class="list-footer">
  <span class="small muted">{items.length} loaded · UUID ascending</span
  >{#if cursor}<button onclick={load} disabled={busy}>More quotes</button>{/if}
</div>

<style>
  td {
    max-width: 18rem;
    overflow-wrap: anywhere;
  }
</style>
