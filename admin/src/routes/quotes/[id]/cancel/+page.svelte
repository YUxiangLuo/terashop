<script lang="ts">
  import { page } from "$app/state";
  import QuoteCancelEditor from "$lib/QuoteCancelEditor.svelte";
</script>

{#key page.params.id}<QuoteCancelEditor
    id={page.params.id ?? ""}
    query={page.url.search}
  />{/key}
