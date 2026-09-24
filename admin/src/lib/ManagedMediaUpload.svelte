<script lang="ts">
  import { onMount } from "svelte";
  import { supabase, message, type ProductImage } from "./api";
  import { readCommand } from "./commands";
  import {
    isMediaRequest,
    mediaFile,
    mediaReceipt,
    mediaExtensions,
    sameMedia,
    managedMedia,
    type MediaRequest,
    type ManagedMedia,
  } from "./media";

  let {
    productId,
    savedImages,
    disabled,
    onbusy,
    onattach,
  }: {
    productId: string;
    savedImages: ProductImage[];
    disabled: boolean;
    onbusy: (busy: boolean) => void;
    onattach: (id: string, url: string) => void;
  } = $props();
  let pending = $state<MediaRequest | null>(null);
  let media = $state<ManagedMedia | null>(null);
  let busy = $state(false),
    ready = $state(false),
    error = $state("");
  let key = "",
    alive = true;
  let recoveryId = $state("");

  onMount(() => {
    void run(async () => {
      const { data, error } = await supabase.auth.getSession();
      if (error || !data.session) throw Error("Sign in again to upload media.");
      key = `tera-admin-media:${data.session.user.id}:${productId}`;
      pending = readCommand(sessionStorage, key, isMediaRequest);
      if (pending) await refresh();
      ready = true;
    });
    return () => {
      alive = false;
    };
  });

  // Do not lose a published upload on reload before the product save succeeds.
  $effect(() => {
    if (
      media?.published &&
      savedImages.some(
        (image) => image.id === media?.id && image.url === publicUrl(media),
      )
    ) {
      try {
        sessionStorage.removeItem(key);
        pending = null;
        media = null;
      } catch (cause) {
        error = message(cause);
        ready = false;
      }
    }
  });

  function publicUrl(value: ManagedMedia) {
    return supabase.storage
      .from("catalog-media")
      .getPublicUrl(
        `managed/${value.id}.${mediaExtensions[value.content_type]}`,
      ).data.publicUrl;
  }
  async function run(action: () => Promise<void>) {
    if (busy) return;
    busy = true;
    onbusy(true);
    error = "";
    try {
      await action();
    } catch (cause) {
      if (alive) {
        media = null;
        if (pending) ready = false;
        error = `${message(cause)} No automatic retry. Check current state before another action.`;
      }
    } finally {
      if (alive) {
        busy = false;
        onbusy(false);
      }
    }
  }
  async function refresh() {
    if (!pending) return;
    const { data, error } = await supabase.rpc("list_admin_managed_media", {
      request_id_filter: pending.request_id,
      page_size: 1,
    });
    if (error) throw error;
    if (
      !data ||
      typeof data !== "object" ||
      !("items" in data) ||
      !Array.isArray(data.items)
    )
      throw Error("Unconfirmed media list.");
    media = data.items.length ? mediaReceipt(data.items[0], pending) : null;
  }
  async function recoverRequest() {
    if (busy || disabled || !ready || pending) return;
    await run(async () => {
      const requestId = recoveryId.trim().toLowerCase();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(requestId))
        throw Error("Enter the original request UUID.");
      const { data, error } = await supabase.rpc("list_admin_managed_media", {
        request_id_filter: requestId,
        page_size: 1,
      });
      if (error) throw error;
      if (
        !data ||
        typeof data !== "object" ||
        !("items" in data) ||
        !Array.isArray(data.items)
      )
        throw Error("Unconfirmed media list.");
      if (data.items.length !== 1)
        throw Error("No managed media matches that request ID.");
      const found = managedMedia(data.items[0]);
      const request: MediaRequest = {
        request_id: found.request_id,
        content_type: found.content_type,
        byte_size: found.byte_size,
        sha256: found.sha256,
      };
      sessionStorage.setItem(key, JSON.stringify(request));
      pending = request;
      media = found;
      recoveryId = "";
    });
  }
  async function command(body: Record<string, unknown>) {
    const { data, error } = await supabase.functions.invoke("managed-media", {
      body,
    });
    if (error) throw Error("Media request failed or its response was lost.");
    const next = mediaReceipt(data, pending!);
    if (media && next.id !== media.id) throw Error("Media identity mismatch.");
    media = next;
  }
  async function upload(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (
      !file ||
      busy ||
      !ready ||
      disabled ||
      (media && media.upload_status !== "not_started")
    )
      return;
    await run(async () => {
      const { request, data_base64 } = await mediaFile(
        file,
        pending?.request_id ?? crypto.randomUUID(),
      );
      if (pending && !sameMedia(request, pending))
        throw Error(
          "Reselect the original file; different bytes cannot reuse this request ID.",
        );
      if (
        pending &&
        !window.confirm(
          "Retry the same upload request with the original bytes? No new media identity will be allocated.",
        )
      )
        return;
      // Persist identity before any write; never store image bytes or Auth tokens.
      sessionStorage.setItem(key, JSON.stringify(request));
      pending = request;
      await command({
        action: "upload",
        request_id: request.request_id,
        content_type: request.content_type,
        data_base64,
      });
    });
  }
  async function act(action: "recover" | "publish") {
    if (busy || disabled || !ready || !media) return;
    if (
      action === "publish" &&
      !window.confirm(
        "Permanently publish these bytes? Anyone with the URL can read them, even for a draft product. Published media cannot be deleted through Admin or MCP.",
      )
    )
      return;
    const media_id = media.id;
    await run(() => command({ action, media_id }));
  }
</script>

<div class="upload">
  <p class="small muted">
    New images are privately staged first. Publication is permanent and separate
    from saving the product. JPEG, PNG or WebP · Up to 1 MiB.
  </p>
  {#if error}<p class="notice error" role="alert">{error}</p>{/if}
  {#if ready && !pending}
    <div class="recovery">
      <label
        >Original request ID<input
          aria-label="Original request ID"
          bind:value={recoveryId}
          placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
          onkeydown={(event) => { if (event.key === "Enter") { event.preventDefault(); void recoverRequest(); } }}
        /></label
      >
      <button type="button" onclick={recoverRequest} disabled={busy || disabled}
        >Recover another tab or Agent upload</button
      >
    </div>
    <p class="small muted">
      This only reads the original server record. It does not retry, publish,
      attach, or store bytes.
    </p>
  {/if}
  {#if pending}
    <p class="small">Request: {pending.request_id}</p>
    <p class="small muted">
      Recovery is retained in this tab until the image is saved on the product.
      Closing the tab loses this record; keep the request ID for MCP recovery.
      No automatic retry or deletion.
    </p>
    <button
      type="button"
      disabled={busy || disabled}
      onclick={() =>
        run(async () => {
          await refresh();
          ready = true;
        })}>Check media state</button
    >
    <p role="status">
      {media
        ? `Media state: ${media.state} · ${media.published ? "public" : "not confirmed public"} · upload ${media.upload_status}`
        : "Upload unconfirmed. Check state, or reselect the original file to retry the same request."}
    </p>
  {/if}
  {#if !media || (media.state === "uploading" && media.upload_status === "not_started")}
    <label
      >{pending ? "Reselect original image" : "Stage an image"}<input
        type="file"
        accept="image/jpeg,image/png,image/webp"
        onchange={upload}
        disabled={busy || disabled || !ready}
      /></label
    >
  {:else if media.published}
    <button
      type="button"
      disabled={busy || disabled || !ready}
      onclick={() => onattach(media!.id, publicUrl(media!))}
      >Add published image to form</button
    >
    <p class="small muted">
      Save the product to finish attaching this image and enable another upload.
    </p>
  {:else if media.state === "uploading"}
    <button
      type="button"
      disabled={busy || disabled || !ready}
      onclick={() => act("recover")}>Recover staged bytes</button
    >
    <p class="small muted">
      Recovery verifies bytes without rewriting them. If no bytes can be
      verified, preserve this request ID for operator investigation.
    </p>
  {:else if media.state === "staged" || media.state === "retained"}
    <button
      type="button"
      disabled={busy || disabled || !ready}
      onclick={() => act("publish")}>Publish image permanently</button
    >
  {:else if media.state === "discarded"}
    <p>Private media deletion is confirmed.</p>
    <button
      type="button"
      disabled={busy || disabled || !ready}
      onclick={() =>
        run(async () => {
          await refresh();
          if (media?.state !== "discarded")
            throw Error("Deletion is not confirmed.");
          sessionStorage.removeItem(key);
          pending = null;
          media = null;
        })}>Finish discarded upload</button
    >
  {:else}
    <p>
      Media discard is in progress or complete. Use MCP to inspect its state
      before starting another upload.
    </p>
  {/if}
</div>

<style>
  .upload {
    overflow-wrap: anywhere;
  }
  .recovery {
    display: flex;
    align-items: end;
    gap: 0.7rem;
    flex-wrap: wrap;
  }
  .recovery label {
    flex: 1 1 18rem;
  }
</style>
