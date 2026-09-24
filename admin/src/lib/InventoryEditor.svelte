<script lang="ts">
  import { onMount } from "svelte";
  import { beforeNavigate } from "$app/navigation";
  import InventoryHistory from "./InventoryHistory.svelte";
  import { watchAdminChanges } from "./realtime";
  import { variantLabel } from "./catalog";
  import {
    allowsNewInventoryOperation,
    inventoryLocationSelection,
  } from "./inventory-locations";
  import {
    supabase,
    message,
    type ProductDetail,
    type Location,
    type Inventory,
  } from "./api";
  import {
    commandKey,
    readCommand,
    dispatchCommand,
    isStockCommand,
    type StockCommand,
  } from "./commands";

  let {
    product,
    disabled = false,
    preferredSku = "",
    unsettled = $bindable(false),
  }: {
    product: ProductDetail;
    disabled?: boolean;
    preferredSku?: string;
    unsettled?: boolean;
  } = $props();
  let locations = $state<Location[]>([]);
  let location = $state("");
  let variant = $state("");
  let inventory = $state<Inventory | null>(null);
  let delta = $state<number | undefined>(undefined);
  let note = $state("");
  let busy = $state(false);
  let ready = $state(false);
  let error = $state("");
  let notice = $state("");
  let pending = $state<StockCommand | null>(null);
  let historyVersion = $state(0);
  let live = $state(false);
  let changes = $state(0),
    checked = $state(0);
  let dirty = $derived(!pending && (delta !== undefined || note.length > 0));
  let operationAllowed = $derived(
    allowsNewInventoryOperation(locations, location),
  );
  $effect(() => {
    unsettled = busy || dirty;
  });
  let key = "";
  let alive = true;
  let generation = 0;

  onMount(() => {
    void init();
    const stop = watchAdminChanges(
      supabase,
      "inventory",
      () => changes++,
      (value) => (live = value),
    );
    return () => {
      alive = false;
      generation++;
      stop();
    };
  });
  beforeNavigate(({ cancel }) => {
    if (
      busy ||
      (dirty &&
        !window.confirm(
          "Discard unsaved stock quantity and note? Dispatched operations remain saved in this tab.",
        ))
    )
      cancel();
  });
  function selectTarget(kind: "variant" | "location", next: string) {
    const current = kind === "variant" ? variant : location;
    if (next === current) return;
    if (
      dirty &&
      !window.confirm(
        "Discard unsaved stock quantity and note before changing the inventory target?",
      )
    )
      return;
    delta = undefined;
    note = "";
    if (kind === "variant") variant = next;
    else location = next;
    void refresh();
  }
  async function init() {
    busy = true;
    try {
      const session = await supabase.auth.getSession();
      if (session.error || !session.data.session)
        throw new Error("Sign in again to manage stock.");
      key = commandKey(session.data.session.user.id, "stock", product.id);
      const saved = readCommand(sessionStorage, key, isStockCommand);
      if (
        saved &&
        !product.variants.some((item) => item.id === saved.variant_id)
      )
        throw new Error(
          "An unresolved stock operation belongs to a removed variant. Resolve it before making another adjustment.",
        );
      const items: Location[] = [];
      let cursor: string | null = null;
      do {
        const result = await supabase.rpc("list_admin_locations", {
          page_size: 100,
          ...(cursor ? { after_id: cursor } : {}),
        });
        if (result.error) throw result.error;
        const page = result.data as unknown as {
          items: Location[];
          next_cursor: string | null;
        };
        items.push(...page.items);
        cursor = page.next_cursor;
      } while (cursor && alive);
      if (!alive) return;
      locations = items;
      pending = saved;
      location = inventoryLocationSelection(items, saved?.location_id);
      variant =
        saved?.variant_id ??
        product.variants.find(
          (item) =>
            item.track_inventory &&
            preferredSku &&
            item.sku?.toLowerCase().includes(preferredSku.toLowerCase()),
        )?.id ??
        product.variants.find((item) => item.track_inventory)?.id ??
        "";
      ready = true;
      await refresh();
    } catch (cause) {
      if (alive) error = message(cause);
    } finally {
      if (alive) busy = false;
    }
  }
  async function refresh() {
    const current = ++generation;
    const version = changes;
    inventory = null;
    if (!variant || !location) return;
    busy = true;
    error = "";
    try {
      const result = await supabase.rpc("get_inventory_availability", {
        variant_id: variant,
        location_id: location,
      });
      if (!alive || current !== generation) return;
      if (result.error) throw result.error;
      inventory = result.data as unknown as Inventory;
      checked = version;
      historyVersion++;
    } catch (cause) {
      if (alive && current === generation) error = message(cause);
    } finally {
      if (alive && current === generation) busy = false;
    }
  }
  async function adjust(event?: SubmitEvent) {
    event?.preventDefault();
    if (busy || disabled || !ready || (!pending && !operationAllowed)) return;
    if (
      !pending &&
      (!inventory ||
        !Number.isInteger(delta) ||
        !delta ||
        Math.abs(delta) > 2147483647)
    )
      return;
    if (
      !window.confirm(
        pending
          ? "Retry the saved stock operation with the SAME request key? It will not apply twice."
          : `Apply ${delta! > 0 ? "+" : ""}${delta} units to this variant at the selected location?`,
      )
    )
      return;
    busy = true;
    error = "";
    notice = "";
    try {
      const command: StockCommand = pending ?? {
        variant_id: variant,
        location_id: location,
        delta: delta!,
        note,
        reason: "adjust",
        idempotency_key: crypto.randomUUID(),
      };
      pending = command;
      await dispatchCommand(
        sessionStorage,
        key,
        command,
        (args) => supabase.rpc("adjust_inventory", args),
        (data) => {
          const row = data as Inventory | null;
          return (
            !!row &&
            row.variant_id === command.variant_id &&
            row.location_id === command.location_id &&
            Number.isInteger(row.on_hand)
          );
        },
      );
      if (!alive) return;
      pending = null;
      delta = undefined;
      note = "";
      notice = "Stock adjustment confirmed.";
      await refresh();
    } catch (cause) {
      if (alive) {
        try {
          pending = readCommand(sessionStorage, key, isStockCommand);
        } catch {
          ready = false;
        }
        error = `${message(cause)} ${pending ? "The operation may have succeeded. Refresh stock, then retry only the saved operation; do not create a replacement." : "No stock adjustment was confirmed. Review the inputs before submitting again."}`;
      }
    } finally {
      if (alive) busy = false;
    }
  }
</script>

<svelte:window
  onbeforeunload={(event) => {
    if (busy || dirty) event.preventDefault();
  }}
/>
<section class="card" aria-label="Inventory">
  <div class="section-heading">
    <div>
      <p class="eyebrow">Stock control</p>
      <h2>Inventory</h2>
    </div>
    <button
      type="button"
      onclick={() => (ready ? refresh() : init())}
      disabled={busy}>Refresh stock</button
    >
  </div>
  <p class="small muted">
    Physical stock and active checkout reservations are separate. Adjustments
    are saved independently of product details.
  </p>
  {#if disabled}<p class="notice">
      Save or discard product edits before adjusting stock.
    </p>{/if}
  <p class="small muted">
    {live
      ? "Live stock notifications connected."
      : "Live stock notifications unavailable; refresh to check current facts."}
    Reservation expiry alone may not send a notification.
  </p>
  {#if changes > checked}<p class="notice" role="status">
      Inventory may have changed. Refresh stock to check current balances and
      movements. Inputs and saved operations are preserved; a balance does not
      prove an operation succeeded.
    </p>{/if}
  {#if error}<p class="notice error" role="alert">{error}</p>{/if}
  {#if notice}<p class="notice" role="status">{notice}</p>{/if}
  {#if pending}
    <div class="notice" role="status">
      <strong
        >Unresolved stock operation: {pending.delta! > 0
          ? "+"
          : ""}{pending.delta} units</strong
      >
      <p class="small">
        Request {pending.idempotency_key}. The original parameters are retained
        in this tab across reloads. An inventory reading alone cannot prove
        whether this operation succeeded.
      </p>
      <button type="button" onclick={() => adjust()} disabled={busy || disabled}
        >Retry saved adjustment</button
      >
    </div>
  {/if}
  <fieldset disabled={busy || !!pending || !ready || disabled}>
    <div class="fields two">
      <label
        >Variant<select
          value={variant}
          onchange={(event) => {
            selectTarget("variant", event.currentTarget.value);
            event.currentTarget.value = variant;
          }}
          >{#each product.variants.filter((item) => item.track_inventory) as item}<option
              value={item.id}
              >{variantLabel(item, product.options)} · {item.sku ||
                item.id.slice(0, 8)}{item.is_active
                ? ""
                : " · Inactive"}</option
            >{/each}</select
        ></label
      >
      <label
        >Location<select
          value={location}
          onchange={(event) => {
            selectTarget("location", event.currentTarget.value);
            event.currentTarget.value = location;
          }}
          >{#each locations as item}<option value={item.id}
              >{item.name}{item.is_default ? " · Default" : ""}{item.is_active
                ? ""
                : " · Inactive (history only)"}</option
            >{/each}</select
        ></label
      >
    </div>
  </fieldset>
  {#if inventory}
    <dl class="metrics">
      <div>
        <dt>On hand</dt>
        <dd>{inventory.on_hand}</dd>
      </div>
      <div>
        <dt>Reserved</dt>
        <dd>{inventory.reserved}</dd>
      </div>
      <div>
        <dt>Available</dt>
        <dd>{inventory.available}</dd>
      </div>
    </dl>
    {#if !operationAllowed}<p class="notice" role="status">
        This warehouse is inactive. Current balances and movement history remain
        available, but new stock adjustments are disabled.
      </p>{/if}
    <form onsubmit={adjust}>
      <fieldset
        disabled={busy || !!pending || !ready || disabled || !operationAllowed}
      >
        <div class="fields two">
          <label
            >Quantity change<input
              type="number"
              step="1"
              min="-2147483647"
              max="2147483647"
              required
              bind:value={delta}
              placeholder="e.g. 10 or -2"
            /></label
          ><label
            >Adjustment note<input
              bind:value={note}
              maxlength="1000"
              placeholder="e.g. Stock count correction"
            /></label
          >
        </div>
        <button class="primary form-action" disabled={!delta}
          >Confirm stock adjustment</button
        >
      </fieldset>
    </form>
  {:else if busy}<p role="status">Loading inventory…</p>{:else if ready}<p
      class="empty"
    >
      No tracked variant or active location available. Save a tracked variant
      before managing stock.
    </p>{/if}
  {#if ready && variant && location}
    {#key `${variant}:${location}:${historyVersion}`}<InventoryHistory
        {variant}
        {location}
      />{/key}
  {/if}
</section>
