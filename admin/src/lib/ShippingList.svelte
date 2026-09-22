<script lang="ts">
  import { onMount } from "svelte";
  import { supabase, message } from "./api";
  import type { ShippingMethod } from "./shipping";
  let {
    search,
    active,
    country,
    query,
  }: { search: string; active: string; country: string; query: string } =
    $props();
  let items = $state<ShippingMethod[]>([]);
  let cursor = $state<string | null>(null);
  let busy = $state(false);
  let error = $state("");
  let alive = true;
  onMount(() => {
    void load();
    return () => {
      alive = false;
    };
  });
  async function load() {
    if (busy) return;
    busy = true;
    error = "";
    try {
      const result = await supabase.rpc("list_admin_shipping_methods", {
        page_size: 20,
        ...(cursor ? { after_id: cursor } : {}),
        ...(search ? { search } : {}),
        ...(country ? { country } : {}),
        ...(active ? { active: active === "yes" } : {}),
      });
      if (result.error) throw result.error;
      if (!alive) return;
      const data = result.data as unknown as {
        items: ShippingMethod[];
        next_cursor: string | null;
      };
      items = [
        ...items,
        ...data.items.filter(
          (item) => !items.some((old) => old.id === item.id),
        ),
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
  <button onclick={load} disabled={busy}>Retry shipping methods</button>{/if}
<div class="table-wrap">
  <table>
    <thead
      ><tr
        ><th>Method</th><th>USD price</th><th>Free above</th><th>Countries</th
        ><th>Position</th><th>Status</th></tr
      ></thead
    >
    <tbody
      >{#each items as item (item.id)}<tr>
          <td
            ><a class="record-link" href={`/shipping/${item.id}${query}`}
              >{item.name}</a
            ><small class="cell-detail">{item.estimated_days}</small></td
          >
          <td>${item.price.toFixed(2)}</td><td
            >{item.free_above === null
              ? "No threshold"
              : `$${item.free_above.toFixed(2)}`}</td
          >
          <td
            >{item.countries.length
              ? item.countries.join(", ")
              : "All countries"}</td
          ><td>{item.position}</td>
          <td
            ><span class={["badge", item.is_active ? "active" : "archived"]}
              >{item.is_active ? "Active" : "Inactive"}</span
            ></td
          >
        </tr>{/each}</tbody
    >
  </table>
</div>
{#if busy}<p role="status">
    Loading shipping methods…
  </p>{:else if !items.length && !error}<p class="muted">
    No shipping methods found.
  </p>{/if}
{#if cursor}<button onclick={load} disabled={busy}>More shipping methods</button
  >{/if}
