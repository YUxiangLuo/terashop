<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import QuoteList from "$lib/QuoteList.svelte";
  import { quoteStatuses } from "$lib/quotes";
  let customer = $state(""),
    status = $state(""),
    linked = $state(""),
    refresh = $state(0);
  $effect(() => {
    customer = page.url.searchParams.get("customer") ?? "";
    status = page.url.searchParams.get("status") ?? "";
    linked = page.url.searchParams.get("linked") ?? "";
  });
  function apply(event: SubmitEvent) {
    event.preventDefault();
    const params = new URLSearchParams();
    if (customer.trim()) params.set("customer", customer.trim());
    if (status) params.set("status", status);
    if (linked) params.set("linked", linked);
    void goto(`/quotes?${params}`);
  }
</script>

<svelte:head><title>Checkout quotes · Tera Admin</title></svelte:head>
<div class="page-heading">
  <div>
    <p class="eyebrow">Checkout operations</p>
    <h1>Checkout quotes</h1>
    <p class="muted">Read-only checkout history and linked orders.</p>
  </div>
  <button onclick={() => refresh++}>Refresh quotes</button>
</div>
<section class="card">
  <form class="toolbar" onsubmit={apply}>
    <label
      >Customer UUID<input
        id="quote-customer"
        bind:value={customer}
        placeholder="Optional exact customer UUID"
      /></label
    >
    <label
      >Effective status<select id="quote-status" bind:value={status}
        ><option value="">All statuses</option
        >{#each quoteStatuses as value}<option {value}>{value}</option
          >{/each}</select
      ></label
    >
    <label
      >Linked order<select id="quote-linked" bind:value={linked}
        ><option value="">Any</option><option value="yes">Has order</option
        ><option value="no">No order</option></select
      ></label
    >
    <button>Apply filters</button>
  </form>
  <p class="small muted">
    Status and reservation flags are facts at load time. Expired does not prove
    inventory cleanup has finished. UUID order, not newest first; no cross-page
    snapshot.
  </p>
  {#key `${page.url.search}:${refresh}`}<QuoteList
      query={page.url.search}
    />{/key}
</section>
