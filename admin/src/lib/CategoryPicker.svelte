<script lang="ts">
  import { onMount } from "svelte";
  import { supabase, message } from "./api";
  type Category = {
    id: string;
    name: string;
    slug: string;
    is_active?: boolean;
  };
  let { selected = $bindable() }: { selected: Category[] } = $props();
  let items = $state<Category[]>([]);
  let search = $state("");
  let applied = "";
  let cursor = $state<string | null>(null);
  let busy = $state(false);
  let error = $state("");
  let alive = true;
  onMount(() => {
    void load(false);
    return () => {
      alive = false;
    };
  });
  async function load(more: boolean) {
    if (busy) return;
    busy = true;
    error = "";
    if (!more) {
      applied = search.trim();
      cursor = null;
      items = [];
    }
    try {
      const result = await supabase.rpc("list_admin_categories", {
        page_size: 20,
        ...(applied ? { search: applied } : {}),
        ...(more && cursor ? { after_id: cursor } : {}),
      });
      if (result.error) throw result.error;
      if (!alive) return;
      const page = result.data as unknown as {
        items: Category[];
        next_cursor: string | null;
      };
      items = more
        ? [
            ...items,
            ...page.items.filter(
              (item) => !items.some((old) => old.id === item.id),
            ),
          ]
        : page.items;
      cursor = page.next_cursor;
    } catch (cause) {
      if (alive) error = message(cause);
    } finally {
      if (alive) busy = false;
    }
  }
</script>

<section class="card" aria-label="Product categories">
  <h2>Categories</h2>
  <p class="small"><a href="/categories">Manage categories →</a></p>
  <p class="small muted">
    Assignments are saved with the product. Search does not clear your
    selections.
  </p>
  {#each selected as category (category.id)}<div class="category-selection">
      <span class="small break-word"
        >{category.name}<small class="cell-detail">/{category.slug}</small
        ></span
      ><button
        type="button"
        aria-label={`Unassign ${category.name}`}
        onclick={() =>
          (selected = selected.filter((item) => item.id !== category.id))}
        >×</button
      >
    </div>{:else}<p class="small muted">No categories assigned.</p>{/each}
  <div class="fields">
    <label
      >Find categories<input
        type="search"
        maxlength="200"
        bind:value={search}
        onkeydown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void load(false);
          }
        }}
      /></label
    >
    <button type="button" disabled={busy} onclick={() => load(false)}
      >Search categories</button
    >
  </div>
  {#if error}<p class="notice error" role="alert">{error}</p>{/if}
  {#each items as category (category.id)}<label class="check-label"
      ><input
        type="checkbox"
        checked={selected.some((item) => item.id === category.id)}
        onchange={(event) => {
          selected = event.currentTarget.checked
            ? [...selected, category]
            : selected.filter((item) => item.id !== category.id);
        }}
      /><span class="break-word"
        >{category.name}{category.is_active === false
          ? " · Inactive"
          : ""}<small class="cell-detail">/{category.slug}</small></span
      ></label
    >{/each}
  {#if busy}<p class="small" role="status">
      Loading categories…
    </p>{:else if !items.length && !error}<p class="small muted">
      No matching categories.
    </p>{/if}
  {#if cursor}<button
      class="form-action"
      type="button"
      disabled={busy}
      onclick={() => load(true)}>More categories</button
    >{/if}
</section>
