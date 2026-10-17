<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { message, dateTime } from "$lib/api";
  import {
    listCustomers,
    type CustomerPage,
    type CustomerSummary,
  } from "$lib/customers";
  let customers = $state.raw<CustomerSummary[]>([]);
  let cursor = $state.raw<CustomerPage["next_cursor"]>(null);
  let search = $state("");
  let anonymized = $state<"" | "yes" | "no">("");
  let applied = { search: "", anonymized: "" as "" | "yes" | "no" };
  let loading = $state(true);
  let error = $state("");
  let retryMore = false;
  let request = 0;
  let alive = true;
  onMount(() => {
    void load(false);
    return () => {
      alive = false;
      request++;
    };
  });
  async function load(more: boolean) {
    const current = ++request;
    loading = true;
    error = "";
    retryMore = more;
    if (!more) {
      applied = { search: search.trim(), anonymized };
      cursor = null;
      customers = [];
    }
    try {
      const page = await listCustomers({
        ...(applied.search ? { search: applied.search } : {}),
        ...(applied.anonymized
          ? { anonymized: applied.anonymized === "yes" }
          : {}),
        ...(more && cursor ? { after_cursor: cursor } : {}),
      });
      if (!alive || current !== request) return;
      customers = more
        ? [
            ...customers,
            ...page.items.filter(
              (item) => !customers.some((old) => old.id === item.id),
            ),
          ]
        : page.items;
      cursor = page.next_cursor;
    } catch (cause) {
      if (alive && current === request) error = message(cause);
    } finally {
      if (alive && current === request) loading = false;
    }
  }
</script>

<svelte:head><title>Customers · Tera Admin</title></svelte:head>
<div class="page-heading">
  <div>
    <p class="eyebrow">Relationships</p>
    <h1>Customers</h1>
    <p class="small muted">
      Search customer contact records and order history.
    </p>
  </div>
  <div class="actions">
    <button onclick={() => load(false)} disabled={loading}
      >Refresh customers</button
    ><button
      class="primary"
      onclick={() => goto("/customers/new")}
      >New customer</button
    >
  </div>
</div>
<section class="card" aria-label="Customers">
  <form
    class="toolbar"
    onsubmit={(event) => {
      event.preventDefault();
      void load(false);
    }}
  >
    <label
      >Search customers<input
        type="search"
        maxlength="200"
        placeholder="Name, email or phone"
        bind:value={search}
      /></label
    >
    <label
      >Anonymized<select bind:value={anonymized}
        ><option value="">All customers</option><option value="no"
          >Not anonymized</option
        ><option value="yes">Anonymized</option></select
      ></label
    >
    <button disabled={loading}>Apply filters</button>
  </form>
  {#if error}<p class="notice error" role="alert">{error}</p>
    <button onclick={() => load(retryMore)} disabled={loading}>Retry</button
    >{/if}
  <div class="table-wrap">
    <table>
      <thead
        ><tr
          ><th>Customer</th><th>Email</th><th>Phone</th><th>Account</th><th
            >Created</th
          ></tr
        ></thead
      ><tbody>
        {#each customers as customer (customer.id)}<tr
            ><td
              ><a class="record-link" href={`/customers/${customer.id}`}
                >{customer.full_name || "Unnamed customer"}</a
              >{#if customer.anonymized_at}<small class="cell-detail"
                  >Anonymized</small
                >{/if}</td
            ><td class="break-word">{customer.email ?? "—"}</td><td
              >{customer.phone ?? "—"}</td
            ><td>{customer.has_account ? "Yes" : "No"}</td><td
              >{dateTime(customer.created_at)}</td
            ></tr
          >{/each}
      </tbody>
    </table>
  </div>
  {#if loading}<p class="empty" role="status">
      Loading customers…
    </p>{:else if !customers.length && !error}<div class="empty">
      <h2>No customers found</h2>
      <p>Try a different search or filter.</p>
    </div>{/if}
  <div class="list-footer">
    <span class="small muted">{customers.length} loaded · Newest first</span
    >{#if cursor}<button onclick={() => load(true)} disabled={loading}
        >Load more</button
      >{/if}
  </div>
</section>
