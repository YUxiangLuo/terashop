<script lang="ts">
  import Collection from "$lib/Collection.svelte";
  let { data } = $props();
</script>

<Collection title={data.category.name} products={data.products} />
