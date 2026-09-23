<script lang="ts">
  import { onMount } from "svelte";
  import { beforeNavigate } from "$app/navigation";
  import { watchAdminChanges } from "./realtime";
  import {
    supabase,
    getProduct,
    message,
    type ProductDetail,
    type Location,
    type Inventory,
  } from "./api";
  import { variantLabel } from "./catalog";
  import { commandKey, readCommand, dispatchCommand } from "./commands";
  import {
    isTransferCommand,
    isTransferReceipt,
    type TransferCommand,
    type TransferReceipt,
  } from "./transfers";
  let { productId }: { productId: string } = $props();
  let product = $state.raw<ProductDetail | null>(null);
  let locations = $state<Location[]>([]);
  let variant = $state("");
  let from = $state("");
  let to = $state("");
  let quantity = $state<number | undefined>(undefined);
  let note = $state("");
  let busy = $state(false);
  let ready = $state(false);
  let error = $state("");
  let balanceError = $state("");
  let source = $state<Inventory | null>(null);
  let destination = $state<Inventory | null>(null);
  let pending = $state<TransferCommand | null>(null);
  let receipt = $state<TransferReceipt | null>(null);
  let live = $state(false);
  let changes = $state(0),
    checked = $state(0);
  let key = "";
  let alive = true;
  let dirty = $derived(!pending && (quantity !== undefined || note !== ""));
  onMount(() => {
    void load();
    const stop = watchAdminChanges(
      supabase,
      "inventory",
      () => changes++,
      (value) => (live = value),
    );
    return () => {
      alive = false;
      stop();
    };
  });
  beforeNavigate(({ cancel }) => {
    if (
      busy ||
      (dirty && !window.confirm("Discard unsaved transfer quantity and note?"))
    )
      cancel();
  });
  async function load() {
    busy = true;
    error = "";
    ready = false;
    try {
      const session = await supabase.auth.getSession();
      if (session.error || !session.data.session)
        throw Error("Sign in again to transfer stock.");
      key = commandKey(session.data.session.user.id, "transfer", productId);
      pending = readCommand(sessionStorage, key, isTransferCommand);
      const detail = await getProduct(productId);
      if (!alive) return;
      if (!detail) throw Error("Product not found.");
      product = detail;
      const items: Location[] = [];
      let cursor: string | null = null;
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
        items.push(...data.items);
        cursor = data.next_cursor;
      } while (cursor);
      locations = items;
      variant =
        pending?.variant_id ??
        detail.variants.find((v) => v.track_inventory)?.id ??
        "";
      from =
        pending?.from_location_id ??
        items.find((l) => l.is_default)?.id ??
        items[0]?.id ??
        "";
      to =
        pending?.to_location_id ?? items.find((l) => l.id !== from)?.id ?? "";
      quantity = pending?.quantity;
      note = pending?.note ?? "";
      ready = true;
      await balances();
    } catch (cause) {
      if (alive) error = message(cause);
    } finally {
      if (alive) busy = false;
    }
  }
  async function balances() {
    const version = changes;
    source = null;
    destination = null;
    balanceError = "";
    if (!variant || !from || !to) return;
    busy = true;
    try {
      const [a, b] = await Promise.all([
        supabase.rpc("get_inventory_availability", {
          variant_id: variant,
          location_id: from,
        }),
        supabase.rpc("get_inventory_availability", {
          variant_id: variant,
          location_id: to,
        }),
      ]);
      if (!alive) return;
      if (a.error) throw a.error;
      if (b.error) throw b.error;
      source = a.data as unknown as Inventory;
      destination = b.data as unknown as Inventory;
      checked = version;
    } catch (cause) {
      if (alive) balanceError = message(cause);
    } finally {
      if (alive) busy = false;
    }
  }
  async function transfer(event?: SubmitEvent) {
    event?.preventDefault();
    if (busy || !key || (!pending && !ready)) return;
    const command = pending ?? {
      variant_id: variant,
      from_location_id: from,
      to_location_id: to,
      quantity: quantity!,
      note,
      idempotency_key: crypto.randomUUID(),
    };
    if (
      !pending &&
      (!isTransferCommand(command) ||
        !source ||
        !destination ||
        command.quantity > source.available)
    ) {
      error =
        "Choose different active warehouses and a positive integer quantity within source availability. Refresh balances if needed.";
      return;
    }
    if (
      !window.confirm(
        pending
          ? "Retry the exact saved transfer? Do not create a replacement request."
          : `Move ${command.quantity} units immediately? This does not create an in-transit shipment or move reservations.`,
      )
    )
      return;
    busy = true;
    error = "";
    receipt = null;
    try {
      pending = command;
      let confirmed: TransferReceipt | null = null;
      await dispatchCommand(
        sessionStorage,
        key,
        command,
        (args) => supabase.rpc("transfer_inventory", args),
        (data) => {
          if (!isTransferReceipt(data, command)) return false;
          confirmed = data;
          return true;
        },
      );
      if (!alive) return;
      pending = null;
      receipt = confirmed;
      quantity = undefined;
      note = "";
      await balances();
    } catch (cause) {
      if (alive) {
        try {
          pending = readCommand(sessionStorage, key, isTransferCommand);
        } catch {
          ready = false;
        }
        error = `${message(cause)} ${pending ? "Result unknown. Only retry the saved request; balances alone do not prove success." : "Transfer not confirmed. Refresh balances before correcting the request."}`;
      }
    } finally {
      if (alive) busy = false;
    }
  }
  const locationName = (id: string) =>
    locations.find((l) => l.id === id)?.name ?? id;
</script>

<svelte:head><title>Transfer stock · Tera Admin</title></svelte:head>
<svelte:window
  onbeforeunload={(event) => {
    if (busy || dirty) event.preventDefault();
  }}
/>
<div class="page-heading">
  <div>
    <a class="small" href={`/inventory?product=${productId}#stock-detail`}
      >← Inventory</a
    >
    <h1>Transfer stock</h1>
    <p>{product?.name ?? "Selected product"}</p>
  </div>
  <button
    disabled={busy}
    onclick={() => {
      if (
        !dirty ||
        window.confirm("Discard unsaved transfer quantity and note?")
      )
        void load();
    }}>Reload transfer workspace</button
  >
</div>
<p class="notice">
  Immediate stock movement, not shipping or receiving. Reserved stock cannot be
  moved. There is no undo; moving stock back requires a new, separately
  confirmed transfer.
</p>
{#if error}<p class="notice error" role="alert">{error}</p>{/if}
<p class="small muted">
  {live
    ? "Live stock notifications connected."
    : "Live stock notifications unavailable; refresh balances to check current facts."}
  Reservation expiry alone may not send a notification.
</p>
{#if changes > checked}<p class="notice" role="status">
    Inventory may have changed. Refresh balances before confirming a transfer.
    Inputs and saved operations are preserved; balances do not prove a transfer
    succeeded.
  </p>{/if}
<button type="button" disabled={busy || !ready} onclick={() => balances()}
  >Refresh balances</button
>
{#if pending}<section class="card" aria-label="Unresolved transfer">
    <h2>Unresolved transfer</h2>
    <p class="break-word">
      {pending.quantity} units · Variant {pending.variant_id}
    </p>
    <p class="break-word">
      {locationName(pending.from_location_id)} → {locationName(
        pending.to_location_id,
      )}
    </p>
    <p class="small break-word">
      Request {pending.idempotency_key}. Original parameters are retained in
      this tab, including after reload. Do not clear browser storage or use
      another tab to repeat this transfer.
    </p>
    <p class="preserve-text">{pending.note}</p>
    <button disabled={busy} onclick={() => transfer()}
      >Retry saved transfer</button
    >
  </section>{/if}
{#if receipt}<section class="card" aria-label="Confirmed transfer">
    <h2>Transfer confirmed</h2>
    <p class="break-word">Transfer {receipt.id}</p>
    <p class="break-word">
      {locationName(receipt.from_location_id)} → {locationName(
        receipt.to_location_id,
      )} · Variant {receipt.variant_id}
    </p>
    <p>
      {receipt.quantity} units moved. Historical on-hand after transfer: source {receipt.from_on_hand_after},
      destination {receipt.to_on_hand_after}.
    </p>
    <p class="small break-word">
      Out movement {receipt.out_movement_id} · In movement {receipt.in_movement_id}
    </p>
    <p class="small muted">
      These are historical receipt balances, not current availability. View
      transfer_out / transfer_in in inventory history.
    </p>
  </section>{/if}
{#if product}<form
    id="transfer-form"
    class="card form-action"
    onsubmit={transfer}
  >
    <fieldset class="fields" disabled={busy || !ready || !!pending}>
      <label
        >Variant<select
          bind:value={variant}
          onchange={(event) => {
            variant = event.currentTarget.value;
            void balances();
          }}
          >{#each product.variants.filter((v) => v.track_inventory) as item}<option
              value={item.id}
              >{variantLabel(item, product.options)} · {item.sku ||
                item.id}{item.is_active ? "" : " · Inactive"}</option
            >{/each}</select
        ></label
      >
      <div class="fields two">
        <label
          >Source warehouse<select
            bind:value={from}
            onchange={(event) => {
              from = event.currentTarget.value;
              void balances();
            }}
            >{#each locations as item}<option value={item.id}
                >{item.name}</option
              >{/each}</select
          ></label
        ><label
          >Destination warehouse<select
            bind:value={to}
            onchange={(event) => {
              to = event.currentTarget.value;
              void balances();
            }}
            >{#each locations as item}<option value={item.id}
                >{item.name}</option
              >{/each}</select
          ></label
        >
      </div>
      {#if source && destination}<p data-testid="transfer-balances">
          Source: {source.on_hand} on hand / {source.reserved} reserved / {source.available}
          available. Destination: {destination.on_hand} on hand / {destination.available}
          available.
        </p>{/if}
      <p class="small muted">
        Balances may change. The database checks availability again when moving
        stock. Unsaved form selections are not drafts.
      </p>
      {#if !product.variants.some((v) => v.track_inventory)}<p class="notice">
          This product has no inventory-tracked variants.
        </p>{/if}
      {#if locations.length < 2}<p class="notice">
          At least two active warehouses are required for a new transfer.
        </p>{/if}
      <label
        >Quantity<input
          type="number"
          required
          min="1"
          max="2147483647"
          step="1"
          bind:value={quantity}
        /></label
      ><label
        >Transfer note<textarea maxlength="2000" rows="3" bind:value={note}
        ></textarea></label
      >
      <button class="primary" disabled={!source || !destination || from === to}
        >Confirm transfer</button
      >
    </fieldset>
  </form>{/if}
{#if balanceError}<p role="alert" class="notice error">
    Balance refresh failed: {balanceError}. A confirmed transfer remains
    confirmed.
  </p>{/if}
<button class="form-action" disabled={busy || !ready} onclick={balances}
  >Refresh transfer balances</button
>
{#if busy}<p role="status">Loading or transferring…</p>{/if}
