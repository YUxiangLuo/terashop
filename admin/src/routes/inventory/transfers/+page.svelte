<script lang="ts">
  import { page } from "$app/state";
  import { onMount } from "svelte";
  import { supabase, message } from "$lib/api";
  import { inventoryTransfer } from "../../../../../mcp/src/schemas";
  let id = $state(page.url.searchParams.get("id") ?? ""),
    busy = $state(false),
    error = $state("");
  let transfer = $state<typeof inventoryTransfer._output | null>(null);
  onMount(() => {
    if (id) void load();
  });
  async function load() {
    busy = true;
    error = "";
    transfer = null;
    try {
      const r = await supabase.rpc("get_inventory_transfer", {
        transfer_id: id,
      });
      if (r.error) throw r.error;
      if (r.data === null)
        throw Error(
          "Transfer not found. Absence is not proof an in-flight transfer failed.",
        );
      const value = inventoryTransfer.parse(r.data);
      if (value.id !== id.toLowerCase())
        throw Error("Transfer identity mismatch.");
      transfer = value;
    } catch (e) {
      error = message(e);
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>Transfer history · Tera Admin</title></svelte:head>
<div class="page-heading">
  <div>
    <h1>Transfer lookup</h1>
    <p>
      Read a completed instant transfer by its original transfer UUID, not its
      idempotency key.
    </p>
  </div>
</div>
<form
  class="card toolbar"
  onsubmit={(e) => {
    e.preventDefault();
    void load();
  }}
>
  <label>Transfer UUID<input required bind:value={id} /></label><button
    disabled={busy}>Find transfer</button
  >
</form>
{#if error}<p class="notice error" role="alert">{error}</p>{/if}
{#if transfer}<section class="card">
    <h2>Completed transfer</h2>
    <dl>
      {#each Object.entries(transfer) as [key, value]}<dt>
          {key.replaceAll("_", " ")}
        </dt>
        <dd>{value ?? "Not recorded"}</dd>{/each}
    </dl>
    <p class="notice">
      Balances above are historical. Check current inventory separately; this is
      not an in-transit or receiving workflow.
    </p>
    <a href="/inventory">Current stock</a>
  </section>{/if}
