<script lang="ts">
  import { resolve } from "$app/paths";
  import { onMount } from "svelte";
  import { getProduct, imageUrl, money, type Product } from "./catalog";
  import { addToBag } from "./bag";
  let { product }: { product: Product } = $props();
  let fresh = $state<Product | null>(null);
  let ready = $state(false);
  let busy = $state(false);
  let message = $state("");
  let selected = $state<Record<string, string>>({});
  let displayed = $derived(fresh ?? product);
  let variant = $derived(
    displayed.variants.find((v) =>
      displayed.options.every(
        (o) => selected[o.id] && v.option_value_ids.includes(selected[o.id]),
      ),
    ),
  );
  let price = $derived(
    variant
      ? Number(variant.price)
      : Math.min(...displayed.variants.map((v) => Number(v.price))),
  );
  async function refresh() {
    ready = false;
    try {
      fresh = await getProduct(product.id);
      ready = !!fresh;
      if (!fresh) message = "This piece is no longer available.";
    } catch {
      message = "Unable to check availability. Please retry.";
    }
  }
  onMount(() => {
    void refresh();
  });
  async function add() {
    if (!variant || busy) return;
    const id = variant.id;
    const expectedPrice = Number(variant.price);
    busy = true;
    message = "";
    try {
      const latest = await getProduct(product.id);
      fresh = latest;
      ready = !!latest;
      const current = latest?.variants.find((v) => v.id === id);
      if (!current?.in_stock)
        throw new Error(
          "This selection is no longer available. Please choose another.",
        );
      if (Number(current.price) !== expectedPrice)
        throw new Error(
          "The price has changed. Please review it before adding.",
        );
      addToBag(product.id, id);
      message = "Added to your bag.";
    } catch (error) {
      message =
        error instanceof Error ? error.message : "Unable to add this piece.";
    } finally {
      busy = false;
    }
  }
</script>

<div class="product-detail section">
  <div class="detail-gallery">
    {#each displayed.images as image (image.url)}{#if imageUrl(image.url)}<img
          src={imageUrl(image.url)}
          alt={image.alt || displayed.name}
          width="900"
          height="1200"
        />{/if}{/each}
  </div>
  <div class="detail-copy">
    <a class="eyebrow" href={resolve("/shop/")}>← BACK TO THE COLLECTION</a>
    <p class="eyebrow">{displayed.product_type}</p>
    <h1>{displayed.name}</h1>
    <p class="detail-price">{money(price)} <small>USD</small></p>
    <p class="description">{displayed.description}</p>
    {#each displayed.options as option (option.id)}<fieldset disabled={busy}>
        <legend>{option.name}</legend>
        <div class="option-values">
          {#each option.values as value (value.id)}<button
              type="button"
              class={selected[option.id] === value.id ? "chosen" : ""}
              aria-pressed={selected[option.id] === value.id}
              onclick={() => {
                selected[option.id] = value.id;
                message = "";
              }}>{value.value}</button
            >{/each}
        </div>
      </fieldset>{/each}
    <p class="stock">
      {!ready
        ? "Checking live availability…"
        : !variant
          ? "Choose your options"
          : variant.in_stock
            ? "Available in this selection"
            : "This selection is sold out"}
    </p>
    <button
      class="button full"
      disabled={!ready || !variant?.in_stock || busy}
      onclick={add}>{busy ? "Checking…" : "Add to bag"} <span>↗</span></button
    >
    <p class="status" aria-live="polite">{message}</p>
    {#if !ready}<button class="text-link" onclick={refresh}
        >Retry availability</button
      >{/if}{#if message === "Added to your bag."}<a
        class="text-link"
        href={resolve("/bag/")}>View your bag →</a
      >{/if}
    {#each displayed.metafields.filter((field) => field.key === "material" || field.key === "care_instructions") as field (`${field.namespace}.${field.key}`)}<details
      >
        <summary
          >{field.key === "material"
            ? "Fabric & composition"
            : "Care instructions"}</summary
        >
        <p>
          {Array.isArray(field.value)
            ? field.value.join(", ")
            : String(field.value)}
        </p>
      </details>{/each}
    <p class="fineprint">
      Sample collection · Images are illustrative, not a guarantee of the
      selected colour. Availability is confirmed again at checkout.
    </p>
  </div>
</div>
