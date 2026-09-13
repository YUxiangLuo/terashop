<script lang="ts">
  import ProductDetail from "$lib/ProductDetail.svelte";
  let { data } = $props();
</script>

<svelte:head
  ><title>{data.product.seo_title || data.product.name} — Atelier Tera</title
  ><meta
    name="description"
    content={data.product.seo_description || data.product.description}
  /></svelte:head
>
{#key data.product.id}<ProductDetail product={data.product} />{/key}
