<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import LocationList from "$lib/LocationList.svelte";
  let search = $state("");
  let active = $state("");
  let refresh = $state(0);
  $effect(() => {
    search = page.url.searchParams.get("search") ?? "";
    active = page.url.searchParams.get("active") ?? "";
  });
  function apply(event: SubmitEvent) {
    event.preventDefault();
    const params = new URLSearchParams();
    if (search.trim()) params.set("search", search.trim());
    if (active) params.set("active", active);
    void goto(`/locations?${params}`);
  }
</script>

<svelte:head><title>Warehouses · Tera Admin</title></svelte:head>
<div class="page-heading">
  <div>
    <p class="eyebrow">Inventory configuration</p>
    <h1>Warehouses</h1>
    <p class="small muted">
      Manage stock locations. Configuration changes do not move inventory.
    </p>
  </div>
  <div class="actions">
    <button onclick={() => refresh++}>Refresh warehouses</button><button
      class="primary"
      onclick={() =>
        goto(
          `/locations/${crypto.randomUUID()}?new=1&${page.url.search.slice(1)}`,
        )}>New warehouse</button
    >
  </div>
</div>
<section class="card">
  <form class="toolbar" onsubmit={apply}>
    <label
      >Search warehouses<input
        type="search"
        maxlength="200"
        bind:value={search}
        placeholder="Name or code"
      /></label
    ><label
      >Status<select bind:value={active}
        ><option value="">All statuses</option><option value="yes"
          >Active</option
        ><option value="no">Inactive</option></select
      ></label
    ><button>Apply filters</button>
  </form>
  {#key `${page.url.search}:${refresh}`}<LocationList
      search={page.url.searchParams.get("search") ?? ""}
      active={page.url.searchParams.get("active") ?? ""}
      query={page.url.search}
    />{/key}
</section>
