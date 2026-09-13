<script lang="ts">
  import { resolve } from "$app/paths";
  import ProductCard from "$lib/ProductCard.svelte";
  import { imageUrl } from "$lib/catalog";
  let { data } = $props();
  let hero = $derived(
    data.products.find((product) => product.slug === "linen-wrap-dress") ??
      data.products[0],
  );
</script>

<svelte:head
  ><title>Atelier Tera — A considered wardrobe</title><meta
    name="description"
    content="Discover the Atelier Tera sample collection. Dresses, refined knitwear and everyday separates in a considered women's wardrobe."
  /></svelte:head
>
<section class="hero">
  <div class="hero-copy">
    <p class="eyebrow">THE EVERYDAY EDIT · VOL. 01</p>
    <h1>Considered pieces.<br /><em>Everyday ease.</em></h1>
    <p>
      A little structure. A softer silhouette.<br />Discover a wardrobe that
      moves with you.
    </p>
    <a class="button" href={resolve("/shop/")}
      >Explore the collection <span>↗</span></a
    ><span class="hero-note">ATELIER TERA — A STUDY IN SIMPLICITY</span>
  </div>
  <div class="hero-image">
    {#if hero && imageUrl(hero.images[0]?.url)}<img
        src={imageUrl(hero.images[0]?.url)}
        alt={hero.name}
        fetchpriority="high"
        width="1000"
        height="1200"
      /><a href={resolve("/products/[slug]", { slug: hero.slug })}
        >In focus · {hero.name} <span>↗</span></a
      >{/if}
  </div>
</section>
<section class="collection section">
  <div class="section-heading">
    <div>
      <p class="eyebrow">YOUR NEXT EVERYDAY FAVOURITES</p>
      <h2>The considered edit</h2>
    </div>
    <a class="text-link" href={resolve("/shop/")}>Shop all pieces ↗</a>
  </div>
  <div class="product-grid">
    {#each data.products.slice(0, 4) as product (product.id)}<ProductCard
        {product}
      />{/each}
  </div>
</section>
<section class="manifesto">
  <p class="eyebrow">THE ATELIER APPROACH</p>
  <h2>Not more clothes.<br /><em>More possibilities.</em></h2>
  <p>
    Shape, texture and a little room to breathe.<br />Explore pieces that work
    together, and feel like you.
  </p>
  <a class="text-link" href={resolve("/shop/")}>Find your favourites ↗</a>
</section>
