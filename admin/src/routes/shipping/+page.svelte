<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import ShippingList from "$lib/ShippingList.svelte";
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
    void goto(`/shipping?${params}`);
  }
</script>

<svelte:head><title>Shipping methods · Tera Admin</title></svelte:head>
<div class="page-heading">
  <div>
    <p class="eyebrow">Checkout configuration</p>
    <h1>Shipping methods</h1>
    <p class="small muted">
      Configure USD rates and destinations. Existing order charges do not
      change.
    </p>
  </div>
  <div class="actions">
    <button onclick={() => refresh++}>Refresh methods</button><button
      class="primary"
      onclick={() =>
        goto(
          `/shipping/${crypto.randomUUID()}?new=1&${page.url.search.slice(1)}`,
        )}>New shipping method</button
    >
  </div>
</div>
<section class="card">
  <form class="toolbar" onsubmit={apply}>
    <label
      >Search methods<input
        type="search"
        maxlength="200"
        bind:value={search}
        placeholder="Method name"
      /></label
    ><label
      >Status<select bind:value={active}
        ><option value="">All statuses</option><option value="yes"
          >Active</option
        ><option value="no">Inactive</option></select
      ></label
    ><label
      >Destination country<input
        maxlength="2"
        pattern={"[A-Za-z]{2}"}
        bind:value={country}
        placeholder="US"
      /></label
    ><button>Apply filters</button>
  </form>
  <p class="small muted">
    Country filtering includes methods serving all countries. Pages use ID
    order, not display position. This list is not a checkout quote.
  </p>
  {#key `${page.url.search}:${refresh}`}<ShippingList
      search={page.url.searchParams.get("search") ?? ""}
      active={page.url.searchParams.get("active") ?? ""}
      country={page.url.searchParams.get("country") ?? ""}
      query={page.url.search}
    />{/key}
</section>
