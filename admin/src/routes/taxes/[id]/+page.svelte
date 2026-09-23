<script lang="ts">
  import { page } from "$app/state";
  import TaxEditor from "$lib/TaxEditor.svelte";
</script>

{#key page.params.id}<TaxEditor
    id={page.params.id ?? ""}
    creating={page.url.searchParams.get("new") === "1"}
  />{/key}
