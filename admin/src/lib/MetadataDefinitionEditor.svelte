<script lang="ts">
  import { onMount } from "svelte";
  import { beforeNavigate, goto } from "$app/navigation";
  import { supabase, message } from "./api";
  import {
    metafieldOwners,
    metafieldTypes,
    jsonObject,
    jsonValue,
    receipt,
    deletionReceipt,
    type MetafieldDefinition,
    type MetaobjectDefinition,
  } from "./metadata";
  import {
    metafieldDefinitionResult,
    metaobjectDefinitionResult,
    metafieldDefinitionChanges,
    metaobjectDefinitionChanges,
    metafieldOwner,
    metaobjectFields,
  } from "../../../mcp/src/schemas";
  let {
    id,
    kind,
    creating,
  }: { id: string; kind: "metafield" | "metaobject"; creating: boolean } =
    $props();
  let item = $state<MetafieldDefinition | MetaobjectDefinition | null>(null);
  let loaded = $state(false),
    busy = $state(false),
    uncertain = $state(false),
    deleted = $state(false),
    error = $state(""),
    notice = $state("");
  let fields = $state({
    owner_type: "product",
    namespace: "custom",
    key: "",
    type: "text",
    name: "",
    description: "",
    access: "admin",
    position: 0,
    validations: "{}",
    schema: "[]",
    active: true,
  });
  let baseline = $state("");
  let dirty = $derived(loaded && JSON.stringify(fields) !== baseline);
  onMount(() => {
    void load();
  });
  beforeNavigate(({ cancel }) => {
    if (busy || (dirty && !confirm("Discard unsaved metadata edits?")))
      cancel();
  });
  function install(v: typeof item) {
    item = v;
    if (kind === "metafield") {
      const x = v as MetafieldDefinition | null;
      fields = {
        ...fields,
        owner_type: x?.owner_type ?? "product",
        namespace: x?.namespace ?? "custom",
        key: x?.key ?? "",
        type: x?.type ?? "text",
        name: x?.name ?? "",
        description: x?.description ?? "",
        access: x?.access ?? "admin",
        position: x?.position ?? 0,
        validations: JSON.stringify(x?.validations ?? {}, null, 2),
      };
    } else {
      const x = v as MetaobjectDefinition | null;
      fields = {
        ...fields,
        type: x?.type ?? "",
        name: x?.name ?? "",
        description: x?.description ?? "",
        access: x?.access ?? "admin",
        schema: JSON.stringify(x?.fields ?? [], null, 2),
        active: x?.is_active ?? true,
      };
    }
    baseline = JSON.stringify(fields);
    loaded = true;
    uncertain = false;
  }
  async function load() {
    if (
      busy ||
      (dirty &&
        !confirm("Discard local edits and read the original definition?"))
    )
      return;
    busy = true;
    error = "";
    try {
      const r =
        kind === "metafield"
          ? await supabase.rpc("get_admin_metafield_definition", {
              definition_id: id,
            })
          : await supabase.rpc("get_admin_metaobject_definition", {
              definition_id: id,
            });
      if (r.error) throw r.error;
      if (r.data === null && (!creating || item || deleted)) {
        deleted = true;
        throw Error("Definition not found. Do not reuse this UUID.");
      }
      install(
        r.data === null
          ? null
          : receipt(
              kind === "metafield"
                ? metafieldDefinitionResult.parse(r.data)
                : metaobjectDefinitionResult.parse(r.data),
              id,
              null,
            ),
      );
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
      if (!fields.name.trim() || !fields.type.trim())
        throw Error("Name and type are required.");
      const changes =
        kind === "metafield"
          ? metafieldDefinitionChanges.parse({
              name: fields.name,
              description: fields.description,
              type: fields.type,
              access: fields.access,
              position: fields.position,
              validations: jsonObject(fields.validations, "Validations"),
            })
          : metaobjectDefinitionChanges.parse({
              name: fields.name,
              description: fields.description,
              access: fields.access,
              is_active: fields.active,
              fields: metaobjectFields.parse(jsonValue(fields.schema)),
            });
      if (
        !confirm(
          "Save this exact definition? Visibility changes can expose all existing values/active entries. Review their contents before approving.",
        )
      )
        return;
      busy = true;
      const r =
        kind === "metafield"
          ? item
            ? await supabase.rpc("update_metafield_definition", {
                definition_id: id,
                expected_revision: item.revision,
                changes,
              })
            : await supabase.rpc("create_metafield_definition", {
                definition_id: id,
                changes: {
                  ...changes,
                  owner_type: metafieldOwner.parse(fields.owner_type),
                  namespace: fields.namespace,
                  key: fields.key,
                },
              })
          : item
            ? await supabase.rpc("update_metaobject_definition", {
                definition_id: id,
                expected_revision: item.revision,
                changes,
              })
            : await supabase.rpc("create_metaobject_definition", {
                definition_id: id,
                changes: { ...changes, type: fields.type },
              });
      if (r.error) throw r.error;
      install(
        receipt(
          kind === "metafield"
            ? metafieldDefinitionResult.parse(r.data)
            : metaobjectDefinitionResult.parse(r.data),
          id,
          item?.revision ?? null,
        ),
      );
      notice = "Definition saved.";
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
        "Permanently delete this EMPTY definition at its exact revision? No automatic reference removal or cascading deletion.",
      )
    )
      return;
    busy = true;
    try {
      const r = await supabase.rpc("delete_metaobject_definition", {
        definition_id: id,
        expected_revision: item.revision,
      });
      if (r.error) throw r.error;
      deletionReceipt(r.data, id);
      deleted = true;
      notice = "Definition deleted. Do not reuse its UUID.";
    } catch (e) {
      error = message(e);
      uncertain = true;
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>Metadata definition · Tera Admin</title></svelte:head>
<svelte:window
  onbeforeunload={(e) => {
    if (dirty || busy) e.preventDefault();
  }}
/>
<div class="page-heading">
  <div>
    <a href="/metadata">← Metadata</a>
    <h1>{item?.name ?? "New definition"}</h1>
  </div>
  <div class="actions">
    <button disabled={busy} onclick={load}>Reload definition</button
    >{#if kind === "metaobject" && item}<a
        class="button"
        href={`/metadata/metaobjects/${id}/entries`}>Entries</a
      ><button disabled={busy || uncertain || deleted} onclick={remove}
        >Delete definition</button
      >{/if}
  </div>
</div>
{#if error}<p class="notice error" role="alert">
    {error}
    {uncertain ? "Reload before another write." : ""}
  </p>{/if}{#if notice}<p class="notice" role="status">{notice}</p>{/if}
<form onsubmit={save}>
  <fieldset disabled={busy || uncertain || deleted || !loaded}>
    <section class="card fields">
      {#if kind === "metafield"}<label
          >Owner<select bind:value={fields.owner_type} disabled={!!item}
            >{#each metafieldOwners as x}<option>{x}</option>{/each}</select
          ></label
        ><label
          >Namespace<input
            bind:value={fields.namespace}
            disabled={!!item}
          /></label
        ><label
          >Key<input
            required
            bind:value={fields.key}
            disabled={!!item}
          /></label
        >{/if}
      <label
        >{kind === "metaobject"
          ? "Type"
          : "Value type"}{#if kind === "metafield"}<select
            bind:value={fields.type}
            >{#each metafieldTypes as x}<option>{x}</option>{/each}</select
          >{:else}<input
            required
            bind:value={fields.type}
            disabled={!!item}
          />{/if}</label
      >
      <label>Name<input required bind:value={fields.name} /></label><label
        >Description<textarea bind:value={fields.description}></textarea></label
      >
      <label
        >Access<select bind:value={fields.access}
          ><option>admin</option><option>public</option
          >{#if kind === "metafield"}<option>customer</option>{/if}</select
        ></label
      >
      {#if kind === "metafield"}<label
          >Position<input
            type="number"
            min="-2147483648"
            max="2147483647"
            step="1"
            required
            bind:value={fields.position}
          /></label
        ><label
          >Validation rules JSON<textarea
            rows="7"
            bind:value={fields.validations}></textarea></label
        >
        <p class="small muted">
          Supported: number min/max and scalar choices. Example: {`{"min":0,"max":100}`}.
          Empty object clears validation.
        </p>{:else}<label class="check-label"
          ><input type="checkbox" bind:checked={fields.active} />Enabled</label
        ><label
          >Complete field schema JSON<textarea
            rows="14"
            bind:value={fields.schema}></textarea></label
        >
        <p class="small muted">
          Example: {`[{"key":"title","type":"text","required":true}]`}. Replaces
          the full schema and validates every existing entry.
        </p>{/if}
      {#if item}<p>Exact revision {item.revision}</p>{/if}<button
        class="primary"
        disabled={!dirty}>Save definition</button
      >
    </section>
  </fieldset>
</form>
