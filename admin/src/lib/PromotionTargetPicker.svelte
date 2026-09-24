<script lang="ts">
  import { supabase, message } from "./api";
  import type { ProductDetail } from "./api";
  import { variantLabel } from "./catalog";
  import type { TargetDraft } from "./promotion-targets";

  type Kind = TargetDraft["rows"][number]["kind"];
  type Choice = { id: string; label: string; detail: string };
  let { kind, onselect }: { kind: Kind; onselect: (id: string) => void } =
    $props();
  let search = $state("");
  let choices = $state<Choice[]>([]);
  let busy = $state(false);
  let error = $state("");
  let selectedProduct = $state<ProductDetail | null>(null);
  let request = 0;

  $effect(() => {
    kind;
    request++;
    search = "";
    choices = [];
    selectedProduct = null;
    busy = false;
    error = "";
  });

  async function find() {
    if (busy) return;
    const current = ++request;
    const requestedKind = kind;
    busy = true;
    error = "";
    choices = [];
    try {
      if (kind === "category_id") {
        const result = await supabase.rpc("list_admin_categories", {
          page_size: 20,
          ...(search.trim() ? { search: search.trim() } : {}),
        });
        if (result.error) throw result.error;
        if (current !== request || kind !== requestedKind) return;
        choices = (result.data as any).items.map((item: any) => ({
          id: item.id,
          label: item.name,
          detail: `/${item.slug}${item.is_active ? "" : " · Inactive"}`,
        }));
      } else {
        const result = await supabase.rpc("list_admin_products", {
          page_size: 20,
          ...(search.trim() ? { search: search.trim() } : {}),
        });
        if (result.error) throw result.error;
        const products = (result.data as any).items as any[];
        if (current !== request || kind !== requestedKind) return;
        choices = products.map((item) => ({
          id: item.id,
          label: item.name,
          detail: `/${item.slug} · ${item.status}`,
        }));
      }
    } catch (cause) {
      if (current === request) error = message(cause);
    } finally {
      if (current === request) busy = false;
    }
  }
  async function chooseProduct(id: string) {
    if (kind !== "variant_id" || busy) return;
    const current = ++request;
    busy = true;
    error = "";
    try {
      const result = await supabase.rpc("get_admin_product", {
        product_id: id,
      });
      if (result.error) throw result.error;
      if (current !== request || kind !== "variant_id") return;
      selectedProduct = result.data as unknown as ProductDetail;
      choices = [];
    } catch (cause) {
      if (current === request) error = message(cause);
    } finally {
      if (current === request) busy = false;
    }
  }
</script>

<details class="picker">
  <summary
    >Find {kind === "product_id"
      ? "product"
      : kind === "category_id"
        ? "category"
        : "variant"}</summary
  >
  <div class="fields">
    <label
      >Search {kind === "variant_id" ? "products by name" : "catalog"}<input
        type="search"
        bind:value={search}
        maxlength="200"
        onkeydown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void find();
          }
        }}
      /></label
    >
    <button type="button" disabled={busy} onclick={find}>Search</button>
  </div>
  {#if error}<p class="notice error" role="alert">{error}</p>{/if}
  {#if busy}<p class="small" role="status">Searching catalog…</p>{/if}
  {#if kind === "variant_id" && selectedProduct}
    <div class="section-heading">
      <strong>{selectedProduct.name}</strong><button
        type="button"
        onclick={() => (selectedProduct = null)}>Choose another product</button
      >
    </div>
    {#each selectedProduct.variants as variant (variant.id)}
      <button class="choice" type="button" onclick={() => onselect(variant.id)}>
        {variantLabel(variant, selectedProduct!.options)}<small
          >{variant.sku || "No SKU"} · {variant.barcode || "No barcode"} · {variant.is_active
            ? "Active"
            : "Inactive"}</small
        >
      </button>
    {:else}<p class="small muted">This product has no variants.</p>{/each}
  {/if}
  {#each choices as choice (choice.id)}
    <button
      class="choice"
      type="button"
      onclick={() =>
        kind === "variant_id" ? chooseProduct(choice.id) : onselect(choice.id)}
    >
      {choice.label}<small>{choice.detail}</small>
    </button>
  {/each}
  {#if !choices.length && !selectedProduct && !busy && !error}<p
      class="small muted"
    >
      Search to choose a target, or enter its UUID above.
    </p>{/if}
</details>

<style>
  .picker {
    grid-column: 3 / 4;
  }
  .choice {
    display: flex;
    width: 100%;
    justify-content: space-between;
    margin-top: 6px;
    text-align: left;
  }
  .choice small {
    color: var(--muted, #666);
  }
  @media (max-width: 700px) {
    .picker {
      grid-column: 1 / -1;
    }
  }
</style>
