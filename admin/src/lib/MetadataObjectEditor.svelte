<script lang="ts">
  import { onMount } from "svelte";
  import { beforeNavigate } from "$app/navigation";
  import { supabase, message } from "./api";
  import {
    jsonObject,
    receipt,
    deletionReceipt,
    type Metaobject,
    type MetaobjectDefinition,
  } from "./metadata";
  import {
    metaobjectResult,
    metaobjectDefinitionResult,
  } from "../../../mcp/src/schemas";
  let {
    id,
    definitionId,
    creating,
  }: { id: string; definitionId: string; creating: boolean } = $props();
  let item = $state<Metaobject | null>(null),
    definition = $state<MetaobjectDefinition | null>(null);
  let handle = $state(""),
    values = $state("{}"),
    status = $state<"draft" | "active">("draft"),
    baseline = $state("");
  let loaded = $state(false),
    busy = $state(false),
    uncertain = $state(false),
    deleted = $state(false),
    error = $state(""),
    notice = $state("");
  let dirty = $derived(
    loaded && JSON.stringify({ handle, values, status }) !== baseline,
  );
  onMount(() => {
    void load();
  });
  beforeNavigate(({ cancel }) => {
    if (busy || (dirty && !confirm("Discard unsaved entry edits?"))) cancel();
  });
  function install(v: Metaobject | null) {
    item = v;
    handle = v?.handle ?? "";
    values = JSON.stringify(v?.values ?? {}, null, 2);
    status = v?.status ?? "draft";
    baseline = JSON.stringify({ handle, values, status });
    loaded = true;
    uncertain = false;
  }
  async function load() {
    if (
      busy ||
      (dirty && !confirm("Discard local edits and read the original entry?"))
    )
      return;
    busy = true;
    error = "";
    try {
      const [r, d] = await Promise.all([
        supabase.rpc("get_admin_metaobject", { metaobject_id: id }),
        supabase.rpc("get_admin_metaobject_definition", {
          definition_id: definitionId,
        }),
      ]);
      if (r.error) throw r.error;
      if (d.error) throw d.error;
      definition = receipt(
        metaobjectDefinitionResult.parse(d.data),
        definitionId,
        null,
      );
      if (r.data === null && (!creating || item || deleted)) {
        deleted = true;
        throw Error("Entry not found. Do not reuse its UUID.");
      }
      const next =
        r.data === null
          ? null
          : receipt(metaobjectResult.parse(r.data), id, null);
      if (next && next.definition_id !== definitionId)
        throw Error("Entry belongs to a different definition.");
      install(next);
    } catch (e) {
      error = message(e);
      uncertain = true;
    } finally {
      busy = false;
    }
  }
  async function save(e: SubmitEvent) {
    e.preventDefault();
    if (busy || uncertain || !loaded || deleted) return;
    error = "";
    notice = "";
    try {
      const parsed = jsonObject(values, "Values");
      if (
        !confirm(
          "Save this exact entry? Active entries may be public under the current definition. Confirm the full content and status.",
        )
      )
        return;
      busy = true;
      const r = item
        ? await supabase.rpc("update_metaobject", {
            metaobject_id: id,
            expected_revision: item.revision,
            changes: { handle, values: parsed, status },
          })
        : await supabase.rpc("create_metaobject", {
            metaobject_id: id,
            changes: {
              definition_id: definitionId,
              handle,
              values: parsed,
              status,
            },
          });
      if (r.error) throw r.error;
      const next = receipt(
        metaobjectResult.parse(r.data),
        id,
        item?.revision ?? null,
      );
      if (next.definition_id !== definitionId)
        throw Error("Unconfirmed definition identity.");
      install(next);
      notice = "Entry saved.";
    } catch (e) {
      error = message(e);
      if (busy) uncertain = true;
    } finally {
      busy = false;
    }
  }
  async function remove() {
    if (
      !item ||
      busy ||
      uncertain ||
      deleted ||
      !confirm(
        "Permanently delete this exact entry revision? Existing references block deletion; no automatic reference removal.",
      )
    )
      return;
    busy = true;
    try {
      const r = await supabase.rpc("delete_metaobject", {
        metaobject_id: id,
        expected_revision: item.revision,
      });
      if (r.error) throw r.error;
      deletionReceipt(r.data, id);
      deleted = true;
      baseline = JSON.stringify({ handle, values, status });
      notice = "Entry deleted. Do not reuse its UUID.";
    } catch (e) {
      error = message(e);
      uncertain = true;
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>Metaobject entry · Tera Admin</title></svelte:head>
<svelte:window
  onbeforeunload={(e) => {
    if (dirty || busy) e.preventDefault();
  }}
/>
<div class="page-heading">
  <div>
    <a href={`/metadata/metaobjects/${definitionId}/entries`}>← Entries</a>
    <h1>Metaobject entry</h1>
  </div>
  <div class="actions">
    <button disabled={busy} onclick={load}>Reload entry</button
    >{#if item}<button disabled={busy || uncertain || deleted} onclick={remove}
        >Delete entry</button
      >{/if}
  </div>
</div>
{#if error}<p class="notice error" role="alert">
    {error}
    {uncertain ? "Reload before another write." : ""}
  </p>{/if}{#if notice}<p class="notice" role="status">{notice}</p>{/if}
{#if definition}<section class="card">
    <h2>Definition: {definition.name}</h2>
    <p>
      {definition.access} · {definition.is_active ? "Enabled" : "Disabled"}.
      Entry revision does not lock the definition; backend checks current
      schema.
    </p>
    <details>
      <summary>Field schema</summary>
      <pre class="preserve-text">{JSON.stringify(
          definition.fields,
          null,
          2,
        )}</pre>
    </details>
  </section>{/if}
<form onsubmit={save}>
  <fieldset disabled={busy || uncertain || deleted || !loaded}>
    <section class="card fields">
      <label>Handle<input required bind:value={handle} /></label><label
        >Status<select bind:value={status}
          ><option>draft</option><option>active</option></select
        ></label
      ><label
        >Complete values JSON<textarea rows="12" bind:value={values}
        ></textarea></label
      >
      <p>
        Values replace the whole object. Drafts must also satisfy the schema.
        Text and URLs are not executed or expanded.
      </p>
      {#if item}<p>
          Revision {item.revision} · {item.is_public ? "Public" : "Not public"}
        </p>{/if}<button class="primary" disabled={!dirty}>Save entry</button>
    </section>
  </fieldset>
</form>
