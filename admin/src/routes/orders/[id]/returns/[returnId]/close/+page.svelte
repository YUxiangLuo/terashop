<script lang="ts">
  import { page } from "$app/state";
  import ReturnCloseEditor from "$lib/ReturnCloseEditor.svelte";
</script>

{#key `${page.params.id}:${page.params.returnId}`}<ReturnCloseEditor
    orderId={page.params.id ?? ""}
    returnId={page.params.returnId ?? ""}
  />{/key}
