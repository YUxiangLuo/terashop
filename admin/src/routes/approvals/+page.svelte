<script lang="ts">
  import McpActionApprovals from "$lib/McpActionApprovals.svelte";
</script>

<svelte:head><title>Agent approvals · Tera Admin</title></svelte:head>
<div class="page-heading">
  <div>
    <p class="eyebrow">Human authorization</p>
    <h1>Agent action approvals</h1>
    <p class="muted">
      Review bounded high-risk requests and recover uncertain dispatches.
    </p>
  </div>
</div>
<McpActionApprovals />
