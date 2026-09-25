<script lang="ts">
  import { page } from "$app/state";
  import MetadataValueEditor from "$lib/MetadataValueEditor.svelte";
  import type { MetafieldOwner } from "$lib/metadata";
</script>

{#key `${page.params.id}:${page.url.searchParams.get("owner_type")}:${page.url.searchParams.get("owner_id")}:${page.url.searchParams.get("product")}`}<MetadataValueEditor
    id={page.params.id ?? ""}
    ownerType={(page.url.searchParams.get("owner_type") ??
      "category") as MetafieldOwner}
    ownerId={page.url.searchParams.get("owner_id") ?? ""}
    productId={page.url.searchParams.get("product") ?? ""}
    creating={page.url.searchParams.get("new") === "1"}
  />{/key}
