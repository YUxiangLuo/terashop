<script lang="ts">
  import Collection from "$lib/Collection.svelte";
  let { data } = $props();
</script>

<Collection title="The collection" products={data.products} />
