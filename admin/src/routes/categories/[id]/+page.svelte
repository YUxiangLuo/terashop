<script lang="ts">
  import { page } from "$app/state";
  import CategoryEditor from "$lib/CategoryEditor.svelte";
</script>

{#key page.params.id}<CategoryEditor
    id={page.params.id ?? ""}
    creating={page.url.searchParams.get("new") === "1"}
  />{/key}
