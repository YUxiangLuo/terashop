<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { watchAdminChanges } from "$lib/realtime";
  import {
    supabase,
    message,
    imageUrl,
    type ProductPage,
    type ProductSummary,
    type ProductStatus,
  } from "$lib/api";
  let products = $state.raw<ProductSummary[]>([]);
  let cursor = $state.raw<ProductPage["next_cursor"]>(null);
  let search = $state("");
  let status = $state<ProductStatus | "">("");
  let applied = { search: "", status: "" as ProductStatus | "" };
  let loading = $state(true);
  let error = $state("");
  let live = $state(false);
  let changes = $state(0),
    attempted = $state(0);
  let retry = $state<"filter" | "refresh" | "more">("filter");
  let pages = 1;
  let request = 0;
  let alive = true;
  onMount(() => {
    void load("filter");
    const stop = watchAdminChanges(
      supabase,
      "products",
      () => changes++,
      (value) => (live = value),
    );
    return () => {
      alive = false;
      request++;
      stop();
    };
  });
  $effect(() => {
    if (changes > attempted && !loading) void load("refresh");
  });
  async function load(mode: "filter" | "refresh" | "more") {
    const current = ++request;
    if (mode !== "more") attempted = changes;
    retry = mode;
    loading = true;
    error = "";
    if (mode === "filter") {
      applied = { search: search.trim(), status };
      cursor = null;
      products = [];
      pages = 1;
    }
    try {
      const rows = mode === "more" ? [...products] : [];
      let next = mode === "more" ? cursor : null;
      let readPages = 0;
      do {
        const result = await supabase.rpc("list_admin_products", {
          page_size: 20,
          ...(applied.search ? { search: applied.search } : {}),
          ...(applied.status ? { status_filter: applied.status } : {}),
          ...(next ? { after_cursor: next } : {}),
        });
        if (!alive || current !== request) return;
        if (result.error) throw result.error;
        const page = result.data as unknown as ProductPage;
        rows.push(
          ...page.items.filter(
            (item) => !rows.some((old) => old.id === item.id),
          ),
        );
        next = page.next_cursor;
        readPages++;
      } while (mode === "refresh" && next && readPages < pages);
      products = rows;
      cursor = next;
      pages = mode === "more" ? pages + 1 : readPages;
    } catch (cause) {
      if (alive && current === request)
        error = `${message(cause)} Displayed products may be stale.`;
    } finally {
      if (alive && current === request) loading = false;
    }
  }
  function filter(event: SubmitEvent) {
    event.preventDefault();
    void load("filter");
  }
</script>

<svelte:head><title>Products · Tera Admin</title></svelte:head>
<div class="page-heading">
  <div>
    <p class="eyebrow">Catalog</p>
    <h1>Products</h1>
    <p class="muted small">Manage your collection, pricing and stock.</p>
  </div>
  <button
    class="primary"
    onclick={() => goto(`/products/${crypto.randomUUID()}?new=1`)}
    >＋ New draft</button
  >
</div>
<section class="card" aria-label="Product catalog">
  <p class="small muted">
    {live
      ? "Live product updates connected."
      : "Live product updates unavailable; focus or refresh to check current facts."}
    Updates reread loaded pages; products may move as their update time changes.
  </p>
  <form class="toolbar" onsubmit={filter}>
    <label
      >Search products<input
        type="search"
        placeholder="Search by name or SKU"
        maxlength="200"
        bind:value={search}
      /></label
    >
    <label
      >Status<select bind:value={status}
        ><option value="">All statuses</option><option value="draft"
          >Draft</option
        ><option value="active">Active</option><option value="archived"
          >Archived</option
        ></select
      ></label
    >
    <button disabled={loading}>Apply</button>
    <button type="button" disabled={loading} onclick={() => load("refresh")}
      >Refresh products</button
    >
  </form>
  {#if error}<p class="notice error" role="alert">{error}</p>
    <button
      disabled={loading}
      onclick={() => load(retry === "filter" ? "refresh" : retry)}>Retry</button
    >{/if}
  <div class="table-wrap">
    <table>
      <thead
        ><tr
          ><th scope="col">Product</th><th scope="col">Status</th><th
            scope="col">Price · USD</th
          ><th scope="col">Variants</th><th scope="col">Inventory</th></tr
        ></thead
      ><tbody>
        {#each products as product (product.id)}
          <tr
            ><td
              ><div class="product-cell">
                {#if imageUrl(product.primary_image)}<img
                    class="thumbnail"
                    src={imageUrl(product.primary_image)}
                    alt=""
                  />{:else}<span class="thumbnail" aria-hidden="true"
                  ></span>{/if}
                <div>
                  <a href={`/products/${product.id}`}>{product.name}</a><small
                    >{product.slug}</small
                  >
                </div>
              </div></td
            ><td
              ><span class={["badge", product.status]}>{product.status}</span
              ></td
            ><td
              >{product.price_from === null
                ? "—"
                : new Intl.NumberFormat("en-US", {
                    style: "currency",
                    currency: "USD",
                  }).format(product.price_from)}</td
            ><td>{product.variant_count}</td><td
              ><a href={`/products/${product.id}#inventory`}>Manage stock</a
              ></td
            ></tr
          >
        {/each}
      </tbody>
    </table>
  </div>
  {#if loading}<p class="empty" role="status">
      Loading products…
    </p>{:else if !products.length && !error}<div class="empty">
      <h2>No products found</h2>
      <p>Try another filter, or create your first draft.</p>
    </div>{/if}
  <div class="list-footer">
    <span class="small muted"
      >{products.length} loaded · Most recently updated first</span
    >{#if cursor}<button
        onclick={() => load("more")}
        disabled={loading || !!error}>Load more</button
      >{/if}
  </div>
</section>
