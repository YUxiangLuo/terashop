<script lang="ts">
  import { page } from "$app/state";
  import MetadataDefinitionEditor from "$lib/MetadataDefinitionEditor.svelte";
</script>

{#key page.params.definition}<MetadataDefinitionEditor
    id={page.params.definition ?? ""}
    kind="metaobject"
    creating={page.url.searchParams.get("new") === "1"}
  />{/key}{#if page.url.searchParams.get("new") !== "1"}<p>
    <a href={`/metadata/metaobjects/${page.params.definition}/entries`}
      >Manage entries →</a
    >
  </p>{/if}
