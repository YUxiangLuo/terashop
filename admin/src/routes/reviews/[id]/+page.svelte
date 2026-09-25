<script lang="ts">
  import { page } from "$app/state";
  import ReviewEditor from "$lib/ReviewEditor.svelte";
</script>

{#key page.params.id}<ReviewEditor id={page.params.id ?? ""} />{/key}
