<script lang="ts">
  import { onMount } from "svelte";
  import { supabase, message } from "./api";
  import {
    canDeleteMedia,
    canDiscardMedia,
    managedMedia,
    mediaPage,
    mediaReceipt,
    type ManagedMedia,
  } from "./media";

  let requestId = $state("");
  let stateFilter = $state("");
  let uploadStatus = $state("");
  let publication = $state("");
  let items = $state<ManagedMedia[]>([]);
  let cursor = $state<string | null>(null);
  let currentAfter = $state<string | null>(null);
  let pages = $state<Array<string | null>>([]);
  let busy = $state(false);
  let error = $state("");
  let notice = $state("");
  let appliedFilters = $state("");
  let filterKey = $derived(JSON.stringify([requestId, stateFilter, uploadStatus, publication]));

  async function load(after: string | null = null, history = pages) {
    if (busy) return;
    busy = true;
    error = "";
    notice = "";
    const requestedFilters = filterKey;
    try {
      const { data, error: queryError } = await supabase.rpc(
        "list_admin_managed_media",
        {
          page_size: 20,
          ...(after ? { after_id: after } : {}),
          ...(stateFilter ? { state_filter: stateFilter } : {}),
          ...(uploadStatus ? { upload_status_filter: uploadStatus } : {}),
          ...(publication
            ? { published_filter: publication === "published" }
            : {}),
          ...(requestId.trim()
            ? { request_id_filter: requestId.trim().toLowerCase() }
            : {}),
        },
      );
      if (queryError) throw queryError;
      const page = mediaPage(data);
      items = page.items;
      cursor = page.next_cursor;
      currentAfter = after;
      pages = history;
      appliedFilters = requestedFilters;
    } catch (cause) {
      error = message(cause);
    } finally {
      busy = false;
    }
  }

  async function current(id: string) {
    const { data, error } = await supabase.functions.invoke("managed-media", {
      body: { action: "get", media_id: id },
    });
    if (error) throw Error("Media state could not be confirmed.");
    const found = managedMedia(data);
    if (found.id !== id) throw Error("Media identity mismatch.");
    return found;
  }

  async function action(
    item: ManagedMedia,
    kind: "discard" | "delete" | "recover_delete",
  ) {
    if (busy) return;
    busy = true;
    error = "";
    notice = "";
    try {
      const fresh = await current(item.id);
      if (kind === "discard" && !canDiscardMedia(fresh))
        throw Error("This media is no longer eligible for discard.");
      if (
        (kind === "delete" || kind === "recover_delete") &&
        !canDeleteMedia(fresh) &&
        fresh.state !== "discarded"
      )
        throw Error("This media is not prepared for deletion.");
      if (
        kind !== "recover_delete" &&
        !window.confirm(
          kind === "discard"
            ? "Freeze this settled private upload for permanent deletion? This does not delete bytes yet."
            : "Permanently delete this prepared private upload? The operation is not automatically retried.",
        )
      )
        return;
      const { data, error: commandError } = await supabase.functions.invoke(
        "managed-media",
        {
          body: { action: kind, media_id: fresh.id },
        },
      );
      if (commandError)
        throw Error("Media action failed or its response was lost.");
      const next = mediaReceipt(data, fresh);
      if (next.id !== fresh.id) throw Error("Media identity mismatch.");
      items = items.map((value) => (value.id === next.id ? next : value));
      notice =
        kind === "recover_delete"
          ? `Deletion state recovered: ${next.state}.`
          : `Media is now ${next.state}.`;
    } catch (cause) {
      error = `${message(cause)} No automatic retry. Refresh or recover deletion state before another action.`;
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    void load();
  });
</script>

<section class="card">
  <form
    class="toolbar"
    onsubmit={(event) => {
      event.preventDefault();
      pages = [];
      void load(null, []);
    }}
  >
    <label
      >Request ID<input
        bind:value={requestId}
        placeholder="Exact original request UUID"
      /></label
    >
    <label
      >State<select bind:value={stateFilter}
        ><option value="">All states</option
        >{#each ["uploading", "staged", "retained", "discard_prepared", "discarded"] as value}<option
            {value}>{value}</option
          >{/each}</select
      ></label
    >
    <label
      >Upload<select bind:value={uploadStatus}
        ><option value="">All upload states</option
        >{#each ["not_started", "pending", "settled"] as value}<option {value}
            >{value}</option
          >{/each}</select
      ></label
    >
    <label
      >Publication<select bind:value={publication}
        ><option value="">All</option><option value="private">Private</option
        ><option value="published">Published</option></select
      ></label
    >
    <button disabled={busy}>Apply filters</button>
  </form>
  <p class="small muted">
    Results are application records, not proof that bytes exist. Actions re-read
    server state. Published, retained, uploading, and pending media cannot be
    deleted here.
  </p>
  {#if error}<p class="notice error" role="alert">{error}</p>{/if}
  {#if notice}<p class="notice" role="status">{notice}</p>{/if}
  {#if !items.length}<p>
      {busy ? "Loading media…" : "No managed media matches these filters."}
    </p>{/if}
  <div class="records">
    {#each items as item (item.id)}
      <article>
        <div>
          <strong>{item.state}</strong> · {item.published
            ? "published"
            : "private"} · upload {item.upload_status}
        </div>
        <p class="small">
          Media: <code>{item.id}</code><br />Request:
          <code>{item.request_id}</code>
        </p>
        <p class="small muted">
          {item.content_type} · {item.byte_size.toLocaleString()} bytes · SHA-256
          <code>{item.sha256}</code>
        </p>
        <div class="actions">
          {#if canDiscardMedia(item)}<button
              disabled={busy}
              onclick={() => action(item, "discard")}>Prepare discard</button
            >{/if}
          {#if canDeleteMedia(item)}<button
              class="danger"
              disabled={busy}
              onclick={() => action(item, "delete")}
              >Delete private bytes</button
            ><button
              disabled={busy}
              onclick={() => action(item, "recover_delete")}
              >Recover deletion state</button
            >{/if}
          {#if item.state === "discarded"}<span class="small muted"
              >Deletion confirmed</span
            >{/if}
        </div>
      </article>
    {/each}
  </div>
  <div class="actions pager">
    <button
      disabled={busy || filterKey !== appliedFilters || !pages.length}
      onclick={() => {
        const previous = pages.slice(0, -1);
        void load(pages.at(-1) ?? null, previous);
      }}>Previous</button
    >
    <button
      disabled={busy || filterKey !== appliedFilters || !cursor}
      onclick={() => {
        const history = [...pages, currentAfter];
        void load(cursor, history);
      }}>Next</button
    >
  </div>
</section>

<style>
  .records {
    display: grid;
    gap: 0.8rem;
  }
  article {
    border: 1px solid #dce2d9;
    border-radius: 6px;
    padding: 1rem;
    overflow-wrap: anywhere;
  }
  article p {
    margin: 0.45rem 0;
  }
  code {
    font-size: 0.82em;
  }
  .pager {
    margin-top: 1rem;
  }
</style>
