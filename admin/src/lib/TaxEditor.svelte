<script lang="ts">
  import { onMount } from "svelte";
  import { beforeNavigate } from "$app/navigation";
  import { page } from "$app/state";
  import { supabase, message } from "./api";
  import { taxRatio, taxPercent, taxCountry, type TaxRate } from "./taxes";
  import { taxReceipt } from "./write-receipts";
  let { id, creating }: { id: string; creating: boolean } = $props();
  let rule = $state.raw<TaxRate | null>(null);
  let fields = $state({
    name: "",
    country: "",
    percent: "",
    include_shipping: false,
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
    return `/taxes${params.size ? `?${params}` : ""}`;
  });
  onMount(() => {
    void load();
    return () => {
      alive = false;
    };
  });
  beforeNavigate(({ cancel }) => {
    if (busy || (dirty && !window.confirm("Discard unsaved tax edits?")))
      cancel();
  });
  function install(value: TaxRate | null) {
    rule = value;
    fields = {
      name: value?.name ?? "",
      country: value?.country ?? "",
      percent: value ? taxPercent(value.rate) : "",
      include_shipping: value?.include_shipping ?? false,
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
      const result = await supabase.rpc("get_admin_tax_rate", {
        tax_rate_id: id,
      });
      if (result.error) throw result.error;
      if (!alive) return;
      const value =
        result.data === null
          ? null
          : (taxReceipt(result.data, id, null) as unknown as TaxRate);
      if (!value && !creating) throw Error("Tax rate not found.");
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
      if (!fields.name.trim()) throw Error("Enter a tax rule name.");
      changes = {
        name: fields.name,
        country: taxCountry(fields.country),
        rate: taxRatio(fields.percent),
        include_shipping: fields.include_shipping,
        is_active: fields.is_active,
      };
    } catch (cause) {
      error = message(cause);
      return;
    }
    if (
      (rule?.is_active || fields.is_active) &&
      !window.confirm(
        "Save changes affecting an active tax rule? New checkout taxes may change. Deactivating a country rule may apply the fallback, not zero tax. Existing orders are unchanged.",
      )
    )
      return;
    busy = true;
    error = "";
    notice = "";
    try {
      const result = rule
        ? await supabase.rpc("update_tax_rate", {
            tax_rate_id: id,
            expected_revision: rule.revision,
            changes,
          })
        : await supabase.rpc("create_tax_rate", { tax_rate_id: id, changes });
      if (result.error) throw result.error;
      if (!alive) return;
      install(
        taxReceipt(
          result.data,
          id,
          rule?.revision ?? null,
        ) as unknown as TaxRate,
      );
      notice =
        "Tax rate saved. Existing order taxes are unchanged; new checkout pricing may require a new quote.";
    } catch (cause) {
      if (alive) {
        uncertain = true;
        error = `${message(cause)} Reload the tax rate before another save; the request may have succeeded.`;
      }
    } finally {
      if (alive) busy = false;
    }
  }
</script>

<svelte:head><title>{rule?.name ?? "Tax rate"} · Tera Admin</title></svelte:head
>
<svelte:window
  onbeforeunload={(event) => {
    if (busy || dirty) event.preventDefault();
  }}
/>
<div class="page-heading">
  <div>
    <a class="small" href={back}>← Tax rates</a>
    <h1>{rule?.name ?? (creating ? "New tax rate" : "Tax rate")}</h1>
  </div>
  <div class="actions">
    <button
      disabled={busy}
      onclick={() => {
        if (
          !dirty ||
          window.confirm("Discard local edits and reload the tax rate?")
        )
          void load();
      }}>Reload tax rate</button
    ><button
      class="primary"
      form="tax-form"
      disabled={busy || !loaded || uncertain || !dirty}>Save tax rate</button
    >
  </div>
</div>
{#if error}<p class="notice error" role="alert">{error}</p>{/if}
{#if notice}<p class="notice" role="status">{notice}</p>{/if}
{#if !loaded}<p role="status">
    {busy ? "Loading tax rate…" : "Unable to open tax rate."}
  </p>{:else}
  <form id="tax-form" onsubmit={save}>
    <fieldset disabled={busy || uncertain}>
      <div class="editor-grid">
        <section class="card fields">
          <h2>Tax rule</h2>
          <label>Name<input required bind:value={fields.name} /></label>
          <label
            >Country code<input
              required
              maxlength="2"
              bind:value={fields.country}
              placeholder="US or *"
            /></label
          >
          <p class="small muted">
            Two-letter country code, or * for the fallback. Codes do not verify
            tax jurisdiction.
          </p>
          <label
            >Tax rate (%)<input
              required
              inputmode="decimal"
              bind:value={fields.percent}
              placeholder="13.00"
            /></label
          >
          <p class="small muted">
            0–100%, at most two decimal places. 13 means 13% (API ratio 0.13).
            Values are never silently rounded.
          </p>
          <label class="check-label"
            ><input type="checkbox" bind:checked={fields.include_shipping} />Tax
            net shipping charges</label
          >
          <label class="check-label"
            ><input type="checkbox" bind:checked={fields.is_active} />Active
            rule</label
          >
          {#if rule}<p class="small muted">Revision {rule.revision}</p>{/if}
        </section>
        <section class="card fields">
          <h2>How rules apply</h2>
          <p>
            Only one active rule per country, including *. A country-specific
            rule takes priority over the fallback; rates do not stack.
          </p>
          <p>
            An active 0% rule overrides the fallback. Deactivating a country
            rule may apply the fallback and does not guarantee zero tax.
          </p>
          <p class="small muted">
            New rules start inactive. Shipping tax applies to net shipping after
            discounts. Changes do not rewrite existing order snapshots.
          </p>
          <p class="small muted">
            No compound or tax-inclusive rates, state/postcode rules, exemptions
            or tax invoices. No deletion or automatic replacement of another
            active rule.
          </p>
        </section>
      </div>
    </fieldset>
  </form>
{/if}
