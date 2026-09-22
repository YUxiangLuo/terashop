<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import InventoryEditor from "$lib/InventoryEditor.svelte";
  import {
    supabase,
    getProduct,
    message,
    type ProductPage,
    type ProductSummary,
    type ProductDetail,
  } from "$lib/api";
  let products = $state<ProductSummary[]>([]);
  let cursor = $state<ProductPage["next_cursor"]>(null);
  let search = $state("");
  let applied = $state("");
  let busy = $state(false);
  let error = $state("");
  let selected = $state.raw<ProductDetail | null>(null);
  let opening = $state(false);
  let detailError = $state("");
  let alive = true;
  onMount(() => {
    void load(false);
    return () => {
      alive = false;
    };
  });
  $effect(() => {
    const id = page.url.searchParams.get("product");
    let current = true;
    selected = null;
    detailError = "";
    opening = !!id;
    if (id)
      void getProduct(id)
        .then((value) => {
          if (!current) return;
          selected = value;
          if (!value)
            detailError = "Product not found. Select another product.";
        })
        .catch((cause) => {
          if (current) detailError = message(cause);
        })
        .finally(() => {
          if (current) opening = false;
        });
    return () => {
      current = false;
    };
  });
  async function load(more: boolean) {
    if (busy) return;
    busy = true;
    error = "";
    if (!more) {
      applied = search.trim();
      products = [];
      cursor = null;
    }
    try {
      const result = await supabase.rpc("list_admin_products", {
        page_size: 10,
        ...(applied ? { search: applied } : {}),
        ...(more && cursor ? { after_cursor: cursor } : {}),
      });
      if (result.error) throw result.error;
      if (!alive) return;
      const data = result.data as unknown as ProductPage;
      products = more
        ? [
            ...products,
            ...data.items.filter(
              (item) => !products.some((old) => old.id === item.id),
            ),
          ]
        : data.items;
      cursor = data.next_cursor;
    } catch (cause) {
      if (alive) error = message(cause);
    } finally {
      if (alive) busy = false;
    }
  }
</script>

<svelte:head><title>Inventory · Tera Admin</title></svelte:head>
<div class="page-heading">
  <div>
    <p class="eyebrow">Stock control</p>
    <h1>Inventory workspace</h1>
    <p class="small muted">
      Find a product, choose its variant and location, then review stock and
      movements.
    </p>
  </div>
</div>
<div class="editor-main">
  <section class="card" aria-label="Find inventory">
    <form
      class="toolbar"
      onsubmit={(event) => {
        event.preventDefault();
        void load(false);
      }}
    >
      <label
        >Search inventory<input
          type="search"
          maxlength="200"
          placeholder="Product name or SKU"
          bind:value={search}
        /></label
      ><button disabled={busy}>Search</button>
    </form>
    <p class="small muted">
      All product statuses · Name or SKU substring search · Stock is loaded for
      the selected product only.
    </p>
    {#if error}<p class="notice error" role="alert">{error}</p>{/if}
    <div class="table-wrap">
      <table>
        <thead
          ><tr
            ><th scope="col">Product</th><th scope="col">Status</th><th
              scope="col">Variants</th
            ><th scope="col">Stock</th></tr
          ></thead
        ><tbody>
          {#each products as product (product.id)}<tr
              ><td
                ><a href={`/products/${product.id}`}>{product.name}</a><small
                  class="cell-detail">{product.slug}</small
                ></td
              ><td
                ><span class={["badge", product.status]}>{product.status}</span
                ></td
              ><td>{product.variant_count}</td><td
                ><button
                  aria-label={`Manage stock for ${product.name}`}
                  onclick={() =>
                    goto(`/inventory?product=${product.id}#stock-detail`)}
                  disabled={opening}
                  >{selected?.id === product.id
                    ? "Selected"
                    : "Manage stock"}</button
                ></td
              ></tr
            >{/each}
        </tbody>
      </table>
    </div>
    {#if busy}<p role="status">
        Loading products…
      </p>{:else if !products.length && !error}<p class="empty">
        No products found. Try another name or SKU.
      </p>{/if}
    {#if cursor}<button
        class="form-action"
        disabled={busy}
        onclick={() => load(true)}>Load more products</button
      >{/if}
  </section>
  <div id="stock-detail" class="stock-detail">
    {#if opening}<p role="status">Opening stock…</p>{:else if detailError}<p
        class="notice error"
        role="alert"
      >
        {detailError}
      </p>
      <button
        onclick={() =>
          goto(
            `/inventory?product=${page.url.searchParams.get("product")}&retry=${Date.now()}#stock-detail`,
          )}>Retry opening product</button
      >{:else if selected}
      <div class="section-heading">
        <h2>{selected.name}</h2>
        <a class="small" href={`/products/${selected.id}`}>Edit product →</a>
      </div>
      <div class="inventory-section">
        {#key selected}<InventoryEditor
            product={selected}
            preferredSku={applied}
          />{/key}
      </div>
    {:else}<p class="empty">Select a product to manage its inventory.</p>{/if}
  </div>
</div>
