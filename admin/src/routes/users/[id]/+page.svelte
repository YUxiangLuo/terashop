<script lang="ts">
  import { page } from "$app/state";
  import UserEditor from "$lib/UserEditor.svelte";
</script>

{#key page.params.id}<UserEditor id={page.params.id ?? ""} />{/key}
