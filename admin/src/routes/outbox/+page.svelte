<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import OutboxList from "$lib/OutboxList.svelte";
  let status = $state(""),
    aggregate = $state(""),
    refresh = $state(0);
  $effect(() => {
    status = page.url.searchParams.get("status") ?? "";
    aggregate = page.url.searchParams.get("aggregate") ?? "";
  });
  function apply(event: SubmitEvent) {
    event.preventDefault();
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (aggregate.trim()) params.set("aggregate", aggregate.trim());
    void goto(`/outbox?${params}`);
  }
</script>

<svelte:head><title>Outbox events · Tera Admin</title></svelte:head>
<div class="page-heading">
  <div>
    <p class="eyebrow">Delivery operations</p>
    <h1>Outbox events</h1>
    <p class="muted">Read-only delivery metadata and latest redrive audit.</p>
  </div>
  <button onclick={() => refresh++}>Refresh Outbox</button>
</div>
<section class="card">
  <form class="toolbar" onsubmit={apply}>
    <label
      >Status<select id="outbox-status" bind:value={status}
        ><option value="">All statuses</option
        >{#each ["pending", "processing", "published", "failed", "exhausted"] as value}<option
            {value}>{value}</option
          >{/each}</select
      ></label
    >
    <label
      >Aggregate UUID<input
        id="outbox-aggregate"
        bind:value={aggregate}
        placeholder="Aggregate UUID (optional)"
      /></label
    ><button>Apply filters</button>
  </form>
  <p class="notice">
    An aggregate identifies the owning resource, not the event UUID or numeric
    record ID. Delivery status does not prove payment or customer receipt.
    Read-only: no claim, acknowledgement or redrive controls.
  </p>
  <p class="small muted">
    Attempt counts are cumulative across retry windows. Use the returned status,
    not a fixed attempt threshold. Lease and availability timestamps do not
    guarantee claimability; audit actors are historical, not the current lease
    holder. No payloads, raw errors or lease tokens. No cross-page snapshot;
    refresh starts from the highest record ID.
  </p>
  {#key `${page.url.search}:${refresh}`}<OutboxList
      query={page.url.search}
    />{/key}
</section>
