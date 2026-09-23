<script lang="ts">
  import { onMount } from "svelte";
  import { beforeNavigate } from "$app/navigation";
  import { page } from "$app/state";
  import { supabase, message } from "./api";
  import type { Promotion } from "./promotions";
  import {
    readTargetSnapshot,
    targetChanges,
    type TargetDraft,
    type PromotionTarget,
  } from "./promotion-targets";
  let { id }: { id: string } = $props();
  let rule = $state.raw<Promotion | null>(null);
  let draft = $state<TargetDraft>({
    apply_scope: "selected",
    get_scope: "same_as_apply",
    rows: [],
  });
  let baseline = $state("");
  let busy = $state(false),
    locked = $state(true),
    error = $state(""),
    notice = $state("");
  let alive = true;
  let dirty = $derived(!!rule && JSON.stringify(draft) !== baseline);
  let back = $derived(`/promotions/${id}${page.url.search}`);
  onMount(() => {
    void load();
    return () => {
      alive = false;
    };
  });
  beforeNavigate(({ cancel }) => {
    if (busy || (dirty && !window.confirm("Discard unsaved target edits?")))
      cancel();
  });
  async function load(keepNotice = false) {
    busy = true;
    locked = true;
    error = "";
    if (!keepNotice) notice = "";
    try {
      const snapshot = await readTargetSnapshot(
        async () => {
          const result = await supabase.rpc("get_admin_promotion", {
            promotion_id: id,
          });
          if (result.error) throw result.error;
          return result.data as unknown as Promotion | null;
        },
        async (cursor) => {
          const result = await supabase.rpc("list_admin_promotion_targets", {
            promotion_id: id,
            page_size: 20,
            ...(cursor ? { after_id: cursor } : {}),
          });
          if (result.error) throw result.error;
          return result.data as unknown as {
            items: PromotionTarget[];
            next_cursor: string | null;
          };
        },
      );
      if (!alive) return;
      rule = snapshot.rule;
      draft = snapshot.draft;
      baseline = JSON.stringify(draft);
      locked = false;
    } catch (cause) {
      if (alive)
        error = `${message(cause)} Target saving is locked until a successful complete reload.`;
    } finally {
      if (alive) busy = false;
    }
  }
  function add() {
    draft.rows.push({ role: "apply", kind: "product_id", reference: "" });
    draft.apply_scope = "selected";
  }
  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (!rule || busy || locked || !dirty) return;
    let changes;
    try {
      changes = targetChanges(draft);
    } catch (cause) {
      error = message(cause);
      return;
    }
    if (
      !window.confirm(
        `Replace the complete target set with ${draft.rows.length} references? Apply: ${draft.apply_scope}; Get: ${draft.get_scope}. ${rule.is_active ? "This promotion is enabled; checkout discounts may change immediately." : "The promotion remains disabled."} Existing order snapshots are unchanged.`,
      )
    )
      return;
    busy = true;
    error = "";
    notice = "";
    try {
      const result = await supabase.rpc("update_promotion", {
        promotion_id: id,
        expected_revision: rule.revision,
        changes,
      });
      if (result.error) throw result.error;
      if (!alive) return;
      baseline = JSON.stringify(draft);
      notice =
        "Targets saved. Reloading the complete saved set; existing order snapshots are unchanged.";
      // Replacement regenerates target IDs and may advance revision multiple times.
      await load(true);
    } catch (cause) {
      if (alive) {
        locked = true;
        error = `${message(cause)} Reload all targets and review the saved values before another save. If the response was lost, the replacement may have succeeded.`;
      }
    } finally {
      if (alive) busy = false;
    }
  }
</script>

<svelte:head><title>Promotion targets · Tera Admin</title></svelte:head>
<svelte:window
  onbeforeunload={(event) => {
    if (busy || dirty) event.preventDefault();
  }}
/>
<div class="page-heading">
  <div>
    <a class="small" href={back}>← Promotion details</a>
    <h1>Promotion targets</h1>
    <p class="muted">{rule?.name ?? "Complete target-set editor"}</p>
  </div>
  <div class="actions">
    <button
      disabled={busy}
      onclick={() => {
        if (
          !dirty ||
          window.confirm(
            "Discard local target edits and reload the complete set?",
          )
        )
          void load();
      }}>Reload all targets</button
    ><button
      class="primary"
      form="targets-form"
      disabled={busy || locked || !dirty}>Save targets</button
    >
  </div>
</div>
{#if error}<p class="notice error" role="alert">{error}</p>{/if}
{#if notice}<p class="notice" role="status">{notice}</p>{/if}
{#if busy}<p role="status">Reading or saving the complete target set…</p>{/if}
{#if rule}<form id="targets-form" onsubmit={save}>
    <fieldset disabled={busy || locked}>
      <section class="card fields">
        <h2>Matching scope</h2>
        <div class="fields two">
          <label
            >Apply scope<select id="apply-scope" bind:value={draft.apply_scope}
              ><option value="all">All products</option><option value="selected"
                >Selected targets</option
              ></select
            ></label
          >
          <label
            >Get scope<select id="get-scope" bind:value={draft.get_scope}
              ><option value="same_as_apply">Same as apply</option><option
                value="selected">Selected targets</option
              ></select
            ></label
          >
        </div>
        <p class="small muted">
          Apply controls discounted items or buy quantities. Get controls gift
          eligibility for buy/get rules only. Categories follow the existing
          category-matching rules; references are not a cart preview.
        </p>
        <p class="small muted">
          Selected with no targets matches nothing. Removing the last target
          does not expand the scope. To use all products or same-as-apply,
          remove that role's targets and explicitly change its scope.
        </p>
        <p class="small muted">
          Revision {rule.revision} · {rule.is_active
            ? "Enabled: changes can affect checkout immediately."
            : "Disabled: saving targets does not enable the promotion."}
        </p>
      </section>
      <section class="card fields">
        <div class="page-heading">
          <h2>Complete set · {draft.rows.length}/100</h2>
          <button
            type="button"
            disabled={draft.rows.length >= 100}
            onclick={add}>Add target</button
          >
        </div>
        <p class="small muted">
          Use an existing product, category or variant UUID. The server
          validates references. Both roles are saved together atomically;
          duplicates within a role are rejected. No target IDs or usage counters
          are sent.
        </p>
        {#each draft.rows as row, index}<div class="target-row">
            <label
              >Role {index + 1}<select
                id={`target-role-${index}`}
                value={row.role}
                onchange={(event) => {
                  row.role = event.currentTarget.value as "apply" | "get";
                  if (row.role === "apply") draft.apply_scope = "selected";
                  else draft.get_scope = "selected";
                }}
                ><option value="apply">Apply</option><option value="get"
                  >Get</option
                ></select
              ></label
            >
            <label
              >Kind {index + 1}<select
                id={`target-kind-${index}`}
                bind:value={row.kind}
                ><option value="product_id">Product</option><option
                  value="category_id">Category</option
                ><option value="variant_id">Variant</option></select
              ></label
            >
            <label class="reference"
              >Reference {index + 1}<input
                required
                bind:value={row.reference}
                placeholder="UUID"
              /></label
            >
            <button
              type="button"
              aria-label={`Remove target ${index + 1}`}
              onclick={() => draft.rows.splice(index, 1)}>Remove</button
            >
          </div>{/each}
        {#if !draft.rows.length}<p class="muted">
            No target references. Selected scopes match no items.
          </p>{/if}
        {#if draft.rows.length}<button
            type="button"
            onclick={() => {
              if (
                window.confirm(
                  "Remove all target references locally? Scopes stay unchanged until you explicitly change them. Save targets is required to apply this.",
                )
              )
                draft.rows = [];
            }}>Clear all targets</button
          >{/if}
      </section>
    </fieldset>
  </form>{/if}

<style>
  .target-row {
    display: grid;
    grid-template-columns: 100px 140px minmax(0, 1fr) auto;
    gap: 12px;
    align-items: end;
  }
  @media (max-width: 700px) {
    .target-row {
      grid-template-columns: 1fr 1fr;
      border-bottom: 1px solid #ddd;
      padding-bottom: 16px;
    }
    .reference {
      grid-column: 1 / -1;
    }
  }
</style>
