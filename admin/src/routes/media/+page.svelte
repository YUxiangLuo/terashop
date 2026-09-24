<script lang="ts">
  import ManagedMediaList from "$lib/ManagedMediaList.svelte";
</script>

<svelte:head><title>Managed media · Tera Admin</title></svelte:head>
<div class="page-heading">
  <div>
    <p class="eyebrow">Catalog</p>
    <h1>Managed media</h1>
    <p class="small muted">
      Find Agent and browser uploads by original request ID, and explicitly
      clean up eligible private settled media.
    </p>
  </div>
</div>
<ManagedMediaList />
