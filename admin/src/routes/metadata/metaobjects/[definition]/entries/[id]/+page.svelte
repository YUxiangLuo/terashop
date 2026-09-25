<script lang="ts">
  import { page } from "$app/state";
  import MetadataObjectEditor from "$lib/MetadataObjectEditor.svelte";
</script>

{#key `${page.params.definition}:${page.params.id}`}<MetadataObjectEditor
    id={page.params.id ?? ""}
    definitionId={page.params.definition ?? ""}
    creating={page.url.searchParams.get("new") === "1"}
  />{/key}
