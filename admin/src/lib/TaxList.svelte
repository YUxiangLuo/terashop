<script lang="ts">
  import { onMount } from "svelte";
  import { supabase, message } from "./api";
  import { taxPercent, type TaxRate } from "./taxes";
  let {
    search,
    active,
    country,
    query,
  }: { search: string; active: string; country: string; query: string } =
    $props();
  let items = $state<TaxRate[]>([]);
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
      const result = await supabase.rpc("list_admin_tax_rates", {
        page_size: 20,
        ...(cursor ? { after_id: cursor } : {}),
        ...(search ? { search } : {}),
        ...(country ? { country } : {}),
        ...(active ? { active: active === "yes" } : {}),
      });
      if (result.error) throw result.error;
      if (!alive) return;
      const data = result.data as unknown as {
        items: TaxRate[];
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
  <button onclick={load} disabled={busy}>Retry tax rates</button>{/if}
<div class="table-wrap">
  <table>
    <thead
      ><tr
        ><th>Rule</th><th>Country</th><th>Rate</th><th>Tax shipping</th><th
          >Status</th
        ></tr
      ></thead
    >
    <tbody
      >{#each items as item (item.id)}<tr>
          <td
            ><a class="record-link" href={`/taxes/${item.id}${query}`}
              >{item.name}</a
            ></td
          >
          <td>{item.country === "*" ? "* · Fallback" : item.country}</td>
          <td>{taxPercent(item.rate)}%</td><td
            >{item.include_shipping ? "Yes" : "No"}</td
          >
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
    Loading tax rates…
  </p>{:else if !items.length && !error}<p class="muted">
    No tax rates found.
  </p>{/if}
{#if cursor}<button onclick={load} disabled={busy}>More tax rates</button>{/if}
