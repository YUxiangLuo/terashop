<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import ReconciliationList from "$lib/ReconciliationList.svelte";
  let status = $state("unmatched"),
    refresh = $state(0);
  $effect(() => {
    status = page.url.searchParams.get("status") ?? "unmatched";
  });
  function apply(event: SubmitEvent) {
    event.preventDefault();
    void goto(`/reconciliation?status=${encodeURIComponent(status)}`);
  }
</script>

<svelte:head><title>Reconciliation issues · Tera Admin</title></svelte:head>
<div class="page-heading">
  <div>
    <p class="eyebrow">Payment operations</p>
    <h1>Reconciliation issues</h1>
    <p class="muted">
      Unresolved provider movements across the store, including those without an
      order.
    </p>
  </div>
  <button onclick={() => refresh++}>Refresh issues</button>
</div>
<section class="card">
  <form class="toolbar" onsubmit={apply}>
    <label
      >Status<select id="reconciliation-status" bind:value={status}
        ><option value="unmatched">Unmatched</option><option
          value="action_required">Action required</option
        ></select
      ></label
    ><button>Apply status</button>
  </form>
  <p class="notice">
    Read-only provider observations, not settled ledger money. Amounts retain
    their original currency and precision; do not combine currencies. No
    automatic matching, payment replay or refunds.
  </p>
  <p class="small muted">
    Each status is queried separately. Records can change between pages; no
    cross-page snapshot. An error flag is not a diagnosis or permission to
    retry. Escalate action-required records to trusted payment operations staff
    using the safe references.
  </p>
  {#key `${page.url.search}:${refresh}`}<ReconciliationList
      status={page.url.searchParams.get("status") ?? "unmatched"}
    />{/key}
</section>
