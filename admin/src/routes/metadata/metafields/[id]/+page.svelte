<script lang="ts">
  import { page } from "$app/state";
  import MetadataDefinitionEditor from "$lib/MetadataDefinitionEditor.svelte";
</script>

{#key page.params.id}<MetadataDefinitionEditor
    id={page.params.id ?? ""}
    kind="metafield"
    creating={page.url.searchParams.get("new") === "1"}
  />{/key}
