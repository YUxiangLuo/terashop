<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import PaymentInbox from "$lib/PaymentInbox.svelte";
  let status = $state(""),
    resource = $state(""),
    refresh = $state(0);
  $effect(() => {
    status = page.url.searchParams.get("status") ?? "";
    resource = page.url.searchParams.get("resource") ?? "";
  });
  function apply(event: SubmitEvent) {
    event.preventDefault();
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (resource.trim()) params.set("resource", resource.trim());
    void goto(`/payment-events?${params}`);
  }
</script>

<svelte:head><title>Payment events · Tera Admin</title></svelte:head>
<div class="page-heading">
  <div>
    <p class="eyebrow">Payment operations · Inbox</p>
    <h1>Payment events</h1>
    <p class="muted">Read-only provider event processing metadata.</p>
  </div>
  <button onclick={() => refresh++}>Refresh events</button>
</div>
<section class="card">
  <form class="toolbar" onsubmit={apply}>
    <label
      >Status<select id="inbox-status" bind:value={status}
        ><option value="">All statuses</option
        >{#each ["received", "processed", "ignored", "failed"] as value}<option
            {value}>{value}</option
          >{/each}</select
      ></label
    >
    <label
      >Linked resource UUID<input
        id="inbox-resource"
        bind:value={resource}
        placeholder="Resource UUID (optional)"
      /></label
    ><button>Apply filters</button>
  </form>
  <p class="notice">
    Resource means a payment intent, transaction, refund request or provider
    movement — not an order or event ID. Clear this filter to include unlinked
    events. There is no exact event-ID search.
  </p>
  <p class="small muted">
    Processing status is not proof of payment or reconciliation. Retry
    exhaustion and error flags are diagnostics, not permission to replay money
    processing; a next-attempt timestamp is not a delivery promise. No raw
    errors or payloads, no replay controls. Pages are not a snapshot; refresh
    starts at the newest records.
  </p>
  {#key `${page.url.search}:${refresh}`}<PaymentInbox
      query={page.url.search}
    />{/key}
</section>
