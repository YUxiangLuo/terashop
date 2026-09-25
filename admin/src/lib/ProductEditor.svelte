<script lang="ts">
  import { onMount } from "svelte";
  import { beforeNavigate } from "$app/navigation";
  import InventoryEditor from "./InventoryEditor.svelte";
  import VariantEditor from "./VariantEditor.svelte";
  import CategoryPicker from "./CategoryPicker.svelte";
  import ManagedMediaUpload from "./ManagedMediaUpload.svelte";
  import {
    optionChanges,
    parseProductTags,
    validateVariants,
    variantLabel,
    type ProductOption,
  } from "./catalog";
  import {
    getProduct,
    saveProduct,
    message,
    imageUrl,
    type ProductDetail,
    type ProductImage,
    type ProductStatus,
    type ProductVariant,
  } from "./api";
  let { id, creating }: { id: string; creating: boolean } = $props();
  let product = $state.raw<ProductDetail | null>(null);
  let fields = $state({
    name: "",
    slug: "",
    description: "",
    vendor: "",
    product_type: "",
    tags: [] as string[],
    seo_title: "",
    seo_description: "",
  });
  let tagsInput = $state("");
  let tagsEdited = $state(false);
  let images = $state<ProductImage[]>([]);
  let status = $state<ProductStatus>("draft");
  let variants = $state<ProductVariant[]>([]);
  let options = $state<ProductOption[]>([]);
  let categories = $state<ProductDetail["categories"]>([]);
  let loaded = $state(false);
  let busy = $state(false);
  let mediaBusy = $state(false);
  let inventoryUnsettled = $state(false);
  let error = $state("");
  let notice = $state("");
  let uncertain = $state(false);
  let baseline = $state("");
  let alive = true;
  let editable = $derived(loaded && (!!product || creating));
  let dirty = $derived(
    loaded &&
      JSON.stringify({
        fields,
        tagsInput: tagsEdited ? tagsInput : null,
        images,
        status,
        variants,
        options,
        categories,
      }) !== baseline,
  );

  onMount(() => {
    void load();
    return () => {
      alive = false;
    };
  });
  beforeNavigate(({ cancel }) => {
    if (
      (busy || mediaBusy || dirty) &&
      !window.confirm(
        "Leave this page? Unsaved changes will be lost. Uploaded files remain in Storage.",
      )
    )
      cancel();
  });
  function install(value: ProductDetail | null) {
    product = value;
    fields = {
      name: value?.name ?? "",
      slug: value?.slug ?? "",
      description: value?.description ?? "",
      vendor: value?.vendor ?? "",
      product_type: value?.product_type ?? "",
      tags: [...(value?.tags ?? [])],
      seo_title: value?.seo_title ?? "",
      seo_description: value?.seo_description ?? "",
    };
    tagsInput = value?.tags.join(", ") ?? "";
    tagsEdited = false;
    images = value?.images.map((image) => ({ ...image })) ?? [];
    status = value?.status ?? "draft";
    variants = structuredClone(value?.variants ?? []);
    options = structuredClone(value?.options ?? []);
    categories = structuredClone(value?.categories ?? []);
    baseline = JSON.stringify({
      fields,
      tagsInput: null,
      images,
      status,
      variants,
      options,
      categories,
    });
    loaded = true;
    uncertain = false;
  }
  async function load() {
    busy = true;
    error = "";
    notice = "";
    try {
      const value = await getProduct(id);
      if (!alive) return;
      if (!value && !creating)
        throw new Error("Product not found. Return to the product list.");
      install(value);
    } catch (cause) {
      if (alive) error = message(cause);
    } finally {
      if (alive) busy = false;
    }
  }
  function reload() {
    if (inventoryUnsettled) return;
    if (
      !dirty ||
      window.confirm(
        "Discard local edits and load the saved version? Uploaded files are not deleted.",
      )
    )
      void load();
  }
  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (!editable || busy || mediaBusy || inventoryUnsettled || uncertain)
      return;
    try {
      validateVariants(options, variants, status === "active");
    } catch (cause) {
      error = message(cause);
      return;
    }
    if (
      status !== (product?.status ?? "draft") &&
      !window.confirm(
        `Change this product to ${status}? Public API visibility changes immediately. The static storefront needs a rebuild.`,
      )
    )
      return;
    busy = true;
    error = "";
    notice = "";
    try {
      // The URL retains this UUID across refreshes and uncertain create responses.
      const saved = await saveProduct(id, product?.revision ?? null, {
        product: {
          ...fields,
          tags: tagsEdited ? parseProductTags(tagsInput) : fields.tags,
          seo_title: fields.seo_title.trim() || null,
          seo_description: fields.seo_description.trim() || null,
          status,
        },
        ...optionChanges(options, product?.options ?? []),
        category_ids: categories.map((category) => category.id),
        // Metafields have their own revision-checked editor and remain untouched here.
        variants: variants.map(
          ({
            id,
            sku,
            barcode,
            price,
            compare_at_price,
            cost,
            position,
            is_active,
            track_inventory,
          }) => ({
            id,
            sku: sku || null,
            barcode: barcode || null,
            price,
            compare_at_price,
            cost,
            ...(position === undefined ? {} : { position }),
            is_active,
            track_inventory,
          }),
        ),
        variant_options: variants.map(({ id, option_value_ids }) => ({
          id,
          option_value_ids,
        })),
        images: [
          ...images.map((image) => ({
            id: image.id,
            url: image.url,
            alt: image.alt,
            position: image.position,
            variant_id: image.variant_id,
          })),
          ...(product?.images
            .filter((old) => !images.some((image) => image.id === old.id))
            .map((old) => ({ id: old.id, delete: true })) ?? []),
        ],
      });
      if (!alive) return;
      install(saved);
      notice =
        saved.status === "active"
          ? "Product saved and published to the catalog API. Rebuild the static storefront to update its pages."
          : `Product saved as ${saved.status}. It is not visible in the public catalog.`;
    } catch (cause) {
      if (alive) {
        error = `${message(cause)} Reload the saved version before another save; the previous request may have succeeded.`;
        uncertain = true;
      }
    } finally {
      if (alive) busy = false;
    }
  }
  function move(imageId: string, direction: number) {
    const index = images.findIndex((image) => image.id === imageId);
    const target = index + direction;
    if (target < 0 || target >= images.length) return;
    [images[index], images[target]] = [images[target], images[index]];
    images.forEach((image, i) => (image.position = i + 1));
  }
</script>

<svelte:head
  ><title>{product?.name ?? "New draft"} · Tera Admin</title></svelte:head
>
<svelte:window
  onbeforeunload={(event) => {
    if (busy || mediaBusy || dirty) event.preventDefault();
  }}
/>
<div class="page-heading">
  <div>
    <a class="small" href="/">← Products</a>
    <h1>{product?.name ?? "New product"}</h1>
    <p class="muted small">
      {product
        ? `Revision ${product.revision}`
        : "Start with the essentials. Add images after the first save."}
    </p>
  </div>
  <div class="actions">
    {#if product}<a
        class="button"
        href={`/metadata/values?owner_type=product&owner_id=${id}`}
        >Metafields</a
      ><a class="button" href={`/media/public?product=${id}`}>Public media</a
      >{/if}
    <button onclick={reload} disabled={busy || mediaBusy || inventoryUnsettled}
      >Reload saved version</button
    >{#if editable}<button
        class="primary"
        type="submit"
        form="product-form"
        disabled={busy ||
          mediaBusy ||
          inventoryUnsettled ||
          uncertain ||
          !dirty}>{busy ? "Working…" : "Save product"}</button
      >{/if}
  </div>
</div>
{#if error}<p class="notice error" role="alert">{error}</p>{/if}
{#if notice}<p class="notice" role="status">{notice}</p>{/if}
{#if inventoryUnsettled}<p class="notice" role="status">
    Finish or clear the stock adjustment below before editing or reloading
    product details.
  </p>{/if}
{#if !loaded}<p role="status">
    {busy ? "Loading product…" : "Unable to open product."}
  </p>{:else}
  <form id="product-form" onsubmit={save}>
    <fieldset
      disabled={busy ||
        mediaBusy ||
        inventoryUnsettled ||
        !editable ||
        uncertain}
    >
      <div class="editor-grid">
        <div class="editor-main">
          <section class="card">
            <h2>Product details</h2>
            <div class="fields">
              <label
                >Name<input
                  bind:value={fields.name}
                  required
                  maxlength="200"
                  placeholder="e.g. Linen wrap dress"
                /></label
              >
              <label
                >Slug<input
                  bind:value={fields.slug}
                  required
                  pattern="[a-z0-9]+(-[a-z0-9]+)*"
                  maxlength="200"
                  placeholder="linen-wrap-dress"
                /><span class="small muted"
                  >Lowercase letters, numbers and hyphens.</span
                ></label
              >
              <label
                >Description<textarea
                  bind:value={fields.description}
                  rows="5"
                  maxlength="20000"
                  placeholder="Describe the fit, feel and details of this piece."
                ></textarea></label
              >
              <div class="fields two">
                <label
                  >Vendor<input
                    bind:value={fields.vendor}
                    maxlength="200"
                  /></label
                ><label
                  >Product type<input
                    bind:value={fields.product_type}
                    maxlength="200"
                  /></label
                >
              </div>
              <label
                >Tags<input
                  bind:value={tagsInput}
                  maxlength="2000"
                  placeholder="summer, linen, dresses"
                  oninput={() => (tagsEdited = true)}
                /><span class="small muted">Comma-separated.</span></label
              >
            </div>
          </section>
          <section class="card">
            <h2>Search preview</h2>
            <div class="fields">
              <label
                >SEO title<input
                  bind:value={fields.seo_title}
                  maxlength="200"
                /></label
              >
              <label
                >SEO description<textarea
                  bind:value={fields.seo_description}
                  rows="3"
                  maxlength="1000"></textarea></label
              >
              <p class="small muted">
                Blank values use the storefront defaults.
              </p>
            </div>
          </section>
          <VariantEditor
            bind:options
            bind:variants
            productId={product?.id}
            savedIds={product?.variants.map((variant) => variant.id) ?? []}
            onremove={(id) => {
              variants = variants.filter((variant) => variant.id !== id);
              images.forEach((image) => {
                if (image.variant_id === id) image.variant_id = null;
              });
            }}
          />
          <section class="card">
            <h2>Product images</h2>
            <p class="small muted">
              The first image is the primary image. Existing public files stay
              public; removing an image does not delete its bytes.
            </p>
            {#if editable && product}
              <ManagedMediaUpload
                productId={id}
                savedImages={product.images}
                disabled={busy || uncertain || images.length >= 100}
                onbusy={(value) => (mediaBusy = value)}
                onattach={(imageId, url) => {
                  if (
                    busy ||
                    uncertain ||
                    images.length >= 100 ||
                    images.some((image) => image.id === imageId)
                  )
                    return;
                  images.push({
                    id: imageId,
                    url,
                    alt: fields.name,
                    position:
                      Math.max(0, ...images.map((image) => image.position)) + 1,
                    variant_id: null,
                  });
                  notice =
                    "Published image added to form. Save the product to attach it.";
                }}
              />
            {:else}<p class="small muted">
                Save the product first to enable uploads.
              </p>{/if}
            {#each images as image, index (image.id)}
              <div class="image-row">
                {#if imageUrl(image.url)}<img
                    src={imageUrl(image.url)}
                    alt={image.alt}
                  />{:else}<span>Image unavailable</span>{/if}
                <div>
                  <label
                    >Alternative text<input
                      bind:value={image.alt}
                      maxlength="1000"
                    /></label
                  >
                  <p class="small muted">
                    Image {index + 1}{image.variant_id
                      ? " · Variant-specific"
                      : ""}
                  </p>
                  <label
                    >Image assignment<select
                      aria-label={`Image ${index + 1} assignment`}
                      bind:value={image.variant_id}
                      ><option value={null}>All variants</option
                      >{#each variants as variant (variant.id)}<option
                          value={variant.id}
                          >{variantLabel(variant, options)} · {variant.sku ||
                            variant.id.slice(0, 8)}</option
                        >{/each}</select
                    ></label
                  >
                  {#if editable}<div class="actions">
                      <button
                        type="button"
                        aria-label={`Move image ${index + 1} up`}
                        onclick={() => move(image.id, -1)}
                        disabled={index === 0}>↑</button
                      ><button
                        type="button"
                        aria-label={`Move image ${index + 1} down`}
                        onclick={() => move(image.id, 1)}
                        disabled={index === images.length - 1}>↓</button
                      ><button
                        type="button"
                        onclick={() =>
                          (images = images.filter(
                            (item) => item.id !== image.id,
                          ))}>Remove from product</button
                      >
                    </div>{/if}
                </div>
              </div>
            {:else}<p class="empty">No images yet.</p>{/each}
          </section>
        </div>
        <aside class="editor-main">
          <section class="card">
            <h2>Product status</h2>
            <label
              >Visibility<select bind:value={status}>
                <option value="draft">Draft</option><option value="active"
                  >Active</option
                ><option value="archived">Archived</option>
              </select></label
            >
            <p class="small muted">
              Draft and archived products stay out of the public catalog.
              Publishing requires a valid variant. Static storefront pages need
              a rebuild after catalog changes.
            </p>
            <hr />
            <p class="small muted">
              {dirty ? "You have unsaved changes." : "No unsaved changes."}
            </p>
            <p class="small muted">
              Removing an image only removes its product association after
              saving. The Storage file is retained for existing links.
            </p>
          </section>
          <CategoryPicker bind:selected={categories} />
        </aside>
      </div>
    </fieldset>
  </form>
  {#if product}
    <div class="inventory-section" id="inventory">
      {#key product.revision}<InventoryEditor
          {product}
          bind:unsettled={inventoryUnsettled}
          disabled={busy || mediaBusy || dirty || uncertain}
        />{/key}
    </div>
  {/if}
{/if}
