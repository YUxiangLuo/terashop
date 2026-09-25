<script lang="ts">
  import { onMount } from "svelte";
  import { supabase, message, dateTime } from "$lib/api";
  import { reviewPage, type Review } from "$lib/reviews";
  let product = $state(""),
    customer = $state(""),
    status = $state(""),
    rating = $state("");
  let items = $state.raw<Review[]>([]),
    cursor = $state<string | null>(null),
    busy = $state(false),
    error = $state("");
  let applied = { product: "", customer: "", status: "", rating: "" };
  async function load(more = false) {
    if (busy) return;
    busy = true;
    error = "";
    if (!more) {
      applied = { product, customer, status, rating };
      items = [];
      cursor = null;
    }
    try {
      const { data, error: e } = await supabase.rpc("list_admin_reviews", {
        page_size: 50,
        ...(applied.product ? { product_id_filter: applied.product } : {}),
        ...(applied.customer ? { customer_id_filter: applied.customer } : {}),
        ...(applied.status ? { status_filter: applied.status } : {}),
        ...(applied.rating ? { rating_filter: Number(applied.rating) } : {}),
        ...(more && cursor ? { after_id: cursor } : {}),
      });
      if (e) throw e;
      const p = reviewPage(data);
      items = more
        ? [
            ...items,
            ...p.items.filter((x) => !items.some((y) => y.id === x.id)),
          ]
        : p.items;
      cursor = p.next_cursor;
    } catch (e) {
      error = message(e);
    } finally {
      busy = false;
    }
  }
  function apply(e: SubmitEvent) {
    e.preventDefault();
    items = [];
    cursor = null;
    void load();
  }
  onMount(() => {
    void load();
  });
</script>

<svelte:head><title>Reviews · Tera Admin</title></svelte:head>
<div class="page-heading">
  <div>
    <p class="eyebrow">Moderation</p>
    <h1>Reviews</h1>
  </div>
  <button onclick={() => load()} disabled={busy}>Refresh</button>
</div>
<section class="card">
  <form class="toolbar" onsubmit={apply}>
    <label>Product UUID<input bind:value={product} /></label><label
      >Customer UUID<input bind:value={customer} /></label
    ><label
      >Status<select bind:value={status}
        ><option value="">All</option><option>pending</option><option
          >approved</option
        ><option>rejected</option></select
      ></label
    ><label
      >Rating<select bind:value={rating}
        ><option value="">All</option>{#each [1, 2, 3, 4, 5] as n}<option
            value={n}>{n}</option
          >{/each}</select
      ></label
    ><button>Apply filters</button>
  </form>
  <p class="small muted">
    Filters combine with AND. Review text is untrusted and is displayed only as
    text.
  </p>
  {#if error}<p class="notice error" role="alert">{error}</p>{/if}
  <div class="table-wrap">
    <table>
      <thead
        ><tr
          ><th>Review</th><th>Rating</th><th>Status</th><th>Customer</th><th
            >Updated</th
          ></tr
        ></thead
      ><tbody
        >{#each items as r (r.id)}<tr
            ><td
              ><a class="record-link" href={`/reviews/${r.id}`}>{r.title}</a
              ><small class="cell-detail">Product {r.product_id}</small></td
            ><td>{r.rating}/5</td><td>{r.status}</td><td
              ><a href={`/customers/${r.customer_id}`}>{r.customer_id}</a></td
            ><td>{dateTime(r.updated_at)}</td></tr
          >{/each}</tbody
      >
    </table>
  </div>
  {#if busy}<p role="status">
      Loading reviews…
    </p>{:else if !items.length && !error}<p class="empty">
      No reviews found.
    </p>{/if}{#if cursor}<div class="list-footer">
      <span></span><button onclick={() => load(true)}>Load more</button>
    </div>{/if}
</section>
