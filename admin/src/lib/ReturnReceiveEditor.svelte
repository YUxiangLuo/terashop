<script lang="ts">
  import { onMount } from "svelte";
  import { beforeNavigate } from "$app/navigation";
  import {
    supabase,
    message,
    dateTime,
    type OrderDetail,
    type Location,
  } from "./api";
  import { commandKey, readCommand, dispatchCommand } from "./commands";
  import {
    isReceiveCommand,
    receiveItems,
    acknowledgesReceipt,
    type ReceiveCommand,
    type ReturnAuthorization,
    type OrderReturns,
  } from "./returns";
  let { orderId, returnId }: { orderId: string; returnId: string } = $props();
  let order = $state.raw<OrderDetail | null>(null),
    authorization = $state.raw<ReturnAuthorization | null>(null);
  let locations = $state<Location[]>([]),
    pending = $state<ReceiveCommand | null>(null);
  let busy = $state(true),
    ready = $state(false),
    error = $state(""),
    notice = $state("");
  let locationId = $state(""),
    note = $state("");
  let quantities = $state<Record<string, number | undefined>>({});
  let key = "",
    alive = true;
  let dirty = $derived(
    !!locationId || !!note || Object.values(quantities).some((v) => !!v),
  );
  let canReceive = $derived(
    authorization?.status === "open" &&
      authorization.lines.some((l) => l.receivable_quantity > 0),
  );
  const label = (lineId: string) => {
    const line = authorization?.lines.find((l) => l.id === lineId);
    const item = order?.pricing.lines.find((i) => i.id === line?.order_item_id);
    return item ? `${item.name} · ${item.sku ?? item.variant_title}` : lineId;
  };
  onMount(() => {
    void load();
    return () => {
      alive = false;
    };
  });
  beforeNavigate(({ cancel }) => {
    if (
      busy ||
      (dirty &&
        !window.confirm(
          "Discard unsaved receipt edits? Dispatched requests remain saved in this tab.",
        ))
    )
      cancel();
  });
  async function load() {
    busy = true;
    ready = false;
    error = "";
    try {
      const session = await supabase.auth.getSession();
      if (session.error || !session.data.session)
        throw Error("Sign in again to receive returns.");
      key = commandKey(
        session.data.session.user.id,
        "return-receipt",
        returnId,
      );
      const saved = readCommand(sessionStorage, key, isReceiveCommand);
      if (saved && saved.return_id !== returnId)
        throw Error("Saved receipt does not match this return.");
      const [detail, result] = await Promise.all([
        supabase.rpc("get_admin_order", { order_id: orderId }),
        supabase.rpc("get_order_returns", { order_id: orderId }),
      ]);
      if (!alive) return;
      if (detail.error) throw detail.error;
      if (result.error) throw result.error;
      const nextOrder = detail.data as unknown as OrderDetail | null;
      const summary = result.data as unknown as OrderReturns | null;
      const next = summary?.returns.find((r) => r.id === returnId);
      if (
        nextOrder?.id !== orderId ||
        summary?.order_id !== orderId ||
        !next ||
        next.order_id !== orderId
      )
        throw Error("Return not found in this order.");
      const items: Location[] = [];
      // A pending receipt must remain replayable even if its location was disabled.
      if (!saved) {
        let cursor: string | null = null;
        do {
          const result = await supabase.rpc("list_admin_locations", {
            active: true,
            page_size: 100,
            ...(cursor ? { after_id: cursor } : {}),
          });
          if (result.error) throw result.error;
          if (!alive) return;
          const page = result.data as unknown as {
            items: Location[];
            next_cursor: string | null;
          };
          items.push(...page.items);
          cursor = page.next_cursor;
        } while (cursor);
      }
      order = nextOrder;
      authorization = next;
      pending = saved;
      locations = items;
      quantities = {};
      locationId = "";
      note = "";
      ready = true;
    } catch (cause) {
      if (alive) error = message(cause);
    } finally {
      if (alive) busy = false;
    }
  }
  function reload() {
    if (!dirty || window.confirm("Discard unsaved receipt edits and reload?")) {
      notice = "";
      void load();
    }
  }
  async function submit() {
    if (busy || !ready || !authorization) return;
    error = "";
    notice = "";
    let command: ReceiveCommand;
    try {
      if (!pending && !locations.some((l) => l.id === locationId))
        throw Error("Select the actual active receiving location.");
      command = pending ?? {
        return_id: returnId,
        location_id: locationId,
        items: receiveItems(authorization, quantities),
        note,
        idempotency_key: crypto.randomUUID(),
      };
      if (!isReceiveCommand(command))
        throw Error(
          "Check receipt quantities and note (maximum 2000 characters).",
        );
    } catch (cause) {
      error = message(cause);
      return;
    }
    if (
      !window.confirm(
        pending
          ? "Replay the exact saved receipt request?"
          : "Record these items as physically received? This does not restock or refund them.",
      )
    )
      return;
    busy = true;
    try {
      await dispatchCommand(
        sessionStorage,
        key,
        command,
        (c) => supabase.rpc("receive_return", c),
        (result) => acknowledgesReceipt(result, command, orderId),
      );
      if (!alive) return;
      pending = null;
      quantities = {};
      locationId = "";
      note = "";
      notice = "Receipt recorded. No sellable stock added or payment refunded.";
      await load();
    } catch (cause) {
      if (!alive) return;
      error = message(cause);
      try {
        pending = readCommand(sessionStorage, key, isReceiveCommand);
      } catch (cause) {
        ready = false;
        error = message(cause);
      }
      if (!pending) ready = false;
    } finally {
      if (alive) busy = false;
    }
  }
</script>

<div class="page-heading">
  <div>
    <a class="small" href={`/orders/${orderId}/returns`}>← Return history</a>
    <h1>Receive return</h1>
    <p class="small muted">{returnId}</p>
  </div>
  <button onclick={reload} disabled={busy}>Reload receipt facts</button>
</div>
{#if error}<p class="notice error" role="alert">{error}</p>{/if}
{#if notice}<p class="notice" role="status">{notice}</p>{/if}
{#if pending}<section class="card">
    <h2>Unconfirmed receipt request</h2>
    <p>
      Replay only this saved request. It remains recoverable after quantities,
      return status or location availability change. Saved only in this tab.
    </p>
    <p class="small">
      Location {pending.location_id} · Request {pending.idempotency_key}
    </p>
    <ul>
      {#each pending.items as item}<li>
          {label(item.return_line_id)} × {item.quantity}
        </li>{/each}
    </ul>
    <p>Note: {pending.note || "—"}</p>
    <button class="primary" disabled={busy || !ready} onclick={submit}
      >Replay saved receipt</button
    >
  </section>{/if}
<section class="card">
  <h2>Record physical receipt</h2>
  <p>
    Choose the actual receiving location. Received items await inspection; this
    operation does not increase sellable stock or refund payment.
  </p>
  {#if authorization}<p>
      Status: <span class="badge">{authorization.status}</span>
    </p>{/if}
  {#if ready && !canReceive && !pending}<p class="notice">
      No quantities can be received on this return.
    </p>{/if}
  <form
    onsubmit={(e) => {
      e.preventDefault();
      void submit();
    }}
  >
    <fieldset disabled={busy || !ready || !!pending || !canReceive}>
      <label for="receipt-location">Actual receiving location</label><select
        id="receipt-location"
        bind:value={locationId}
        required
        ><option value="">Select a location</option
        >{#each locations as location}<option value={location.id}
            >{location.name} · {location.code}</option
          >{/each}</select
      >
      {#if ready && !locations.length && !pending}<p class="notice">
          No active receiving locations. Activate a location before receiving.
        </p>{/if}
      <p class="small muted">
        On narrow screens, scroll the table horizontally to see all quantities.
      </p>
      <div class="table-wrap">
        <table>
          <thead
            ><tr
              ><th>Item</th><th>Authorized</th><th>Received</th><th
                >Receivable</th
              ><th>Receive now</th></tr
            ></thead
          ><tbody
            >{#each authorization?.lines ?? [] as line}<tr
                ><td>{label(line.id)}</td><td>{line.quantity}</td><td
                  >{line.received_quantity}</td
                ><td>{line.receivable_quantity}</td><td
                  ><input
                    aria-label={`Receive quantity for ${label(line.id)}`}
                    type="number"
                    min="0"
                    max={line.receivable_quantity}
                    step="1"
                    bind:value={quantities[line.id]}
                    disabled={!line.receivable_quantity}
                  /></td
                ></tr
              >{/each}</tbody
          >
        </table>
      </div>
      <label for="receipt-note">Receipt note (visible to the customer)</label
      ><textarea id="receipt-note" maxlength="2000" rows="3" bind:value={note}
      ></textarea><button class="primary" disabled={!locations.length}
        >Record receipt</button
      >
    </fieldset>
  </form>
</section>
<section class="card">
  <h2>Receipt history</h2>
  {#if !ready || pending}<p class="muted">
      Last loaded facts only; unresolved requests may not appear yet.
    </p>{/if}
  {#if authorization && !authorization.receipts.length}<p class="muted">
      No receipts recorded.
    </p>{/if}
  {#each authorization?.receipts ?? [] as receipt}<article>
      <h3>Receipt {receipt.id}</h3>
      <p class="small">
        {dateTime(receipt.received_at)} · Location {receipt.location_id}
      </p>
      <p>{receipt.note || "No note"}</p>
      <ul>
        {#each receipt.lines as line}<li>
            {label(line.return_line_id)} — Received {line.quantity} · Undisposed {line.undisposed_quantity}
          </li>{/each}
      </ul>
    </article>{/each}
</section>

<style>
  .card {
    margin-bottom: 1.25rem;
    overflow-wrap: anywhere;
  }
  .page-heading {
    overflow-wrap: anywhere;
  }
  fieldset {
    border: 0;
    padding: 0;
    min-width: 0;
    display: grid;
    gap: 0.8rem;
  }
  table {
    min-width: 700px;
    overflow-wrap: normal;
  }
  input[type="number"] {
    width: 7rem;
  }
  article {
    border-top: 1px solid #dfe4dc;
    padding: 1rem 0;
  }
  h3 {
    font-size: 1rem;
  }
</style>
