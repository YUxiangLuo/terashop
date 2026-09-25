<script lang="ts">
  import { page } from "$app/state";
  import { replaceState } from "$app/navigation";
  import { onMount } from "svelte";
  import { supabase, message } from "$lib/api";
  import { mediaExtensions } from "$lib/media";
  import {
    adminProductMediaPage,
    id as uuid,
  } from "../../../../../mcp/src/schemas";
  let product = $state(page.url.searchParams.get("product") ?? ""),
    applied = $state("");
  let rows = $state<typeof adminProductMediaPage._output.items>([]),
    cursor = $state<string | null>(null);
  let busy = $state(false),
    error = $state(""),
    notice = $state("");
  let inspections = $state<
    Record<string, { size: number; sha256: string; url: string }>
  >({});
  let file = $state<File | null>(null),
    mediaId = $state<string>(crypto.randomUUID()),
    attempted = $state(false);
  let uploadPath = $state(""),
    expectedHash = $state("");
  onMount(() => {
    const retained = page.url.searchParams;
    if (retained.has("media")) {
      attempted = true;
      try {
        mediaId = uuid.parse(retained.get("media")).toLowerCase();
        expectedHash = retained.get("sha256") ?? "";
        const type = retained.get("type") as keyof typeof mediaExtensions;
        if (
          !/^[a-f0-9]{64}$/.test(expectedHash) ||
          !Object.hasOwn(mediaExtensions, type)
        )
          throw Error(
            "Invalid retained upload identity. Do not create a replacement upload.",
          );
        uploadPath = `products/${uuid.parse(product).toLowerCase()}/${mediaId}.${mediaExtensions[type]}`;
        notice =
          "Retained upload attempt. List and inspect the original path; a missing record does not prove an in-flight upload failed.";
      } catch (e) {
        error = message(e);
        return;
      }
    }
    if (product) void load(false);
  });
  async function load(more: boolean) {
    if (busy) return;
    busy = true;
    error = "";
    try {
      const target = more ? applied : uuid.parse(product).toLowerCase();
      const r = await supabase.rpc("list_admin_product_media", {
        product_id: target,
        page_size: 20,
        ...(more && cursor ? { after_id: cursor } : {}),
      });
      if (r.error) throw r.error;
      const p = adminProductMediaPage.parse(r.data);
      rows = more
        ? [
            ...rows,
            ...p.items.filter((x) => !rows.some((old) => old.id === x.id)),
          ]
        : p.items;
      cursor = p.next_cursor;
      applied = target;
    } catch (e) {
      error = message(e);
    } finally {
      busy = false;
    }
  }
  async function inspect(row: (typeof rows)[number]) {
    if (busy) return;
    busy = true;
    error = "";
    try {
      const check = await supabase.rpc("is_admin");
      if (check.error || !check.data)
        throw Error("Admin authorization required.");
      const path = `products/${uuid.parse(row.product_id).toLowerCase()}/${uuid.parse(row.media_id).toLowerCase()}.${mediaExtensions[row.expected_content_type]}`;
      const url = supabase.storage.from("catalog-media").getPublicUrl(path)
        .data.publicUrl;
      const response = await fetch(url, {
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
      if (
        !response.ok ||
        response.headers.get("content-type")?.split(";")[0].trim() !==
          row.expected_content_type ||
        !response.body
      )
        throw Error(
          "Public bytes could not be verified. This does not prove an in-flight upload failed.",
        );
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 5242880)
            throw Error("Media exceeds the 5 MiB inspection limit.");
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      if (!size) throw Error("Empty media.");
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const hash = [
        ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      ]
        .map((x) => x.toString(16).padStart(2, "0"))
        .join("");
      inspections[row.id] = { size, sha256: hash, url };
    } catch (e) {
      error = message(e);
    } finally {
      busy = false;
    }
  }
  async function upload() {
    if (busy || attempted || !file) return;
    error = "";
    notice = "";
    try {
      const productId = uuid.parse(product).toLowerCase();
      const type = file.type as keyof typeof mediaExtensions;
      if (
        !Object.hasOwn(mediaExtensions, type) ||
        file.size < 1 ||
        file.size > 1048576
      )
        throw Error("Choose JPEG, PNG or WebP, 1 byte to 1 MiB.");
      if (
        !confirm(
          "Permanently publish these bytes? They will be public immediately and cannot be overwritten or deleted. No product attachment is created. Never upload private data.",
        )
      )
        return;
      busy = true;
      const p = await supabase.rpc("get_admin_product", {
        product_id: productId,
      });
      if (p.error) throw p.error;
      if (!p.data) throw Error("Product not found.");
      const bytes = await file.arrayBuffer();
      expectedHash = [
        ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      ]
        .map((x) => x.toString(16).padStart(2, "0"))
        .join("");
      uploadPath = `products/${productId}/${mediaId}.${mediaExtensions[type]}`;
      const retained = new URL(page.url);
      retained.search = new URLSearchParams({
        product: productId,
        media: mediaId,
        sha256: expectedHash,
        type,
      }).toString();
      replaceState(retained, page.state);
      attempted = true;
      const r = await supabase.storage
        .from("catalog-media")
        .upload(uploadPath, bytes, { contentType: type, upsert: false });
      if (r.error) throw r.error;
      if (r.data.path !== uploadPath) throw Error("Unconfirmed upload path.");
      notice =
        "Public upload acknowledged. Inspect the bytes before attaching the URL in the product editor.";
    } catch (e) {
      error = `${message(e)} ${attempted ? "Do not allocate a replacement ID or retry automatically. List and inspect this exact path and compare the original hash." : ""}`;
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>Public product media · Tera Admin</title></svelte:head>
<div class="page-heading">
  <div>
    <a href="/media">← Managed media</a>
    <h1>Public product media</h1>
  </div>
</div>
<p class="notice">
  Compatibility tools for immutable public product uploads. Prefer managed media
  for private staging. Storage records may be unattached or outlive a product.
  Inspection does not prove attachment, complete references or deletion safety.
  Legacy seed paths are not listed.
</p>
<form
  class="card toolbar"
  onsubmit={(e) => {
    e.preventDefault();
    void load(false);
  }}
>
  <label
    >Product UUID<input
      required
      bind:value={product}
      disabled={busy || attempted}
    /></label
  ><button disabled={busy}>List public media</button>
</form>
{#if error}<p class="notice error" role="alert">{error}</p>{/if}{#if notice}<p
    class="notice"
    role="status"
  >
    {notice}
  </p>{/if}
<section class="card fields">
  <h2>Public upload</h2>
  <label>Media UUID<input readonly value={mediaId} /></label><label
    >Image<input
      type="file"
      accept="image/jpeg,image/png,image/webp"
      disabled={busy || attempted}
      onchange={(e) => (file = e.currentTarget.files?.[0] ?? null)}
    /></label
  ><button disabled={busy || attempted || !file} onclick={upload}
    >Publish immutable public bytes</button
  >{#if uploadPath}<p>Original path: <code>{uploadPath}</code></p>
    <p>Original SHA-256: <code>{expectedHash}</code></p>
    <p>
      This URL retains the original identity and hash across reloads. No
      automatic retry or replacement upload.
    </p>{/if}
</section>
<section class="card">
  <h2>Storage records</h2>
  <div class="table-wrap">
    <table>
      <thead
        ><tr><th>Path</th><th>Expected MIME</th><th>Inspect bytes</th></tr
        ></thead
      ><tbody
        >{#each rows as row}<tr
            ><td>{row.path}</td><td>{row.expected_content_type}</td><td
              ><button disabled={busy} onclick={() => inspect(row)}
                >Inspect {row.media_id}</button
              >{#if inspections[row.id]}<p>{inspections[row.id].size} bytes</p>
                <code>{inspections[row.id].sha256}</code>
                <p>
                  <a
                    href={inspections[row.id].url}
                    target="_blank"
                    rel="noopener noreferrer">Open public bytes</a
                  >
                </p>{/if}</td
            ></tr
          >{/each}</tbody
      >
    </table>
  </div>
  {#if cursor}<button disabled={busy} onclick={() => load(true)}
      >More media</button
    >{/if}
</section>

<style>
  .card {
    min-width: 0;
  }
  .fields {
    grid-template-columns: minmax(0, 1fr);
  }
  code,
  td {
    overflow-wrap: anywhere;
  }
  table {
    min-width: 38rem;
  }
  td {
    max-width: 18rem;
  }
</style>
