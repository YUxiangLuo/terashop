<script lang="ts">
  import { onMount } from "svelte";
  import { supabase, message } from "./api";
  import { promotionTypes, type Promotion } from "./promotions";
  let {
    search,
    active,
    type,
    code,
    query,
  }: {
    search: string;
    active: string;
    type: string;
    code: string;
    query: string;
  } = $props();
  let items = $state<Promotion[]>([]);
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
      const result = await supabase.rpc("list_admin_promotions", {
        page_size: 20,
        ...(cursor ? { after_id: cursor } : {}),
        ...(search ? { search } : {}),
        ...(active ? { active: active === "yes" } : {}),
        ...(type ? { type_filter: type } : {}),
        ...(code ? { code_only: code === "yes" } : {}),
      });
      if (result.error) throw result.error;
      if (!alive) return;
      const data = result.data as unknown as {
        items: Promotion[];
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
  <button onclick={load} disabled={busy}>Retry promotions</button>{/if}
<div class="table-wrap">
  <table>
    <thead
      ><tr
        ><th>Promotion</th><th>Type</th><th>Code</th><th>Priority</th><th
          >Occupied / limit</th
        ><th>Enabled</th></tr
      ></thead
    >
    <tbody
      >{#each items as item (item.id)}<tr>
          <td
            ><a class="record-link" href={`/promotions/${item.id}${query}`}
              >{item.name}</a
            ></td
          >
          <td>{promotionTypes[item.type]}</td><td>{item.code ?? "Automatic"}</td
          ><td>{item.priority}</td>
          <td>{item.used_count} / {item.usage_limit ?? "Unlimited"}</td>
          <td
            ><span class={["badge", item.is_active ? "active" : "archived"]}
              >{item.is_active ? "Enabled" : "Disabled"}</span
            ></td
          >
        </tr>{/each}</tbody
    >
  </table>
</div>
{#if busy}<p role="status">
    Loading promotions…
  </p>{:else if !items.length && !error}<p class="muted">
    No promotions found.
  </p>{/if}
{#if cursor}<button onclick={load} disabled={busy}>More promotions</button>{/if}
