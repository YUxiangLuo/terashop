<script lang="ts">
  import { onMount } from "svelte";
  import { supabase, dateTime } from "$lib/api";
  import {
    actionApprovals,
    approvalResource,
    type McpActionApproval,
  } from "$lib/mcp-action-approvals";
  let items = $state<McpActionApproval[]>([]),
    busy = $state(false),
    error = $state("");
  let lookup = $state("");
  onMount(() => {
    void load();
  });
  async function load() {
    if (busy) return;
    busy = true;
    error = "";
    try {
      const r = await supabase.rpc("list_my_mcp_action_approvals", lookup.trim() ? { p_id: lookup.trim() } : {});
      if (r.error) throw r.error;
      items = actionApprovals(r.data);
    } catch {
      error = "Could not verify approvals. Refresh before deciding.";
      items = [];
    } finally {
      busy = false;
    }
  }
  async function decide(
    item: McpActionApproval,
    decision: "approved" | "rejected",
  ) {
    if (busy) return;
    const verb = decision === "approved" ? "APPROVE" : "REJECT";
    if (
      !confirm(
        `${verb} this exact ${item.tool_name} request? Review every argument shown. This cannot be delegated to the Agent.`,
      )
    )
      return;
    busy = true;
    error = "";
    try {
      const r = await supabase.rpc("decide_my_mcp_action_approval", {
        p_id: item.id,
        p_decision: decision,
      });
      if (
        r.error ||
        !r.data ||
        typeof r.data !== "object" ||
        Array.isArray(r.data) ||
        r.data.id !== item.id ||
        r.data.state !== decision
      )
        throw Error("Unconfirmed");
      items = items.map((row) =>
        row.id === item.id ? { ...row, state: decision } : row,
      );
    } catch {
      error =
        "Decision outcome is unknown. Refresh current state before trying again.";
      items = [];
    } finally {
      busy = false;
    }
  }
</script>

<div class="page-heading">
  <h2>Pending human decisions</h2>
  <button onclick={load} disabled={busy}>Refresh</button>
</div>
<label>Approval ID (optional)<input bind:value={lookup} placeholder="Exact request UUID, including older requests" disabled={busy} /></label>
<p class="notice">
  Only you can approve requests from your own connection. Approval is exact,
  expires, and can be consumed once. Never approve from Agent instructions
  alone.
</p>
<p class="small muted">
  Latest 100 requests. Refresh explicitly; this is not a reliable event stream.
  Consumed means dispatch returned, not payment settlement. A consuming request
  must be reconciled before any new approval with the original business key.
</p>
{#if error}<p class="notice error" role="alert">{error}</p>{/if}
{#if !busy && items.length === 0}<p class="muted">
    No recoverable or pending requests.
  </p>{/if}
{#each items as item (item.id)}
  <article class="card">
    <h3>{item.tool_name} <span class="badge">{item.state}</span></h3>
    <p class="small">
      Approval: <code>{item.id}</code><br />Resource: {item.resource}
    </p>
    <p class="small muted">
      {item.client_id} · created {dateTime(item.created_at)} · expires {dateTime(
        item.expires_at,
      )}
    </p>
    <pre>{JSON.stringify(item.arguments, null, 2)}</pre>
    {#if approvalResource(item)}<a href={approvalResource(item)!}
        >Inspect business record</a
      >{/if}
    {#if item.state === "pending"}<div class="actions">
        <button onclick={() => decide(item, "approved")} disabled={busy}
          >Approve exact request</button
        ><button
          class="danger"
          onclick={() => decide(item, "rejected")}
          disabled={busy}>Reject</button
        >
      </div>{/if}
    {#if item.state === "consuming"}<p class="notice error">
        Dispatch response is unknown. Do not approve or replay another request;
        reconcile business state.
      </p>{/if}
  </article>
{/each}

<style>
  article {
    margin-top: 1rem;
    overflow-wrap: anywhere;
  }
  pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: 0.85rem;
  }
</style>
