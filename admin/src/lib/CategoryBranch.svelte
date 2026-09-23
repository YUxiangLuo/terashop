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
    refresh = 0,
  }: {
    parentId?: string;
    search?: string;
    active?: string;
    filtered?: boolean;
    returnQuery?: string;
    refresh?: number;
  } = $props();
  let items = $state<Category[]>([]);
  let cursor = $state<string | null>(null);
  let loading = $state(false);
  let error = $state("");
  let expanded = $state<string[]>([]);
  let attempted = $state(0);
  let retryRefresh = $state(false);
  let pages = 1;
  let alive = true;
  onMount(() => {
    void load(true);
    return () => {
      alive = false;
    };
  });
  $effect(() => {
    if (refresh > attempted && !loading) void load(true);
  });
  async function load(reset = false) {
    if (loading) return;
    if (reset) attempted = refresh;
    retryRefresh = reset;
    loading = true;
    error = "";
    try {
      let next = reset ? null : cursor;
      const rows: Category[] = reset ? [] : [...items];
      let readPages = 0;
      do {
        const result = await supabase.rpc("list_admin_categories", {
          page_size: 20,
          ...(next ? { after_id: next } : {}),
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
        rows.push(
          ...page.items.filter(
            (item) => !rows.some((old) => old.id === item.id),
          ),
        );
        next = page.next_cursor;
        readPages++;
      } while (reset && next && readPages < pages);
      // Install only after every previously loaded page was reread successfully.
      items = sortCategories(rows);
      cursor = next;
      pages = reset ? readPages : pages + 1;
      expanded = expanded.filter((id) => rows.some((item) => item.id === id));
      retryRefresh = false;
    } catch (cause) {
      if (alive)
        error = `${message(cause)} Displayed categories may be stale. Retry to check current facts.`;
    } finally {
      if (alive) loading = false;
    }
  }
</script>

{#if error}<p class="notice error" role="alert">{error}</p>
  <button onclick={() => load(retryRefresh)} disabled={loading}
    >Retry categories</button
  >{/if}
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
          {refresh}
        />{/if}
    </li>
  {/each}
</ul>
{#if loading}<p class="small" role="status">
    Loading categories…
  </p>{:else if !items.length && !error}<p class="small muted">
    {parentId ? "No child categories." : "No categories found."}
  </p>{/if}
{#if cursor}<button onclick={() => load()} disabled={loading || retryRefresh}
    >Load more categories</button
  >{/if}
