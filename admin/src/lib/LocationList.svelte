<script lang="ts">
  import { onMount } from "svelte";
  import { supabase, message, type Location } from "./api";
  let {
    search,
    active,
    query,
  }: { search: string; active: string; query: string } = $props();
  let items = $state<Location[]>([]);
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
      const result = await supabase.rpc("list_admin_locations", {
        page_size: 20,
        ...(cursor ? { after_id: cursor } : {}),
        ...(search ? { search } : {}),
        ...(active ? { active: active === "yes" } : {}),
      });
      if (result.error) throw result.error;
      if (!alive) return;
      const data = result.data as unknown as {
        items: Location[];
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
  <button onclick={load} disabled={busy}>Retry warehouses</button>{/if}
<div class="table-wrap">
  <table>
    <thead
      ><tr><th>Warehouse</th><th>Code</th><th>Status</th><th>Default</th></tr
      ></thead
    >
    <tbody
      >{#each items as item (item.id)}<tr>
          <td
            ><a class="record-link" href={`/locations/${item.id}${query}`}
              >{item.name}</a
            ></td
          >
          <td>{item.code}</td><td
            ><span class={["badge", item.is_active ? "active" : "archived"]}
              >{item.is_active ? "Active" : "Inactive"}</span
            ></td
          >
          <td>{item.is_default && item.is_active ? "Default" : "—"}</td>
        </tr>{/each}</tbody
    >
  </table>
</div>
{#if busy}<p role="status">
    Loading warehouses…
  </p>{:else if !items.length && !error}<p class="muted">
    No warehouses found.
  </p>{/if}
{#if cursor}<button onclick={load} disabled={busy}>More warehouses</button>{/if}
