<script lang="ts">
  import { onMount } from "svelte";
  import * as publicEnv from "$env/static/public";
  import { mcpOnboarding } from "$lib/mcp-onboarding";
  import { supabase, dateTime } from "$lib/api";
  import { watchAdminChanges } from "$lib/realtime";
  import McpToolCalls from "$lib/McpToolCalls.svelte";
  import {
    connectionPage,
    revocationPreview,
    confirmsRevocation,
    type McpConnection,
  } from "$lib/mcp-connections";

  const onboarding = mcpOnboarding(
    (publicEnv as Record<string, string>).PUBLIC_MCP_CONNECTION,
  );
  let items = $state<McpConnection[]>([]);
  let cursor = $state<string | null>(null);
  let busy = $state(false);
  let error = $state("");
  let notice = $state("");
  let selected = $state<McpConnection[]>([]);
  let attempted = $state(false);
  let loaded = $state(false);
  let live = $state(false);
  let changes = $state(0),
    checked = $state(0),
    attemptedChanges = $state(0);
  let laterPage = $state(false);
  let alive = true;
  onMount(() => {
    void load();
    const stop = watchAdminChanges(
      supabase,
      "connections",
      () => changes++,
      (value) => (live = value),
    );
    return () => {
      alive = false;
      stop();
    };
  });
  $effect(() => {
    if (
      changes > attemptedChanges &&
      !busy &&
      !laterPage &&
      !selected.length
    )
      void load();
  });
  async function load(after?: string) {
    if (busy) return;
    const version = changes;
    attemptedChanges = version;
    busy = true;
    error = "";
    try {
      const result = await supabase.rpc("list_my_mcp_connections", {
        page_size: 20,
        ...(after ? { after_id: after } : {}),
      });
      if (result.error) throw result.error;
      const data = connectionPage(result.data);
      if (!alive) return;
      items = data.items;
      cursor = data.next_cursor;
      loaded = true;
      laterPage = !!after;
      checked = version;
    } catch {
      if (alive)
        error =
          "Could not load current connection records. No connection health is inferred from this error.";
    } finally {
      if (alive) busy = false;
    }
  }
  function choose(connections: McpConnection[]) {
    selected = [...connections];
    attempted = false;
    notice = "";
    error = "";
  }
  async function previewAll() {
    if (busy || selected.length) return;
    busy = true;
    error = "";
    notice = "";
    try {
      const result = await supabase.rpc("preview_my_mcp_connection_revocation");
      if (result.error) throw result.error;
      const snapshot = revocationPreview(result.data);
      if (!alive) return;
      choose(snapshot);
      if (!snapshot.length)
        notice =
          "No connections currently eligible for a new revocation request.";
    } catch (failure) {
      if (alive)
        error =
          (failure as { code?: string })?.code === "PT422"
            ? "More than 100 eligible connections. Revoke explicit pages first, then request a new preview. Nothing was revoked by this preview."
            : "Could not verify the complete revocation preview. Nothing was revoked; retry the preview explicitly.";
    } finally {
      if (alive) busy = false;
    }
  }
  async function revoke() {
    if (busy || !selected.length) return;
    busy = true;
    attempted = true;
    error = "";
    const ids = selected.map((item) => item.id);
    try {
      const result = await supabase.rpc("revoke_my_mcp_connections", {
        grant_ids: ids,
      });
      if (result.error || !confirmsRevocation(result.data, ids))
        throw Error("Unconfirmed");
      if (!alive) return;
      notice = `${selected.length} connection(s) revoked locally. Upstream cleanup is asynchronous; requests already dispatched may still complete.`;
      selected = [];
      attempted = false;
    } catch {
      if (alive)
        error =
          "Revocation was not confirmed. It may already have succeeded. Retry only the same selected connections, or reload to inspect their records.";
    } finally {
      if (alive) busy = false;
    }
    if (alive && !selected.length) await load();
  }
</script>

<svelte:head><title>My Agent connections · Tera Admin</title></svelte:head>
<div class="page-heading">
  <div>
    <p class="eyebrow">Personal security</p>
    <h1>My Agent connections</h1>
    <p class="muted">
      Review your MCP authorizations. No tokens or login credentials are
      displayed.
    </p>
  </div>
  <button onclick={() => load()} disabled={busy || selected.length > 0}
    >Refresh connections</button
  >
</div>
{#if notice}<p class="notice" role="status">{notice}</p>{/if}
{#if error}<p class="notice error" role="alert">{error}</p>{/if}
<p class="small muted">
  {live
    ? "Live connection updates connected."
    : "Live connection updates unavailable; focus or refresh to check current facts."}
</p>
{#if changes > checked && (laterPage || selected.length)}
  <p class="notice" role="status">
    Connections may have changed. The current page and selected confirmation are
    preserved; refresh connections after finishing or cancelling to return to
    the newest page.
  </p>
{/if}
{#if selected.length}
  <section class="card" aria-label="Confirm revocation">
    <h2>Revoke {selected.length} selected connection(s)?</h2>
    <p>
      This stops new MCP authorization through these records and removes their
      stored credentials. It does not undo previous work or revoke connections
      created later.
    </p>
    <p class="small muted">
      Review all {selected.length} selected connections below. Scroll the list to
      see every entry.
    </p>
    <!-- Keyboard focus is required to scroll the bounded confirmation list. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      class="revocation-selection"
      role="region"
      aria-label="Selected connections, scroll to review all entries"
      tabindex="0"
    >
      <ul>
        {#each selected as item}<li>
            <strong>{item.client_id}</strong> · {item.id}
            <p class="small muted">
              {item.resource} · {item.scopes.join(", ")}
            </p>
          </li>{/each}
      </ul>
    </div>
    <div class="actions">
      <button class="primary" onclick={revoke} disabled={busy}
        >{attempted ? "Retry same revocation" : "Confirm revocation"}</button
      >
      {#if !attempted}<button onclick={() => (selected = [])} disabled={busy}
          >Cancel</button
        >{/if}
    </div>
  </section>
{/if}
<section class="card">
  <p class="notice">
    “Not revoked locally” is not a live health check. OAuth tokens or the
    downstream login may already be expired. Signing out of Admin does not
    revoke these connections.
  </p>
  <p class="small muted">
    On narrow screens, scroll the table horizontally to review all columns and
    actions.
  </p>
  <div
    class="table-wrap"
    role="region"
    aria-label="My connections table, scroll horizontally for all columns"
  >
    <table>
      <thead
        ><tr
          ><th>Client / connection</th><th>Permission scopes</th><th
            >Local authorization</th
          ><th>Upstream cleanup</th><th>Action</th></tr
        ></thead
      >
      <tbody
        >{#each items as item (item.id)}
          <tr>
            <td
              ><strong>{item.client_id}</strong>
              <p class="small muted">{item.id}</p>
              <p class="small">{item.resource}</p>
              <p class="small muted">Created {dateTime(item.created_at)}</p></td
            >
            <td>{item.scopes.join(", ") || "None"}</td>
            <td
              ><span class="badge"
                >{item.state === "revoked"
                  ? "Revoked locally"
                  : "Not revoked locally"}</span
              >{#if item.revoked_at}<p class="small muted">
                  {dateTime(item.revoked_at)}
                </p>{/if}</td
            >
            <td
              >{item.cleanup === "completed"
                ? "Completed"
                : item.cleanup === "pending"
                  ? "Pending"
                  : "Not requested here"}</td
            >
            <td
              ><button
                disabled={busy ||
                  selected.length > 0 ||
                  item.cleanup === "completed" ||
                  item.cleanup === "pending"}
                onclick={() => choose([item])}>Revoke {item.client_id}</button
              ></td
            >
          </tr>
        {/each}</tbody
      >
    </table>
  </div>
  {#if busy}<p role="status">
      Updating connections…
    </p>{:else if loaded && !items.length}<p>
      No MCP connections for this account.
    </p>{/if}
  <div class="actions">
    <button
      disabled={busy ||
        selected.length > 0 ||
        !items.some((item) => item.cleanup === "not_requested")}
      onclick={() =>
        choose(items.filter((item) => item.cleanup === "not_requested"))}
      >Revoke eligible connections on this page</button
    >
    <button disabled={busy || selected.length > 0} onclick={previewAll}
      >Preview all eligible connections</button
    >
    {#if cursor}<button
        disabled={busy || selected.length > 0}
        onclick={() => load(cursor!)}>Next connections</button
      >{/if}
  </div>
  <p class="small muted">
    20 records per page, ordered by connection ID. Pagination is not a frozen
    snapshot. Batch revocation only affects the IDs shown in the confirmation.
    Preview all reads one snapshot across pages, up to 100 connections without
    an existing cleanup request. New connections after the preview are excluded.
  </p>
</section>
<McpToolCalls />
<section class="card">
  <h2>Connect an Agent</h2>
  {#if onboarding}
    <p class="notice">
      Operator-provided build configuration, not a live health check. Verify
      these values with your operator before connecting.
    </p>
    <label
      >MCP server address<input readonly value={onboarding.resource} /></label
    >
    <label
      >Expected authorization issuer<input
        readonly
        value={onboarding.issuer}
      /></label
    >
    <p>
      Configured business scopes: <code>{onboarding.scopes.join(" ")}</code>
    </p>
    {#each onboarding.presets as preset}
      <label
        >{preset.name}<input readonly value={preset.scopes.join(" ")} /></label
      >
    {/each}
    <p class="muted">
      Presets are suggestions for your OAuth client, not granted permissions.
      Read only excludes mutations; routine operations permits changes but
      excludes payment, access and privacy operations. Request sensitive scopes
      only for an explicit need. Your client may not support scope selection.
    </p>
    <p class="muted">
      Copy the server address into your client's remote MCP configuration. The
      client must create its own OAuth/PKCE request. Check the issuer, account
      and scopes on the consent page; this page does not start authorization or
      provide credentials.
    </p>
  {:else}
    <p class="muted">
      Connection configuration is not published in this Admin build. Ask your
      operator for the MCP address and registered client setup.
    </p>
  {/if}
  <p>
    Use the MCP HTTPS address supplied by your operator in a supported OAuth
    client. The client starts authorization; verify the account and requested
    scopes on the authorization page. Reauthorization creates a new connection
    rather than restoring a revoked one.
  </p>
  <p class="muted">
    Clients and callback addresses must already be registered by the operator.
    Prefer store:read; store:write enables changes, with additional
    store:payments, store:access and store:privacy scopes for sensitive actions.
    Deployment policy may restrict these further. Never paste an Admin login
    token into an Agent.
  </p>
</section>

<style>
  .revocation-selection {
    max-height: 20rem;
    overflow: auto;
    overflow-wrap: anywhere;
    border-bottom: 1px solid #cfd6ce;
    margin-bottom: 1rem;
  }
</style>
