<script lang="ts">
  import { page } from "$app/state";
  import OrderEditor from "$lib/OrderEditor.svelte";
</script>

{#key page.params.id}<OrderEditor id={page.params.id ?? ""} />{/key}
