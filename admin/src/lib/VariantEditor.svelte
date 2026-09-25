<script lang="ts">
  import {
    missingVariants,
    variantLabel,
    type ProductOption,
    type ProductVariant,
  } from "./catalog";
  let {
    options = $bindable(),
    variants = $bindable(),
    savedIds,
    onremove,
    productId,
  }: {
    options: ProductOption[];
    variants: ProductVariant[];
    savedIds: string[];
    onremove: (id: string) => void;
    productId?: string;
  } = $props();
  let price = $state<number | undefined>(undefined);
  let feedback = $state("");
  let failed = $state(false);
  function generate() {
    try {
      const added = missingVariants(options, variants, price ?? NaN);
      variants.push(...added);
      feedback = added.length
        ? `${added.length} new variants added. Set SKUs and review before saving.`
        : "All combinations already exist, including inactive variants.";
      failed = false;
    } catch (cause) {
      feedback = (cause as Error).message;
      failed = true;
    }
  }
  function removeOption(option: ProductOption, valueId?: string) {
    if (
      !window.confirm(
        "Remove this option or value? Affected variants will lose these selections. Review combinations before publishing.",
      )
    )
      return;
    const ids = valueId ? [valueId] : option.values.map((value) => value.id);
    variants.forEach((variant) => {
      variant.option_value_ids = variant.option_value_ids.filter(
        (id) => !ids.includes(id),
      );
    });
    if (valueId)
      option.values = option.values.filter((value) => value.id !== valueId);
    else options = options.filter((item) => item.id !== option.id);
  }
  function selectValue(
    variant: ProductVariant,
    option: ProductOption,
    value: string,
  ) {
    variant.option_value_ids = variant.option_value_ids.filter(
      (id) => !option.values.some((item) => item.id === id),
    );
    if (value) variant.option_value_ids.push(value);
  }
</script>

<section class="card">
  <div class="section-heading">
    <h2>Options & variants</h2>
    <button
      type="button"
      onclick={() =>
        options.push({
          id: crypto.randomUUID(),
          name: "",
          position:
            Math.max(-1, ...options.map((option) => option.position)) + 1,
          values: [],
        })}>Add option</button
    >
  </div>
  <p class="small muted">
    Define sizes or colors, then generate missing combinations. Existing SKUs,
    prices and stock are never replaced.
  </p>
  {#each options as option, index (option.id)}
    <div class="variant-row fields">
      <div class="actions">
        <label class="grow"
          >Option name<input
            aria-label={`Option ${index + 1} name`}
            bind:value={option.name}
            required
            maxlength="100"
            placeholder="e.g. Color"
          /></label
        ><button type="button" onclick={() => removeOption(option)}
          >Remove option</button
        >
      </div>
      {#each option.values as value, valueIndex (value.id)}
        <div class="actions">
          <label class="grow"
            >Value {valueIndex + 1}<input
              aria-label={`${option.name || `Option ${index + 1}`} value ${valueIndex + 1}`}
              bind:value={value.value}
              required
              maxlength="100"
              placeholder="e.g. Sage"
            /></label
          ><button
            type="button"
            aria-label={`Remove ${option.name} value ${valueIndex + 1}`}
            onclick={() => removeOption(option, value.id)}>Remove</button
          >
        </div>
      {/each}
      <div>
        <button
          type="button"
          onclick={() =>
            option.values.push({
              id: crypto.randomUUID(),
              value: "",
              position:
                Math.max(-1, ...option.values.map((value) => value.position)) +
                1,
            })}>Add value</button
        >
      </div>
    </div>
  {/each}
  <div class="toolbar variant-row">
    <label
      >New variant price · USD<input
        type="number"
        min="0"
        max="9999999999.99"
        step="0.01"
        bind:value={price}
        placeholder="e.g. 49.00"
      /></label
    >
    <button type="button" onclick={generate}
      >{options.length
        ? "Generate missing combinations"
        : "Add standard variant"}</button
    >
  </div>
  {#if feedback}<p class={["notice", failed ? "error" : ""]} role="status">
      {feedback}
    </p>{/if}
  <p class="small muted">
    {variants.length} variants · Saved variants can be deactivated, preserving order
    history. Turning tracking off does not delete existing stock.
  </p>
  {#each variants as variant, index (variant.id)}
    <div class="variant-row">
      <div class="section-heading">
        <p class="small"><strong>{variantLabel(variant, options)}</strong></p>
        {#if productId && savedIds.includes(variant.id)}
          <a
            href={`/metadata/values?owner_type=variant&owner_id=${variant.id}&product=${productId}`}
            >Variant metafields</a
          >
        {/if}
        {#if !savedIds.includes(variant.id)}<button
            type="button"
            onclick={() => onremove(variant.id)}>Remove new variant</button
          >{/if}
      </div>
      <div class="fields two">
        {#each options as option (option.id)}
          <label
            >{option.name || "Unnamed option"}<select
              aria-label={`Variant ${index + 1} ${option.name}`}
              value={option.values.find((value) =>
                variant.option_value_ids.includes(value.id),
              )?.id ?? ""}
              onchange={(event) =>
                selectValue(variant, option, event.currentTarget.value)}
              ><option value="">Choose a value</option
              >{#each option.values as value (value.id)}<option value={value.id}
                  >{value.value}</option
                >{/each}</select
            ></label
          >
        {/each}
        <label
          >SKU<input
            aria-label={`Variant ${index + 1} SKU`}
            bind:value={variant.sku}
            maxlength="200"
          /></label
        >
        <label
          >Barcode<input
            aria-label={`Variant ${index + 1} barcode`}
            bind:value={variant.barcode}
            maxlength="200"
          /></label
        >
        <label
          >Display position<input
            aria-label={`Variant ${index + 1} position`}
            type="number"
            min="-2147483648"
            max="2147483647"
            step="1"
            bind:value={variant.position}
          /></label
        >
        <label
          >Price · USD<input
            aria-label={`Variant ${index + 1} price`}
            type="number"
            min="0"
            max="9999999999.99"
            step="0.01"
            required
            bind:value={variant.price}
          /></label
        >
        <label
          >Compare-at price · USD<input
            aria-label={`Variant ${index + 1} compare-at price`}
            type="number"
            min="0"
            max="9999999999.99"
            step="0.01"
            value={variant.compare_at_price ?? ""}
            oninput={(event) =>
              (variant.compare_at_price =
                event.currentTarget.value === ""
                  ? null
                  : event.currentTarget.valueAsNumber)}
          /></label
        >
        <label
          >Cost · USD<input
            aria-label={`Variant ${index + 1} cost`}
            type="number"
            min="0"
            max="9999999999.99"
            step="0.01"
            value={variant.cost ?? ""}
            oninput={(event) =>
              (variant.cost =
                event.currentTarget.value === ""
                  ? null
                  : event.currentTarget.valueAsNumber)}
          /></label
        >
      </div>
      <div class="actions">
        <label class="check-label"
          ><input
            type="checkbox"
            aria-label={`Variant ${index + 1} available for sale`}
            bind:checked={variant.is_active}
          />Available for sale</label
        ><label class="check-label"
          ><input
            type="checkbox"
            aria-label={`Variant ${index + 1} track inventory`}
            bind:checked={variant.track_inventory}
          />Track inventory</label
        >
      </div>
    </div>
  {:else}<p class="empty">
      Add a variant before publishing this product.
    </p>{/each}
</section>
