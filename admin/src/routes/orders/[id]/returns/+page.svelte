<script lang="ts">
  import { page } from "$app/state";
  import ReturnEditor from "$lib/ReturnEditor.svelte";
</script>

{#key page.params.id}<ReturnEditor id={page.params.id ?? ""} />{/key}
