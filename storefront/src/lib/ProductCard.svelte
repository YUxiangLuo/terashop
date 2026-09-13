<script lang="ts">
  import { resolve } from "$app/paths";
  import { imageUrl, money, type Product } from "./catalog";
  let { product }: { product: Product } = $props();
  let price = $derived(
    Math.min(...product.variants.map((v) => Number(v.price))),
  );
  let image = $derived(imageUrl(product.images[0]?.url));
</script>

<a
  class="product-card"
  href={resolve("/products/[slug]", { slug: product.slug })}
>
  <div class="product-image">
    {#if image}<img
        src={image}
        alt={product.images[0]?.alt || product.name}
        loading="lazy"
        width="600"
        height="800"
      />{:else}<span>Image coming soon</span>{/if}
    <span class="image-arrow" aria-hidden="true">↗</span>
  </div>
  <div class="card-info">
    <h3>{product.name}</h3>
    <span>{money(price)}</span>
  </div>
  <p>
    {product.options
      .find((option) => option.name === "Color")
      ?.values.map((value) => value.value)
      .join(" / ") || product.product_type}
  </p>
</a>
