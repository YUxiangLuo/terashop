<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import MetadataList from "$lib/MetadataList.svelte";
</script>

<div class="page-heading">
  <div>
    <a href={`/metadata/metaobjects/${page.params.definition}`}>← Definition</a>
    <h1>Metaobject entries</h1>
  </div>
  <button
    class="primary"
    onclick={() =>
      goto(
        `/metadata/metaobjects/${page.params.definition}/entries/${crypto.randomUUID()}?new=1`,
      )}>New entry</button
  >
</div>
{#key page.params.definition}<MetadataList
    mode="entries"
    definitionId={page.params.definition ?? ""}
  />{/key}
