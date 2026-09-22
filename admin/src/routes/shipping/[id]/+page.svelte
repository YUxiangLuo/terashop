<script lang="ts">
  import { page } from "$app/state";
  import ShippingEditor from "$lib/ShippingEditor.svelte";
</script>

{#key page.params.id}<ShippingEditor
    id={page.params.id ?? ""}
    creating={page.url.searchParams.get("new") === "1"}
  />{/key}
