<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
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
    if (!more) {
      applied = { search: search.trim(), status };
      cursor = null;
      products = [];
    }
    try {
      const result = await supabase.rpc("list_admin_products", {
        page_size: 20,
        ...(applied.search ? { search: applied.search } : {}),
        ...(applied.status ? { status_filter: applied.status } : {}),
        ...(more && cursor ? { after_cursor: cursor } : {}),
      });
      if (!alive || current !== request) return;
      if (result.error) throw result.error;
      const page = result.data as unknown as ProductPage;
      products = more
        ? [
            ...products,
            ...page.items.filter(
              (item) => !products.some((old) => old.id === item.id),
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
  function filter(event: SubmitEvent) {
    event.preventDefault();
    void load(false);
  }
</script>

<svelte:head><title>Products · Tera Admin</title></svelte:head>
<div class="page-heading">
  <div>
    <p class="eyebrow">Catalog</p>
    <h1>Products</h1>
    <p class="muted small">A place for every piece in your collection.</p>
  </div>
  <button
    class="primary"
    onclick={() => goto(`/products/${crypto.randomUUID()}?new=1`)}
    >＋ New draft</button
  >
</div>
<section class="card" aria-label="Product catalog">
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
  </form>
  {#if error}<p class="notice error" role="alert">{error}</p>
    <button onclick={() => load(false)}>Retry</button>{/if}
  <div class="table-wrap">
    <table>
      <thead
        ><tr
          ><th scope="col">Product</th><th scope="col">Status</th><th
            scope="col">Price · USD</th
          ><th scope="col">Variants</th></tr
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
            ><td>{product.variant_count}</td></tr
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
    >{#if cursor}<button onclick={() => load(true)} disabled={loading}
        >Load more</button
      >{/if}
  </div>
</section>
