<script lang="ts">
  import { page } from "$app/state";
  import TransferEditor from "$lib/TransferEditor.svelte";
</script>

{#key page.params.id}<TransferEditor productId={page.params.id ?? ""} />{/key}
