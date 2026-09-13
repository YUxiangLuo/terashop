<script lang="ts">
  import { page } from "$app/state";
  import ProductEditor from "$lib/ProductEditor.svelte";
</script>

{#key page.params.id}
  <ProductEditor
    id={page.params.id ?? ""}
    creating={page.url.searchParams.get("new") === "1"}
  />
{/key}
