<script lang="ts">
  import { page } from "$app/state";
  import ReturnDispositionEditor from "$lib/ReturnDispositionEditor.svelte";
</script>

{#key `${page.params.id}:${page.params.lineId}`}<ReturnDispositionEditor
    orderId={page.params.id ?? ""}
    lineId={page.params.lineId ?? ""}
  />{/key}
