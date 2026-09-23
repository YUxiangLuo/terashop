<script lang="ts">
  import { onMount } from "svelte";
  import { beforeNavigate } from "$app/navigation";
  import { page } from "$app/state";
  import { supabase, message } from "./api";
  import {
    promotionTypes,
    promotionParameters,
    promotionFields,
    promotionChanges,
    type Promotion,
  } from "./promotions";
  import PromotionRecords from "./PromotionRecords.svelte";
  import { promotionReceipt } from "./write-receipts";
  let { id, creating }: { id: string; creating: boolean } = $props();
  let rule = $state.raw<Promotion | null>(null);
  let fields = $state(promotionFields(null));
  let baseline = $state("");
  let loaded = $state(false),
    busy = $state(false),
    uncertain = $state(false);
  let error = $state(""),
    notice = $state("");
  let kind = $state<"targets" | "redemptions">("targets"),
    role = $state(""),
    recordsVersion = $state(0);
  let alive = true;
  let dirty = $derived(loaded && JSON.stringify(fields) !== baseline);
  let back = $derived.by(() => {
    const params = new URLSearchParams();
    for (const key of ["search", "active", "type", "code"]) {
      const value = page.url.searchParams.get(key);
      if (value) params.set(key, value);
    }
    return `/promotions${params.size ? `?${params}` : ""}`;
  });
  onMount(() => {
    void load();
    return () => {
      alive = false;
    };
  });
  beforeNavigate(({ cancel }) => {
    if (busy || (dirty && !window.confirm("Discard unsaved promotion edits?")))
      cancel();
  });
  function install(value: Promotion | null) {
    rule = value;
    fields = promotionFields(value);
    baseline = JSON.stringify(fields);
    loaded = true;
    uncertain = false;
    recordsVersion++;
  }
  async function load() {
    busy = true;
    error = "";
    notice = "";
    try {
      const result = await supabase.rpc("get_admin_promotion", {
        promotion_id: id,
      });
      if (result.error) throw result.error;
      if (!alive) return;
      const value =
        result.data === null
          ? null
          : (promotionReceipt(result.data, id, null) as unknown as Promotion);
      if (!value && !creating) throw Error("Promotion not found.");
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
      changes = promotionChanges(fields, rule);
    } catch (cause) {
      error = message(cause);
      return;
    }
    if (
      (rule?.is_active || fields.is_active) &&
      !window.confirm(
        "Save changes affecting an enabled promotion? Checkout discounts and old quotes may change. New item and buy/get rules apply to all products. Existing orders are unchanged.",
      )
    )
      return;
    busy = true;
    error = "";
    notice = "";
    try {
      const result = rule
        ? await supabase.rpc("update_promotion", {
            promotion_id: id,
            expected_revision: rule.revision,
            changes,
          })
        : await supabase.rpc("create_promotion", { promotion_id: id, changes });
      if (result.error) throw result.error;
      if (!alive) return;
      install(
        promotionReceipt(
          result.data,
          id,
          rule?.revision ?? null,
        ) as unknown as Promotion,
      );
      notice = "Promotion saved. Existing order snapshots are unchanged.";
    } catch (cause) {
      if (alive) {
        uncertain = true;
        error = `${message(cause)} Reload the promotion and review its saved values before another save. If the response was lost, the write may have succeeded.`;
      }
    } finally {
      if (alive) busy = false;
    }
  }
</script>

<svelte:head
  ><title>{rule?.name ?? "Promotion"} · Tera Admin</title></svelte:head
>
<svelte:window
  onbeforeunload={(event) => {
    if (busy || dirty) event.preventDefault();
  }}
/>
<div class="page-heading">
  <div>
    <a class="small" href={back}>← Promotions</a>
    <h1>{rule?.name ?? (creating ? "New promotion" : "Promotion")}</h1>
  </div>
  <div class="actions">
    <button
      disabled={busy}
      onclick={() => {
        if (
          !dirty ||
          window.confirm("Discard local edits and reload the promotion?")
        )
          void load();
      }}>Reload promotion</button
    ><button
      class="primary"
      form="promotion-form"
      disabled={busy || !loaded || uncertain || !dirty}>Save promotion</button
    >
  </div>
</div>
{#if error}<p class="notice error" role="alert">{error}</p>{/if}
{#if notice}<p class="notice" role="status">{notice}</p>{/if}
{#if !loaded}<p role="status">
    {busy ? "Loading promotion…" : "Unable to open promotion."}
  </p>{:else}
  <form id="promotion-form" onsubmit={save}>
    <fieldset disabled={busy || uncertain}>
      <div class="editor-grid">
        <section class="card fields">
          <h2>Discount rule</h2>
          <label>Name<input required bind:value={fields.name} /></label>
          <label
            >Discount code<input
              bind:value={fields.code}
              placeholder="Blank for automatic promotion"
            /></label
          >
          <p class="small muted">
            Codes are uppercased. Blank means automatic, not disabled.
          </p>
          <label
            >Rule type<select
              id="promotion-type"
              value={fields.type}
              disabled={!!rule}
              onchange={(event) => {
                fields.type = event.currentTarget.value as typeof fields.type;
                fields.parameters = {};
              }}
              >{#each Object.entries(promotionTypes) as [value, label]}<option
                  {value}>{label}</option
                >{/each}</select
            ></label
          >
          <p class="small muted">
            Type is fixed after creation. Create another rule to change the
            discount algorithm.
          </p>
          {#each promotionParameters[fields.type] as parameter (parameter.key)}<label
              >{parameter.label}<input
                required={!parameter.optional}
                inputmode="decimal"
                bind:value={fields.parameters[parameter.key]}
                placeholder={parameter.optional ? "Default" : "Required"}
              /></label
            >{/each}
          <p class="small muted">
            Percentages must be greater than 0 and at most 100, not a 0–1 ratio.
            Quantity values are positive integers. Optional blanks remove that
            parameter.
          </p>
          {#if fields.type === "order_percentage" || fields.type === "order_fixed"}<p
              class="small muted"
            >
              Blank minimum subtotal defaults to 0. It uses merchandise subtotal
              before discounts, excluding shipping and tax.
            </p>
          {:else if fields.type === "item_percentage"}<p class="small muted">
              Blank minimum quantity means no minimum. Only matching items
              count.
            </p>
          {:else if fields.type === "buy_x_get_y"}<p class="small muted">
              Blank gift discount means 100% off. Purchase and gift units are
              distinct; cheapest matching gift units are selected.
            </p>
          {:else}<p class="small muted">
              Free shipping has no editable parameters and applies only when
              shipping has a positive charge.
            </p>{/if}
          <label
            >Priority<input
              required
              inputmode="numeric"
              bind:value={fields.priority}
            /></label
          >
          <p class="small muted">
            Lower values are considered first. Non-stackable rules exclude other
            applied promotions.
          </p>
          <label class="check-label"
            ><input type="checkbox" bind:checked={fields.stackable} />Allow
            stacking</label
          >
          {#if rule}<details>
              <summary>Stored parameters (read-only)</summary>
              <pre>{JSON.stringify(rule.params, null, 2)}</pre>
              <p class="small muted">
                Unedited keys are preserved, not interpreted as additional
                supported conditions.
              </p>
            </details>{/if}
        </section>
        <section class="card fields">
          <h2>Availability and limits</h2>
          <label class="check-label"
            ><input
              type="checkbox"
              bind:checked={fields.is_active}
            />Enabled</label
          >
          <p class="small muted">
            New rules start disabled. Enabled does not prove current cart
            eligibility.
          </p>
          <label
            >Starts at<input
              bind:value={fields.starts_at}
              placeholder="2026-10-01T09:00:00+08:00"
            /></label
          >
          <label
            >Ends at<input
              bind:value={fields.ends_at}
              placeholder="2026-10-31T23:59:59+08:00"
            /></label
          >
          <p class="small muted">
            ISO timestamps with seconds and Z or an explicit offset. No
            browser-timezone conversion; unchanged timestamp precision is
            preserved. Blank removes that boundary.
          </p>
          <label
            >Total usage limit<input
              inputmode="numeric"
              bind:value={fields.usage_limit}
              placeholder="Unlimited"
            /></label
          >
          <label
            >Per-customer code limit<input
              required
              inputmode="numeric"
              bind:value={fields.per_customer_limit}
            /></label
          >
          <p class="small muted">
            Per-customer limits apply to discount codes. Occupied count includes
            automatic promotions and may precede payment; it is not paid sales.
          </p>
          <p>Recorded occupied count: {rule?.used_count ?? 0}</p>
          <h2>Target scope · read-only</h2>
          <p>
            Apply: {rule?.apply_scope ?? "all"} · Get: {rule?.get_scope ??
              "same_as_apply"}
          </p>
          <p class="small muted">
            Scopes affect item percentage and buy/get rules; order discounts and
            free shipping keep their whole-order semantics. New item and buy/get
            rules apply to all products. For a targeted offer, save it disabled,
            edit its targets, then enable it. Rule-detail saves do not replace
            targets or scopes.
          </p>
          {#if rule && (rule.type === "item_percentage" || rule.type === "buy_x_get_y")}
            <a href={`/promotions/${rule.id}/targets${page.url.search}`}
              >Edit targets and scope →</a
            >
          {/if}
          {#if rule}<p class="small muted">
              Revision {rule.revision}. Checkout usage and target edits also
              change the revision.
            </p>{/if}
        </section>
      </div>
    </fieldset>
  </form>
  {#if rule}<section class="card">
      <div class="page-heading">
        <h2>Promotion records · read-only</h2>
        <button onclick={() => recordsVersion++}>Refresh records</button>
      </div>
      <div class="toolbar">
        <label
          >Record type<select id="promotion-record-kind" bind:value={kind}
            ><option value="targets">Configured targets</option><option
              value="redemptions">Code redemptions</option
            ></select
          ></label
        >
        {#if kind === "targets"}<label
            >Target role<select id="promotion-target-role" bind:value={role}
              ><option value="">All roles</option><option value="apply"
                >Apply</option
              ><option value="get">Get</option></select
            ></label
          >{/if}
      </div>
      <p class="small muted">
        Targets are configuration references, not expanded category descendants
        or effective matches. A page is not the complete set. Redemptions
        include codes only, may exist before payment and may disappear after
        cancellation/expiry. Neither view is an immutable sales report; pages
        have no shared snapshot.
      </p>
      {#key `${rule.id}:${kind}:${role}:${recordsVersion}`}<PromotionRecords
          id={rule.id}
          {kind}
          {role}
        />{/key}
    </section>{/if}
{/if}

<style>
  pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
