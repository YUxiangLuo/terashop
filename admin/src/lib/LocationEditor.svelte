<script lang="ts">
  import { onMount } from "svelte";
  import { beforeNavigate } from "$app/navigation";
  import { page } from "$app/state";
  import { supabase, message, type Location } from "./api";
  import type { Json } from "../../../types/database";
  import { locationReceipt } from "./write-receipts";
  let { id, creating }: { id: string; creating: boolean } = $props();
  let location = $state.raw<Location | null>(null);
  let fields = $state({
    name: "",
    code: "",
    address: "null",
    is_active: false,
  });
  let baseline = $state("");
  let loaded = $state(false);
  let busy = $state(false);
  let uncertain = $state(false);
  let error = $state("");
  let notice = $state("");
  let defaultLocation = $state.raw<Location | null>(null);
  let defaultLoaded = $state(false);
  let alive = true;
  let dirty = $derived(loaded && JSON.stringify(fields) !== baseline);
  let back = $derived.by(() => {
    const params = new URLSearchParams();
    for (const key of ["search", "active"]) {
      const value = page.url.searchParams.get(key);
      if (value) params.set(key, value);
    }
    return `/locations${params.size ? `?${params}` : ""}`;
  });
  onMount(() => {
    void load();
    return () => {
      alive = false;
    };
  });
  beforeNavigate(({ cancel }) => {
    if (busy || (dirty && !window.confirm("Discard unsaved warehouse edits?")))
      cancel();
  });
  function install(value: Location | null) {
    location = value;
    fields = {
      name: value?.name ?? "",
      code: value?.code ?? "",
      address: JSON.stringify(value?.address ?? null, null, 2),
      is_active: value?.is_active ?? false,
    };
    baseline = JSON.stringify(fields);
    loaded = true;
  }
  async function load() {
    busy = true;
    error = "";
    notice = "";
    defaultLoaded = false;
    try {
      const result = await supabase.rpc("get_admin_location", {
        location_id: id,
      });
      if (result.error) throw result.error;
      if (!alive) return;
      const value =
        result.data === null
          ? null
          : (locationReceipt(result.data, id, null) as unknown as Location);
      if (!value && !creating) throw Error("Warehouse not found.");
      install(value);
      // Capture the current default alongside the target revision. Never refresh this
      // expectation silently at write time: a concurrent default switch must conflict.
      let cursor: string | null = null;
      let current: Location | null = null;
      do {
        const result = await supabase.rpc("list_admin_locations", {
          active: true,
          page_size: 100,
          ...(cursor ? { after_id: cursor } : {}),
        });
        if (result.error) throw result.error;
        if (!alive) return;
        const data = result.data as unknown as {
          items: Location[];
          next_cursor: string | null;
        };
        current = data.items.find((item) => item.is_default) ?? null;
        cursor = data.next_cursor;
      } while (!current && cursor);
      defaultLocation = current;
      defaultLoaded = true;
      uncertain = false;
    } catch (cause) {
      if (alive) {
        error = message(cause);
        uncertain = true;
      }
    } finally {
      if (alive) busy = false;
    }
  }
  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (busy || !loaded || uncertain) return;
    let address: Json;
    try {
      address = JSON.parse(fields.address);
    } catch {
      error = "Address must be valid JSON. Use null to clear it.";
      return;
    }
    if (
      location &&
      fields.is_active !== location.is_active &&
      !window.confirm(
        "Change warehouse availability? Stock is not moved or cleared. Existing reservations remain.",
      )
    )
      return;
    busy = true;
    error = "";
    notice = "";
    try {
      const changes = {
        name: fields.name,
        code: fields.code,
        is_active: fields.is_active,
        address,
      };
      const result = location
        ? await supabase.rpc("update_location", {
            location_id: id,
            expected_revision: location.revision,
            changes,
          })
        : await supabase.rpc("create_location", { location_id: id, changes });
      if (result.error) throw result.error;
      if (!alive) return;
      install(
        locationReceipt(
          result.data,
          id,
          location?.revision ?? null,
        ) as unknown as Location,
      );
      if (defaultLocation?.id === id) defaultLocation = location;
      notice = "Warehouse saved. Inventory quantities are unchanged.";
    } catch (cause) {
      if (alive) {
        uncertain = true;
        error = `${message(cause)} Reload the warehouse before another command; the request may have succeeded.`;
      }
    } finally {
      if (alive) busy = false;
    }
  }
  async function makeDefault() {
    if (
      busy ||
      dirty ||
      uncertain ||
      !defaultLoaded ||
      !location?.is_active ||
      location.is_default
    )
      return;
    if (
      !window.confirm(
        `Replace ${defaultLocation?.name ?? "no default warehouse"} with ${location.name} as the default warehouse? Inventory will not move.`,
      )
    )
      return;
    busy = true;
    error = "";
    notice = "";
    try {
      const result = await supabase.rpc("set_default_location", {
        location_id: id,
        expected_revision: location.revision,
        ...(defaultLocation ? { expected_default_id: defaultLocation.id } : {}),
      });
      if (result.error) throw result.error;
      if (!alive) return;
      install(
        locationReceipt(
          result.data,
          id,
          location.revision,
        ) as unknown as Location,
      );
      defaultLocation = location;
      notice = "Default warehouse changed. Inventory quantities are unchanged.";
    } catch (cause) {
      if (alive) {
        uncertain = true;
        error = `${message(cause)} Reload the warehouse and current default before another command; the request may have succeeded.`;
      }
    } finally {
      if (alive) busy = false;
    }
  }
</script>

<svelte:head
  ><title>{location?.name ?? "New warehouse"} · Tera Admin</title></svelte:head
>
<svelte:window
  onbeforeunload={(event) => {
    if (busy || dirty) event.preventDefault();
  }}
/>
<div class="page-heading">
  <div>
    <a class="small" href={back}>← Warehouses</a>
    <h1>{location?.name ?? (creating ? "New warehouse" : "Warehouse")}</h1>
  </div>
  <div class="actions">
    <button
      disabled={busy}
      onclick={() => {
        if (
          !dirty ||
          window.confirm("Discard local edits and reload the warehouse?")
        )
          void load();
      }}>Reload warehouse</button
    ><button
      class="primary"
      form="location-form"
      disabled={busy || !loaded || uncertain || !dirty}>Save warehouse</button
    >
  </div>
</div>
{#if error}<p class="notice error" role="alert">{error}</p>{/if}
{#if notice}<p class="notice" role="status">{notice}</p>{/if}
{#if !loaded}<p role="status">
    {busy ? "Loading warehouse…" : "Unable to open warehouse."}
  </p>{:else}
  <div class="editor-grid">
    <form id="location-form" class="card" onsubmit={save}>
      <fieldset class="fields" disabled={busy || uncertain}>
        <h2>Warehouse details</h2>
        <label>Name<input required bind:value={fields.name} /></label>
        <label>Code<input required bind:value={fields.code} /></label>
        <label class="check-label"
          ><input
            type="checkbox"
            bind:checked={fields.is_active}
            disabled={location?.is_default && location?.is_active}
          />Active warehouse</label
        >
        <p class="small muted">
          New warehouses start inactive. Switch the default before deactivating
          it. Disabling does not transfer stock or clear reservations.
        </p>
        <label
          >Address (JSON)<textarea
            rows="10"
            bind:value={fields.address}
            spellcheck="false"></textarea></label
        >
        <p class="small muted">
          Preserve existing address fields. Use null to clear the address.
        </p>
      </fieldset>
    </form>
    <section class="card">
      <h2>Default warehouse</h2>
      <p class="break-word">
        {defaultLoaded
          ? (defaultLocation?.name ?? "No active default warehouse")
          : "Current default unavailable"}
      </p>
      <p class="small muted">
        Save changes before switching. Only an active, saved warehouse can
        become the default. Switching does not move existing inventory.
      </p>
      <button
        disabled={busy ||
          dirty ||
          uncertain ||
          !defaultLoaded ||
          !location?.is_active ||
          location.is_default}
        onclick={makeDefault}
        >{location?.is_default && location.is_active
          ? "This is the default"
          : "Make default warehouse"}</button
      >
      {#if location}<p class="small muted">Revision {location.revision}</p>{/if}
      <a class="small" href="/inventory">Open inventory →</a>
    </section>
  </div>
{/if}
