<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import PromotionList from "$lib/PromotionList.svelte";
  import { promotionTypes } from "$lib/promotions";
  let search = $state(""),
    active = $state(""),
    type = $state(""),
    code = $state("");
  let refresh = $state(0);
  $effect(() => {
    search = page.url.searchParams.get("search") ?? "";
    active = page.url.searchParams.get("active") ?? "";
    type = page.url.searchParams.get("type") ?? "";
    code = page.url.searchParams.get("code") ?? "";
  });
  function apply(event: SubmitEvent) {
    event.preventDefault();
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries({
      search: search.trim(),
      active,
      type,
      code,
    }))
      if (value) params.set(key, value);
    void goto(`/promotions?${params}`);
  }
</script>

<svelte:head><title>Promotions · Tera Admin</title></svelte:head>
<div class="page-heading">
  <div>
    <p class="eyebrow">Checkout configuration</p>
    <h1>Promotions</h1>
    <p class="small muted">
      Discount rules and codes. Existing order snapshots stay unchanged.
    </p>
  </div>
  <div class="actions">
    <button onclick={() => refresh++}>Refresh promotions</button><button
      class="primary"
      onclick={() =>
        goto(
          `/promotions/${crypto.randomUUID()}?new=1&${page.url.search.slice(1)}`,
        )}>New promotion</button
    >
  </div>
</div>
<section class="card">
  <form class="toolbar" onsubmit={apply}>
    <label
      >Search promotions<input
        type="search"
        maxlength="200"
        placeholder="Name or code"
        bind:value={search}
      /></label
    >
    <label
      >Enabled<select id="promotion-active-filter" bind:value={active}
        ><option value="">All</option><option value="yes">Enabled</option
        ><option value="no">Disabled</option></select
      ></label
    >
    <label
      >Rule type<select id="promotion-type-filter" bind:value={type}
        ><option value="">All types</option
        >{#each Object.entries(promotionTypes) as [value, label]}<option {value}
            >{label}</option
          >{/each}</select
      ></label
    >
    <label
      >Entry mode<select id="promotion-code-filter" bind:value={code}
        ><option value="">All modes</option><option value="yes"
          >Discount code</option
        ><option value="no">Automatic</option></select
      ></label
    >
    <button>Apply filters</button>
  </form>
  <p class="small muted">
    Enabled is only the stored flag, not current eligibility. Dates, usage
    limits and cart contents also apply. Occupied counts are not paid sales.
    Pages use ID order, not priority.
  </p>
  {#key `${page.url.search}:${refresh}`}<PromotionList
      search={page.url.searchParams.get("search") ?? ""}
      active={page.url.searchParams.get("active") ?? ""}
      type={page.url.searchParams.get("type") ?? ""}
      code={page.url.searchParams.get("code") ?? ""}
      query={page.url.search}
    />{/key}
</section>
