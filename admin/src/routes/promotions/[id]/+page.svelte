<script lang="ts">
  import { page } from "$app/state";
  import PromotionEditor from "$lib/PromotionEditor.svelte";
</script>

{#key page.params.id}<PromotionEditor
    id={page.params.id ?? ""}
    creating={page.url.searchParams.get("new") === "1"}
  />{/key}
