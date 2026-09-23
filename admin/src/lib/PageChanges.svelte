<script lang="ts">
  import { onMount } from "svelte";
  import { supabase } from "./api";
  import { watchAdminChanges, type AdminChangeScope } from "./realtime";
  let { scopes }: { scopes: AdminChangeScope[] } = $props();
  // Initial subscription requires reconciliation too. Render its reminder now
  // rather than moving page controls under a click when SUBSCRIBED arrives.
  let stale = $state(true);
  let connected = $state<AdminChangeScope[]>([]);
  onMount(() => {
    const stops = scopes.map((scope) =>
      watchAdminChanges(
        supabase,
        scope,
        () => (stale = true),
        (online) =>
          (connected = online
            ? [...connected.filter((s) => s !== scope), scope]
            : connected.filter((s) => s !== scope)),
      ),
    );
    return () => stops.forEach((stop) => stop());
  });
</script>

<section aria-label="Page change notifications">
  <p class="small muted">
    {connected.length === scopes.length
      ? "Live page notifications connected."
      : "Live page notifications unavailable or reconnecting; check current facts explicitly."}
  </p>
  {#if stale}<p class="notice" role="status">
      Data used by this page may have changed. Use the page's refresh or reload
      action to check current facts; if none is available, reopen it after
      saving or resolving your work. Forms, filters, pagination, confirmations
      and saved operations have not been changed. A notification is not proof
      that an operation succeeded. Dismissing this reminder does not refresh
      data.
    </p>
    <button type="button" onclick={() => (stale = false)}
      >Dismiss change reminder</button
    >{/if}
</section>
