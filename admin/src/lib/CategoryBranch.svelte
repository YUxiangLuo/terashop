<script lang="ts">
  import { onMount } from "svelte";
  import CategoryBranch from "./CategoryBranch.svelte";
  import { supabase, message } from "./api";
  import {
    sortCategories,
    type Category,
    type CategoryPage,
  } from "./categories";
  let {
    parentId,
    search = "",
    active = "",
    filtered = false,
    returnQuery = "",
  }: {
    parentId?: string;
    search?: string;
    active?: string;
    filtered?: boolean;
    returnQuery?: string;
  } = $props();
  let items = $state<Category[]>([]);
  let cursor = $state<string | null>(null);
  let loading = $state(false);
  let error = $state("");
  let expanded = $state<string[]>([]);
  let alive = true;
  onMount(() => {
    void load();
    return () => {
      alive = false;
    };
  });
  async function load() {
    if (loading) return;
    loading = true;
    error = "";
    try {
      const result = await supabase.rpc("list_admin_categories", {
        page_size: 20,
        ...(cursor ? { after_id: cursor } : {}),
        ...(filtered
          ? {
              ...(search ? { search } : {}),
              ...(active ? { active: active === "yes" } : {}),
            }
          : parentId
            ? { parent_id: parentId }
            : { root_only: true }),
      });
      if (result.error) throw result.error;
      if (!alive) return;
      const page = result.data as unknown as CategoryPage;
      items = sortCategories([
        ...items,
        ...page.items.filter(
          (item) => !items.some((old) => old.id === item.id),
        ),
      ]);
      cursor = page.next_cursor;
    } catch (cause) {
      if (alive) error = message(cause);
    } finally {
      if (alive) loading = false;
    }
  }
</script>

{#if error}<p class="notice error" role="alert">{error}</p>
  <button onclick={load} disabled={loading}>Retry categories</button>{/if}
<ul class="category-tree">
  {#each items as item (item.id)}
    <li>
      <div class="category-node">
        {#if !filtered}<button
            class="quiet"
            aria-expanded={expanded.includes(item.id)}
            aria-label={`Show children of ${item.name}`}
            onclick={() =>
              (expanded = expanded.includes(item.id)
                ? expanded.filter((id) => id !== item.id)
                : [...expanded, item.id])}
            >{expanded.includes(item.id) ? "−" : "+"}</button
          >{/if}
        <div class="grow break-word">
          <a class="record-link" href={`/categories/${item.id}${returnQuery}`}
            >{item.name}</a
          ><small class="cell-detail"
            >/{item.slug} · Position {item.position}</small
          >{#if filtered && item.parent_id}<a
              class="small"
              href={`/categories/${item.parent_id}${returnQuery}`}
              >View parent</a
            >{/if}
        </div>
        <span class={["badge", item.is_active ? "active" : "archived"]}
          >{item.is_active ? "Active" : "Inactive"}</span
        >
      </div>
      {#if !filtered && expanded.includes(item.id)}<CategoryBranch
          parentId={item.id}
          {returnQuery}
        />{/if}
    </li>
  {/each}
</ul>
{#if loading}<p class="small" role="status">
    Loading categories…
  </p>{:else if !items.length && !error}<p class="small muted">
    {parentId ? "No child categories." : "No categories found."}
  </p>{/if}
{#if cursor}<button onclick={load} disabled={loading}
    >Load more categories</button
  >{/if}
