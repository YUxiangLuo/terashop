<script lang="ts">
  import { page } from "$app/state";
  import QuoteDetail from "$lib/QuoteDetail.svelte";
</script>

{#key page.params.id}<QuoteDetail
    id={page.params.id ?? ""}
    query={page.url.search}
  />{/key}
