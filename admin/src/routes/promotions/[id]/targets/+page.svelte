<script lang="ts">
  import { page } from "$app/state";
  import PromotionTargetsEditor from "$lib/PromotionTargetsEditor.svelte";
</script>

{#key page.params.id}<PromotionTargetsEditor id={page.params.id ?? ""} />{/key}
