<script lang="ts">
  import { page } from "$app/state";
  import LocationEditor from "$lib/LocationEditor.svelte";
</script>

{#key page.params.id}<LocationEditor
    id={page.params.id ?? ""}
    creating={page.url.searchParams.get("new") === "1"}
  />{/key}
