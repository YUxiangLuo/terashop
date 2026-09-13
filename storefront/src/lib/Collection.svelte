<script lang="ts">
  import { resolve } from "$app/paths";
  import ProductCard from "./ProductCard.svelte";
  import type { Product } from "./catalog";
  let { title, products }: { title: string; products: Product[] } = $props();
  let sort = $state("featured");
  let sorted = $derived(
    [...products].sort((a, b) =>
      sort === "low"
        ? Math.min(...a.variants.map((v) => Number(v.price))) -
          Math.min(...b.variants.map((v) => Number(v.price)))
        : sort === "name"
          ? a.name.localeCompare(b.name)
          : 0,
    ),
  );
</script>

<svelte:head
  ><title>{title} — Atelier Tera</title><meta
    name="description"
    content={`Explore ${title.toLowerCase()} from the Atelier Tera women's collection.`}
  /></svelte:head
>
<section class="section">
  <p class="eyebrow">THE ATELIER WARDROBE</p>
  <div class="section-heading">
    <h1>{title}</h1>
    <p>{products.length} considered pieces</p>
  </div>
  <div class="collection-toolbar">
    <p>Quiet details. Endless combinations.</p>
    <label
      >Sort by <select bind:value={sort}
        ><option value="featured">Collection order</option><option value="low"
          >Price: low to high</option
        ><option value="name">Name</option></select
      ></label
    >
  </div>
  <div class="product-grid">
    {#each sorted as product (product.id)}<ProductCard {product} />{/each}
  </div>
  {#if !products.length}<p>
      This collection is being prepared. <a href={resolve("/shop/")}
        >Explore all pieces.</a
      >
    </p>{/if}
</section>
