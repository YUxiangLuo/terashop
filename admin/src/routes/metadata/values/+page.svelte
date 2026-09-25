<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import MetadataList from "$lib/MetadataList.svelte";
  import { metafieldOwners } from "$lib/metadata";
  let ownerType = $state("category"),
    ownerId = $state(""),
    productId = $state("");
  $effect(() => {
    ownerType = page.url.searchParams.get("owner_type") ?? "category";
    ownerId = page.url.searchParams.get("owner_id") ?? "";
    productId = page.url.searchParams.get("product") ?? "";
  });
  function open(e: SubmitEvent) {
    e.preventDefault();
    void goto(
      `/metadata/values?${new URLSearchParams({ owner_type: ownerType, owner_id: ownerId, ...(productId ? { product: productId } : {}) })}`,
    );
  }
</script>

<div class="page-heading">
  <div>
    <a href="/metadata">← Metadata</a>
    <h1>Owner metafields</h1>
  </div>
  {#if page.url.searchParams.get("owner_id")}<a
      class="button primary"
      href={`/metadata/values/${crypto.randomUUID()}?new=1&${page.url.search.slice(1)}`}
      >New value</a
    >{/if}
</div>
<form class="card toolbar" onsubmit={open}>
  <label
    >Owner type<select bind:value={ownerType}
      >{#each metafieldOwners as x}<option>{x}</option>{/each}</select
    ></label
  ><label>Owner UUID<input required bind:value={ownerId} /></label
  >{#if ownerType === "variant"}<label
      >Parent product UUID<input required bind:value={productId} /></label
    >{/if}<button>Open owner</button>
</form>
{#if page.url.searchParams.get("owner_id")}{#key page.url.search}<MetadataList
      mode="values"
      ownerType={page.url.searchParams.get("owner_type") ?? "category"}
      ownerId={page.url.searchParams.get("owner_id") ?? ""}
      productId={page.url.searchParams.get("product") ?? ""}
    />{/key}{:else}<p>
    Enter an explicit owner UUID. Shop owner IDs are not inferred.
  </p>{/if}
