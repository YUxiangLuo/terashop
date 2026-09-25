<script lang="ts">
  import { page } from "$app/state";
  import OrderActions from "$lib/OrderActions.svelte";
</script>

{#key page.params.id}<OrderActions id={page.params.id ?? ""} />{/key}
