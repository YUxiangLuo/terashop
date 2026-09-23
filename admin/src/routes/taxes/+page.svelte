<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import TaxList from "$lib/TaxList.svelte";
  let search = $state("");
  let active = $state("");
  let country = $state("");
  let refresh = $state(0);
  $effect(() => {
    search = page.url.searchParams.get("search") ?? "";
    active = page.url.searchParams.get("active") ?? "";
    country = page.url.searchParams.get("country") ?? "";
  });
  function apply(event: SubmitEvent) {
    event.preventDefault();
    const params = new URLSearchParams();
    if (search.trim()) params.set("search", search.trim());
    if (active) params.set("active", active);
    if (country.trim()) params.set("country", country.trim().toUpperCase());
    void goto(`/taxes?${params}`);
  }
</script>

<svelte:head><title>Tax rates · Tera Admin</title></svelte:head>
<div class="page-heading">
  <div>
    <p class="eyebrow">Checkout configuration</p>
    <h1>Tax rates</h1>
    <p class="small muted">
      Single country rates with an optional fallback. Existing order taxes do
      not change.
    </p>
  </div>
  <div class="actions">
    <button onclick={() => refresh++}>Refresh tax rates</button><button
      class="primary"
      onclick={() =>
        goto(`/taxes/${crypto.randomUUID()}?new=1&${page.url.search.slice(1)}`)}
      >New tax rate</button
    >
  </div>
</div>
<section class="card">
  <form class="toolbar" onsubmit={apply}>
    <label
      >Search rules<input
        type="search"
        maxlength="200"
        bind:value={search}
        placeholder="Rule name"
      /></label
    >
    <label
      >Status<select bind:value={active}
        ><option value="">All statuses</option><option value="yes"
          >Active</option
        ><option value="no">Inactive</option></select
      ></label
    >
    <label
      >Country code<input
        maxlength="2"
        pattern={"[A-Za-z]{2}|\\*"}
        bind:value={country}
        placeholder="US or *"
      /></label
    >
    <button>Apply filters</button>
  </form>
  <p class="small muted">
    Exact country filter: US does not include the * fallback. Pages use ID
    order. This is configuration, not a tax quote or compliance assessment.
  </p>
  {#key `${page.url.search}:${refresh}`}<TaxList
      search={page.url.searchParams.get("search") ?? ""}
      active={page.url.searchParams.get("active") ?? ""}
      country={page.url.searchParams.get("country") ?? ""}
      query={page.url.search}
    />{/key}
</section>
