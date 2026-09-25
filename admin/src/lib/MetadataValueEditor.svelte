<script lang="ts">
  import { onMount } from "svelte";
  import { beforeNavigate, replaceState } from "$app/navigation";
  import { page } from "$app/state";
  import { supabase, message, saveProduct } from "./api";
  import {
    metafieldTypes,
    jsonValue,
    receipt,
    deletionReceipt,
    type Metafield,
    type MetafieldOwner,
  } from "./metadata";
  import {
    metafieldPage,
    metafieldResult,
    adminProduct,
    metafieldType,
  } from "../../../mcp/src/schemas";
  let {
    ownerType,
    ownerId,
    id,
    creating,
    productId = "",
  }: {
    ownerType: MetafieldOwner;
    ownerId: string;
    id: string;
    creating: boolean;
    productId?: string;
  } = $props();
  let item = $state<Metafield | null>(null),
    productRevision = $state<number | null>(null);
  let namespace = $state(page.url.searchParams.get("namespace") ?? "custom"),
    key = $state(page.url.searchParams.get("key") ?? ""),
    type = $state("text"),
    value = $state('""');
  let baseline = $state(""),
    loaded = $state(false),
    busy = $state(false),
    uncertain = $state(false),
    deleted = $state(false),
    error = $state(""),
    notice = $state("");
  let dirty = $derived(
    loaded && JSON.stringify({ namespace, key, type, value }) !== baseline,
  );
  let aggregate = $derived(ownerType === "product" || ownerType === "variant");
  let parent = $derived(ownerType === "product" ? ownerId : productId);
  onMount(() => {
    void load();
  });
  beforeNavigate(({ cancel }) => {
    if (busy || (dirty && !confirm("Discard unsaved metafield edits?")))
      cancel();
  });
  function install(v: Metafield | null) {
    item = v;
    if (v) {
      namespace = v.namespace;
      key = v.key;
      type = v.type;
      value = JSON.stringify(v.value, null, 2);
    }
    baseline = JSON.stringify({ namespace, key, type, value });
    loaded = true;
    uncertain = false;
  }
  async function findValue(byKey = false) {
    let cursor: string | null = null;
    do {
      const r = await supabase.rpc("list_admin_metafields", {
        owner_type_filter: ownerType,
        owner_id_filter: ownerId,
        page_size: 100,
        ...(cursor ? { after_id: cursor } : {}),
        ...(byKey ? { namespace_filter: namespace, key_filter: key } : {}),
      });
      if (r.error) throw r.error;
      const data = metafieldPage.parse(r.data);
      const found = data.items.find((x) =>
        byKey ? x.namespace === namespace && x.key === key : x.id === id,
      );
      if (found) return found;
      cursor = data.next_cursor;
    } while (cursor);
    return null;
  }
  async function load() {
    if (
      busy ||
      (dirty && !confirm("Discard local edits and read the original field?"))
    )
      return;
    busy = true;
    error = "";
    try {
      if (aggregate) {
        if (!parent)
          throw Error(
            "Open this variant through its parent product, or supply its parent product UUID in the owner list.",
          );
        const r = await supabase.rpc("get_admin_product", {
          product_id: parent,
        });
        if (r.error) throw r.error;
        const p = adminProduct.parse(r.data);
        if (
          p.id !== parent ||
          (ownerType === "variant" && !p.variants.some((x) => x.id === ownerId))
        )
          throw Error("Product/variant identity mismatch.");
        productRevision = p.revision;
      }
      const found = await findValue(
        aggregate && creating && !!page.url.searchParams.get("key"),
      );
      if (!found && aggregate && creating && page.url.searchParams.has("key"))
        throw Error(
          "The original field is not yet visible. This does not prove the pending write failed. Keep its namespace/key and re-read; do not create a replacement.",
        );
      if (!found && (!creating || item || deleted)) {
        deleted = true;
        throw Error(
          "Field not found. Do not recreate a replacement automatically.",
        );
      }
      install(found);
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
      const parsed = jsonValue(value);
      const fieldType = metafieldType.parse(type);
      if (!key.trim()) throw Error("Key is required.");
      if (
        !confirm(
          "Save this exact field value? Its current definition may expose it publicly or to customers. Review access before approving.",
        )
      )
        return;
      if (aggregate) {
        const url = new URL(page.url);
        url.searchParams.set("namespace", namespace);
        url.searchParams.set("key", key);
        replaceState(url, page.state);
      }
      busy = true;
      if (aggregate) {
        if (productRevision === null) throw Error("Reload the product first.");
        const p = await saveProduct(parent, productRevision, {
          metafields: [
            {
              namespace,
              key,
              type: fieldType,
              value: parsed,
              ...(ownerType === "variant" ? { variant_id: ownerId } : {}),
            },
          ],
        });
        if (p.id !== parent || p.revision < productRevision)
          throw Error("Unconfirmed product revision.");
        productRevision = p.revision;
        const found = await findValue(true);
        if (!found) throw Error("Saved field could not be read.");
        install(found);
      } else {
        const r = item
          ? await supabase.rpc("update_metafield", {
              metafield_id: id,
              expected_revision: item.revision,
              changes: { type: fieldType, value: parsed },
            })
          : await supabase.rpc("create_metafield", {
              metafield_id: id,
              changes: {
                owner_type: ownerType,
                owner_id: ownerId,
                namespace,
                key,
                type: fieldType,
                value: parsed,
              },
            });
        if (r.error) throw r.error;
        const next = receipt(
          metafieldResult.parse(r.data),
          id,
          item?.revision ?? null,
        );
        if (next.owner_id !== ownerId || next.owner_type !== ownerType)
          throw Error("Unconfirmed field owner.");
        install(next);
      }
      notice = "Metafield saved.";
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
        "Permanently delete this exact metafield? This cannot be undone.",
      )
    )
      return;
    busy = true;
    try {
      if (aggregate) {
        if (productRevision === null) throw Error("Reload product first.");
        await saveProduct(parent, productRevision, {
          metafields: [
            {
              namespace: item.namespace,
              key: item.key,
              ...(ownerType === "variant" ? { variant_id: ownerId } : {}),
              delete: true,
            },
          ],
        });
      } else {
        const r = await supabase.rpc("delete_metafield", {
          metafield_id: item.id,
          expected_revision: item.revision,
        });
        if (r.error) throw r.error;
        deletionReceipt(r.data, item.id);
      }
      deleted = true;
      notice = "Metafield deleted.";
      baseline = JSON.stringify({ namespace, key, type, value });
    } catch (e) {
      error = message(e);
      uncertain = true;
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>Metafield · Tera Admin</title></svelte:head>
<svelte:window
  onbeforeunload={(e) => {
    if (dirty || busy) e.preventDefault();
  }}
/>
<div class="page-heading">
  <div>
    <a
      href={`/metadata/values?${new URLSearchParams({ owner_type: ownerType, owner_id: ownerId, ...(productId ? { product: productId } : {}) })}`}
      >← Owner fields</a
    >
    <h1>Metafield</h1>
  </div>
  <div class="actions">
    <button disabled={busy} onclick={load}>Reload field</button
    >{#if item}<button disabled={busy || uncertain || deleted} onclick={remove}
        >Delete field</button
      >{/if}
  </div>
</div>
{#if aggregate}<p class="notice">
    Product and variant fields use the parent product's exact revision.
  </p>{/if}
{#if error}<p class="notice error" role="alert">
    {error}
    {uncertain ? "Reload before another write." : ""}
  </p>{/if}{#if notice}<p class="notice" role="status">{notice}</p>{/if}
<form onsubmit={save}>
  <fieldset disabled={busy || uncertain || deleted || !loaded}>
    <section class="card fields">
      <label>Namespace<input bind:value={namespace} disabled={!!item} /></label
      ><label>Key<input required bind:value={key} disabled={!!item} /></label
      ><label
        >Type<select bind:value={type}
          >{#each metafieldTypes as x}<option>{x}</option>{/each}</select
        ></label
      ><label>JSON value<textarea rows="12" bind:value></textarea></label>
      <p class="small muted">
        Text: {`"hello"`}; number: 12; boolean: true; list: [1,2]. JSON null is
        a value, not deletion. References remain UUIDs and are not expanded.
      </p>
      {#if item}<p>
          Definition access: {item.definition_access} · Field revision {item.revision}
        </p>{/if}<button class="primary" disabled={!dirty}>Save field</button>
    </section>
  </fieldset>
</form>
