<script lang="ts">
  import { page } from "$app/state";
  import ReturnReceiveEditor from "$lib/ReturnReceiveEditor.svelte";
</script>

{#key `${page.params.id}:${page.params.returnId}`}<ReturnReceiveEditor
    orderId={page.params.id ?? ""}
    returnId={page.params.returnId ?? ""}
  />{/key}
