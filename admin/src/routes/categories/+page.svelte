<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import CategoryBranch from "$lib/CategoryBranch.svelte";
  let search = $state("");
  let active = $state("");
  let refresh = $state(0);
  $effect(() => {
    search = page.url.searchParams.get("search") ?? "";
    active = page.url.searchParams.get("active") ?? "";
  });
  let query = $derived(page.url.search);
  function apply(event: SubmitEvent) {
    event.preventDefault();
    const params = new URLSearchParams();
    if (search.trim()) params.set("search", search.trim());
    if (active) params.set("active", active);
    void goto(`/categories?${params}`);
  }
</script>

<svelte:head><title>Categories · Tera Admin</title></svelte:head>
<div class="page-heading">
  <div>
    <p class="eyebrow">Catalog structure</p>
    <h1>Categories</h1>
    <p class="small muted">
      Organize the collection without changing product status.
    </p>
  </div>
  <div class="actions">
    <button onclick={() => refresh++}>Refresh tree</button><button
      class="primary"
      onclick={() =>
        goto(`/categories/${crypto.randomUUID()}?new=1&${query.slice(1)}`)}
      >New category</button
    >
  </div>
</div>
<section class="card">
  <form class="toolbar" onsubmit={apply}>
    <label
      >Search categories<input
        type="search"
        bind:value={search}
        maxlength="200"
        placeholder="Name or slug"
      /></label
    ><label
      >Status<select bind:value={active}
        ><option value="">All statuses</option><option value="yes"
          >Active</option
        ><option value="no">Inactive</option></select
      ></label
    ><button>Apply filters</button>
  </form>
  <p class="small muted">
    Without filters, expand each category to load its children. Loaded siblings
    sort by position, then ID; loading another page can change their displayed
    order. Filters show a flat matching list, including children of inactive
    parents.
  </p>
  {#key `${query}:${refresh}`}<CategoryBranch
      search={page.url.searchParams.get("search") ?? ""}
      active={page.url.searchParams.get("active") ?? ""}
      filtered={!!page.url.searchParams.get("search") ||
        !!page.url.searchParams.get("active")}
      returnQuery={query}
    />{/key}
</section>
