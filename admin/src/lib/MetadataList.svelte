<script lang="ts">
  import { onMount } from "svelte";
  import { supabase, message } from "./api";
  import {
    metafieldOwners,
    type MetafieldDefinition,
    type MetaobjectDefinition,
    type Metafield,
    type Metaobject,
  } from "./metadata";
  import {
    metafieldDefinitionPage,
    metaobjectDefinitionPage,
    metafieldPage,
    metaobjectPage,
  } from "../../../mcp/src/schemas";
  let {
    mode,
    ownerType = "",
    ownerId = "",
    definitionId = "",
    productId = "",
  }: {
    mode:
      "metafield-definitions" | "metaobject-definitions" | "values" | "entries";
    ownerType?: string;
    ownerId?: string;
    definitionId?: string;
    productId?: string;
  } = $props();
  type Row =
    MetafieldDefinition | MetaobjectDefinition | Metafield | Metaobject;
  let items = $state<Row[]>([]),
    cursor = $state<string | null>(null),
    busy = $state(false),
    error = $state("");
  let owner = $state(""),
    namespace = $state(""),
    key = $state(""),
    access = $state(""),
    type = $state(""),
    active = $state(""),
    status = $state(""),
    handle = $state("");
  let applied = {
    owner: "",
    namespace: "",
    key: "",
    access: "",
    type: "",
    active: "",
    status: "",
    handle: "",
  };
  onMount(() => {
    void load(true);
  });
  async function load(reset: boolean) {
    if (busy) return;
    busy = true;
    error = "";
    try {
      if (reset) {
        applied = {
          owner,
          namespace,
          key,
          access,
          type,
          active,
          status,
          handle,
        };
        items = [];
        cursor = null;
      }
      const args = {
        page_size: 20,
        ...(!reset && cursor ? { after_id: cursor } : {}),
      };
      let next: { items: Row[]; next_cursor: string | null };
      if (mode === "metafield-definitions") {
        const r = await supabase.rpc("list_admin_metafield_definitions", {
          ...args,
          ...(applied.owner ? { owner_type_filter: applied.owner } : {}),
          ...(applied.namespace ? { namespace_filter: applied.namespace } : {}),
          ...(applied.access ? { access_filter: applied.access } : {}),
        });
        if (r.error) throw r.error;
        next = metafieldDefinitionPage.parse(r.data);
      } else if (mode === "metaobject-definitions") {
        const r = await supabase.rpc("list_admin_metaobject_definitions", {
          ...args,
          ...(applied.type ? { type_filter: applied.type } : {}),
          ...(applied.access ? { access_filter: applied.access } : {}),
          ...(applied.active ? { active: applied.active === "yes" } : {}),
        });
        if (r.error) throw r.error;
        next = metaobjectDefinitionPage.parse(r.data);
      } else if (mode === "values") {
        const r = await supabase.rpc("list_admin_metafields", {
          ...args,
          owner_type_filter: ownerType,
          owner_id_filter: ownerId,
          ...(applied.namespace ? { namespace_filter: applied.namespace } : {}),
          ...(applied.key ? { key_filter: applied.key } : {}),
        });
        if (r.error) throw r.error;
        next = metafieldPage.parse(r.data);
      } else {
        const r = await supabase.rpc("list_admin_metaobjects", {
          ...args,
          definition_id_filter: definitionId,
          ...(applied.status ? { status_filter: applied.status } : {}),
          ...(applied.handle ? { handle_filter: applied.handle } : {}),
        });
        if (r.error) throw r.error;
        next = metaobjectPage.parse(r.data);
      }
      items = [
        ...items,
        ...next.items.filter((x) => !items.some((old) => old.id === x.id)),
      ];
      cursor = next.next_cursor;
    } catch (e) {
      error = message(e);
    } finally {
      busy = false;
    }
  }
  function href(x: Row) {
    if (mode === "metafield-definitions") return `/metadata/metafields/${x.id}`;
    if (mode === "metaobject-definitions")
      return `/metadata/metaobjects/${x.id}`;
    if (mode === "entries")
      return `/metadata/metaobjects/${definitionId}/entries/${x.id}`;
    return `/metadata/values/${x.id}?${new URLSearchParams({ owner_type: ownerType, owner_id: ownerId, ...(productId ? { product: productId } : {}) })}`;
  }
</script>

<section class="card">
  <form
    class="toolbar"
    onsubmit={(e) => {
      e.preventDefault();
      void load(true);
    }}
  >
    {#if mode === "metafield-definitions"}<label
        >Owner filter<select bind:value={owner}
          ><option value="">All</option>{#each metafieldOwners as x}<option
              >{x}</option
            >{/each}</select
        ></label
      >{/if}
    {#if mode === "metafield-definitions" || mode === "values"}<label
        >Exact namespace<input bind:value={namespace} /></label
      >{/if}
    {#if mode === "values"}<label>Exact key<input bind:value={key} /></label
      >{/if}
    {#if mode.endsWith("definitions")}<label
        >Access<select bind:value={access}
          ><option value="">All</option><option>admin</option><option
            >public</option
          >{#if mode === "metafield-definitions"}<option>customer</option
            >{/if}</select
        ></label
      >{/if}
    {#if mode === "metaobject-definitions"}<label
        >Exact type<input bind:value={type} /></label
      ><label
        >Enabled<select bind:value={active}
          ><option value="">All</option><option value="yes">Yes</option><option
            value="no">No</option
          ></select
        ></label
      >{/if}
    {#if mode === "entries"}<label
        >Status<select bind:value={status}
          ><option value="">All</option><option>draft</option><option
            >active</option
          ></select
        ></label
      ><label>Exact handle<input bind:value={handle} /></label>{/if}
    <button disabled={busy}>Apply filters / refresh</button>
  </form>
  {#if error}<p class="notice error" role="alert">{error}</p>{/if}
  <div class="table-wrap">
    <table>
      <thead
        ><tr
          ><th>Name / key</th><th>Type</th><th>Access / status</th><th
            >Revision</th
          ></tr
        ></thead
      ><tbody
        >{#each items as x}<tr
            ><td
              ><a href={href(x)}
                >{"name" in x
                  ? x.name
                  : "handle" in x
                    ? x.handle
                    : `${x.namespace}.${x.key}`}</a
              ></td
            ><td>{"type" in x ? x.type : x.definition_type}</td><td
              >{"access" in x
                ? x.access
                : "status" in x
                  ? x.status
                  : x.definition_access}</td
            ><td>{x.revision}</td></tr
          >{/each}</tbody
      >
    </table>
  </div>
  {#if !items.length && !busy && !error}<p>
      No records. An empty owner-field list does not prove the owner exists.
    </p>{/if}{#if cursor}<button disabled={busy} onclick={() => load(false)}
      >Load more</button
    >{/if}{#if busy}<p role="status">Loading…</p>{/if}
</section>
