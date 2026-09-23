<script lang="ts">
  import { page } from "$app/state";
  import RefundEditor from "$lib/RefundEditor.svelte";
</script>

{#key page.params.id}<RefundEditor id={page.params.id ?? ""} />{/key}
