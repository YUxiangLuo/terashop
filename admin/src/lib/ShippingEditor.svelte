<script lang="ts">
  import { onMount } from "svelte";
  import { beforeNavigate } from "$app/navigation";
  import { page } from "$app/state";
  import { supabase, message } from "./api";
  import {
    shippingMoney,
    shippingCountries,
    type ShippingMethod,
  } from "./shipping";
  let { id, creating }: { id: string; creating: boolean } = $props();
  let method = $state.raw<ShippingMethod | null>(null);
  let fields = $state({
    name: "",
    description: "",
    countries: "",
    price: "",
    free_above: "",
    estimated_days: "",
    position: 0,
    is_active: false,
  });
  let baseline = $state("");
  let loaded = $state(false);
  let busy = $state(false);
  let uncertain = $state(false);
  let error = $state("");
  let notice = $state("");
  let alive = true;
  let dirty = $derived(loaded && JSON.stringify(fields) !== baseline);
  let back = $derived.by(() => {
    const params = new URLSearchParams();
    for (const key of ["search", "active", "country"]) {
      const value = page.url.searchParams.get(key);
      if (value) params.set(key, value);
    }
    return `/shipping${params.size ? `?${params}` : ""}`;
  });
  onMount(() => {
    void load();
    return () => {
      alive = false;
    };
  });
  beforeNavigate(({ cancel }) => {
    if (busy || (dirty && !window.confirm("Discard unsaved shipping edits?")))
      cancel();
  });
  function install(value: ShippingMethod | null) {
    method = value;
    fields = {
      name: value?.name ?? "",
      description: value?.description ?? "",
      countries: value?.countries.join(", ") ?? "",
      price: value ? value.price.toFixed(2) : "",
      free_above: value?.free_above == null ? "" : value.free_above.toFixed(2),
      estimated_days: value?.estimated_days ?? "",
      position: value?.position ?? 0,
      is_active: value?.is_active ?? false,
    };
    baseline = JSON.stringify(fields);
    loaded = true;
    uncertain = false;
  }
  async function load() {
    busy = true;
    error = "";
    notice = "";
    try {
      const result = await supabase.rpc("get_admin_shipping_method", {
        shipping_method_id: id,
      });
      if (result.error) throw result.error;
      if (!alive) return;
      const value = result.data as unknown as ShippingMethod | null;
      if (!value && !creating) throw Error("Shipping method not found.");
      install(value);
    } catch (cause) {
      if (alive) {
        error = message(cause);
        uncertain = true;
      }
    } finally {
      if (alive) busy = false;
    }
  }
  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (busy || !loaded || uncertain) return;
    let changes;
    try {
      changes = {
        ...fields,
        price: shippingMoney(fields.price),
        free_above:
          fields.free_above.trim() === ""
            ? null
            : shippingMoney(fields.free_above),
        countries: shippingCountries(fields.countries),
      };
    } catch (cause) {
      error = message(cause);
      return;
    }
    if (
      (method?.is_active || fields.is_active) &&
      !window.confirm(
        "Save changes to an active shipping method? New checkout pricing and availability may change; existing orders are not repriced.",
      )
    )
      return;
    busy = true;
    error = "";
    notice = "";
    try {
      const result = method
        ? await supabase.rpc("update_shipping_method", {
            shipping_method_id: id,
            expected_revision: method.revision,
            changes,
          })
        : await supabase.rpc("create_shipping_method", {
            shipping_method_id: id,
            changes,
          });
      if (result.error) throw result.error;
      if (!alive) return;
      install(result.data as unknown as ShippingMethod);
      notice =
        "Shipping method saved. Existing order charges are unchanged; changed checkout pricing may require a new quote.";
    } catch (cause) {
      if (alive) {
        uncertain = true;
        error = `${message(cause)} Reload the shipping method before another save; the request may have succeeded.`;
      }
    } finally {
      if (alive) busy = false;
    }
  }
</script>

<svelte:head
  ><title>{method?.name ?? "New shipping method"} · Tera Admin</title
  ></svelte:head
>
<svelte:window
  onbeforeunload={(event) => {
    if (busy || dirty) event.preventDefault();
  }}
/>
<div class="page-heading">
  <div>
    <a class="small" href={back}>← Shipping methods</a>
    <h1>
      {method?.name ?? (creating ? "New shipping method" : "Shipping method")}
    </h1>
  </div>
  <div class="actions">
    <button
      disabled={busy}
      onclick={() => {
        if (
          !dirty ||
          window.confirm("Discard local edits and reload the shipping method?")
        )
          void load();
      }}>Reload shipping method</button
    ><button
      class="primary"
      form="shipping-form"
      disabled={busy || !loaded || uncertain || !dirty}
      >Save shipping method</button
    >
  </div>
</div>
{#if error}<p class="notice error" role="alert">{error}</p>{/if}
{#if notice}<p class="notice" role="status">{notice}</p>{/if}
{#if !loaded}<p role="status">
    {busy ? "Loading shipping method…" : "Unable to open shipping method."}
  </p>{:else}
  <form id="shipping-form" onsubmit={save}>
    <fieldset disabled={busy || uncertain}>
      <div class="editor-grid">
        <section class="card fields">
          <h2>Method details</h2>
          <label>Name<input required bind:value={fields.name} /></label>
          <label
            >Description<textarea rows="3" bind:value={fields.description}
            ></textarea></label
          >
          <label
            >Estimated delivery<input
              bind:value={fields.estimated_days}
              placeholder="3–5 business days"
            /></label
          >
          <p class="small muted">
            Merchant-provided text, not a carrier delivery guarantee.
          </p>
          <div class="fields two">
            <label
              >Display position<input
                type="number"
                required
                min="-2147483648"
                max="2147483647"
                step="1"
                bind:value={fields.position}
              /></label
            ><label class="check-label"
              ><input type="checkbox" bind:checked={fields.is_active} />Active
              method</label
            >
          </div>
          <label
            >Country codes<input
              bind:value={fields.countries}
              placeholder="US, CA"
            /></label
          >
          <p class="small muted">
            Comma-separated two-letter codes. Blank means all countries, not
            disabled. Codes do not verify carrier coverage.
          </p>
        </section>
        <section class="card fields">
          <h2>USD pricing</h2>
          <label
            >Shipping price (USD)<input
              required
              inputmode="decimal"
              bind:value={fields.price}
              placeholder="4.99"
            /></label
          >
          <label
            >Free shipping threshold (USD)<input
              inputmode="decimal"
              bind:value={fields.free_above}
              placeholder="No threshold"
            /></label
          >
          <p class="small muted">
            Blank: no free-shipping threshold. Zero: free shipping for every
            non-negative merchandise net total. Amounts allow at most two
            decimal places; no rounding.
          </p>
          <p class="small muted">
            The threshold includes equality and uses merchandise subtotal after
            product discounts, before shipping and tax.
          </p>
          <p class="small muted">
            New methods start inactive. Changes do not rewrite existing orders.
            No carrier integration or label purchasing.
          </p>
          {#if method}<p class="small muted">Revision {method.revision}</p>{/if}
        </section>
      </div>
    </fieldset>
  </form>
{/if}
