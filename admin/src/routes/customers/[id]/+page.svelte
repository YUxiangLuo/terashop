<script lang="ts">
  import { page } from "$app/state";
  import CustomerEditor from "$lib/CustomerEditor.svelte";
</script>

{#key page.params.id}<CustomerEditor id={page.params.id ?? ""} />{/key}
