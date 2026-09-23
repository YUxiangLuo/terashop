<script lang="ts">
  import { onMount } from "svelte";
  import { supabase, dateTime } from "$lib/api";
  import {
    toolCallPage,
    type McpToolCall,
    type ToolCallCursor,
  } from "$lib/mcp-connections";

  let items = $state<McpToolCall[]>([]);
  let cursor = $state<ToolCallCursor | null>(null);
  let busy = $state(false);
  let loaded = $state(false);
  let error = $state("");
  let alive = true;
  onMount(() => {
    void load();
    return () => {
      alive = false;
    };
  });
  async function load(before?: ToolCallCursor) {
    if (busy) return;
    busy = true;
    error = "";
    try {
      const result = await supabase.rpc("list_my_mcp_tool_calls", {
        page_size: 20,
        ...(before
          ? { before_at: before.admitted_at, before_id: before.id }
          : {}),
      });
      if (result.error) throw result.error;
      const page = toolCallPage(result.data);
      if (!alive) return;
      items = page.items;
      cursor = page.next_cursor;
      loaded = true;
    } catch {
      if (alive)
        error =
          "Could not load current call records. Any displayed records may be stale. Refresh to retry.";
    } finally {
      if (alive) busy = false;
    }
  }
</script>

<section class="card" aria-label="My Agent call records">
  <div class="page-heading">
    <h2>My Agent call records</h2>
    <button onclick={() => load()} disabled={busy}>Refresh call records</button>
  </div>
  <p class="muted">
    Recorded remote MCP calls for your account only. No arguments, results or
    credentials are shown. Audit must be enabled by your operator; this is not a
    complete activity history.
  </p>
  <p class="notice">
    Pending: no final observation, not proof of failure. Returned: a valid
    backend response, not settlement or delivery proof. Rejected: a definite
    call failure. Unknown: the write outcome is uncertain. Never replay a write
    merely because its record is pending or unknown.
  </p>
  {#if error}<p class="notice error" role="alert">{error}</p>{/if}
  <p class="small muted">
    On narrow screens, scroll the table horizontally to review all columns.
  </p>
  <div
    class="table-wrap"
    role="region"
    aria-label="My call records table, scroll horizontally for all columns"
  >
    <table>
      <thead
        ><tr
          ><th>Tool / call</th><th>Client / connection</th><th
            >Observed outcome</th
          ><th>Recorded time</th></tr
        ></thead
      >
      <tbody>
        {#each items as item (item.id)}
          <tr>
            <td
              ><strong>{item.tool_name}</strong>
              <p class="small muted">
                {item.mutation ? "Write" : "Read"} · {item.id}
              </p></td
            >
            <td
              >{item.client_id}
              <p class="small muted">{item.grant_id}</p>
              <p class="small">{item.resource}</p></td
            >
            <td><span class="badge">{item.outcome}</span></td>
            <td
              >Admitted {dateTime(item.admitted_at)}
              <p class="small muted">
                {item.finished_at
                  ? `Observed ${dateTime(item.finished_at)}`
                  : "No final observation"}
              </p></td
            >
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  {#if busy}<p role="status">
      Loading call records…
    </p>{:else if loaded && !items.length && !error}<p>
      No recorded calls found. Auditing may be disabled; this does not prove
      that no calls occurred.
    </p>{/if}
  {#if cursor}<button disabled={busy || !!error} onclick={() => load(cursor!)}
      >Older call records</button
    >{/if}
  <p class="small muted">
    Newest admissions first, 20 per page; no frozen snapshot. Refresh returns to
    the newest records. Revocation does not undo calls or remove these records.
  </p>
</section>
