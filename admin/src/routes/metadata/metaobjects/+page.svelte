<script lang="ts">
  import { goto } from "$app/navigation";
  import MetadataList from "$lib/MetadataList.svelte";
</script>

<div class="page-heading">
  <div>
    <a href="/metadata">← Metadata</a>
    <h1>Metaobject definitions</h1>
  </div>
  <button
    class="primary"
    onclick={() => goto(`/metadata/metaobjects/${crypto.randomUUID()}?new=1`)}
    >New definition</button
  >
</div>
<MetadataList mode="metaobject-definitions" />
