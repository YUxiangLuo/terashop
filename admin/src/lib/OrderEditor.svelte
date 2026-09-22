<script lang="ts">
  import { onMount } from "svelte";
  import { beforeNavigate } from "$app/navigation";
  import FulfillmentEditor from "./FulfillmentEditor.svelte";
  import {
    supabase,
    message,
    money,
    dateTime,
    statusLabel,
    type OrderDetail,
    type FulfillmentBalance,
  } from "./api";
  import {
    commandKey,
    readCommand,
    dispatchCommand,
    isShipmentCommand,
    type ShipmentCommand,
  } from "./commands";
  let { id }: { id: string } = $props();
  let order = $state.raw<OrderDetail | null>(null);
  let balance = $state.raw<FulfillmentBalance | null>(null);
  let busy = $state(true);
  let fulfillmentBusy = $state(false);
  let ready = $state(false);
  let error = $state("");
  let notice = $state("");
  let note = $state("");
  let noteUncertain = $state(false);
  let quantities = $state<Record<string, number | undefined>>({});
  let carrier = $state("");
  let tracking = $state("");
  let pending = $state<ShipmentCommand | null>(null);
  let key = "";
  let alive = true;
  let noteDirty = $derived(!!order && note !== (order.admin_note ?? ""));
  let shipmentDirty = $derived(
    !!carrier ||
      !!tracking ||
      Object.values(quantities).some((value) => !!value),
  );
  onMount(() => {
    void load();
    return () => {
      alive = false;
    };
  });
  beforeNavigate(({ cancel }) => {
    if (
      busy ||
      fulfillmentBusy ||
      ((noteDirty || shipmentDirty) &&
        !window.confirm(
          "Leave and discard unsaved edits? Any dispatched shipment request remains saved in this tab.",
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
        throw new Error("Sign in again to manage orders.");
      key = commandKey(session.data.session.user.id, "shipment", id);
      const saved = readCommand(sessionStorage, key, isShipmentCommand);
      if (saved && saved.order_id !== id)
        throw new Error(
          "The saved shipment does not match this order. Resolve it before creating another shipment.",
        );
      const [detail, available] = await Promise.all([
        supabase.rpc("get_admin_order", { order_id: id }),
        supabase.rpc("get_order_fulfillment_balance", { order_id: id }),
      ]);
      if (!alive) return;
      if (detail.error) throw detail.error;
      if (!detail.data)
        throw new Error("Order not found. Return to the order list.");
      if (available.error) throw available.error;
      order = detail.data as unknown as OrderDetail;
      balance = available.data as unknown as FulfillmentBalance;
      note = order.admin_note ?? "";
      quantities = {};
      carrier = "";
      tracking = "";
      noteUncertain = false;
      pending = saved;
      ready = true;
    } catch (cause) {
      if (alive) error = message(cause);
    } finally {
      if (alive) busy = false;
    }
  }
  function reload() {
    if (
      (!noteDirty && !shipmentDirty) ||
      window.confirm("Discard unsaved edits and load current order facts?")
    ) {
      notice = "";
      void load();
    }
  }
  async function saveNote(clear = false) {
    if (!order || busy || fulfillmentBusy || !ready || noteUncertain) return;
    busy = true;
    error = "";
    notice = "";
    try {
      const result = await supabase.rpc("update_order_admin_note", {
        order_id: id,
        changes: {
          expected_admin_note: order.admin_note,
          admin_note: clear ? null : note,
        },
      });
      if (result.error) throw result.error;
      if (!alive) return;
      const saved = result.data as unknown as { admin_note: string | null };
      order = { ...order, admin_note: saved.admin_note };
      note = saved.admin_note ?? "";
      notice = "Internal note saved. It is not shown to the customer.";
    } catch (cause) {
      if (alive) {
        noteUncertain = true;
        error = `${message(cause)} Reload and check the saved note before saving again.`;
      }
    } finally {
      if (alive) busy = false;
    }
  }
  async function ship(event?: SubmitEvent) {
    event?.preventDefault();
    if (busy || fulfillmentBusy || !ready || !order || noteDirty) return;
    const items =
      balance?.lines
        .filter((line) => !!quantities[line.order_item_id])
        .map((line) => ({
          order_item_id: line.order_item_id,
          quantity: quantities[line.order_item_id]!,
        })) ?? [];
    if (
      !pending &&
      (!balance?.is_fulfillable ||
        !items.length ||
        items.some(
          (item) =>
            !Number.isInteger(item.quantity) ||
            item.quantity < 1 ||
            item.quantity >
              (balance?.lines.find(
                (line) => line.order_item_id === item.order_item_id,
              )?.available_quantity ?? 0),
        ))
    ) {
      error =
        "Choose at least one item and quantities within the available balance.";
      return;
    }
    if (
      !window.confirm(
        pending
          ? "Retry the SAME saved shipment request? It cannot create a second shipment."
          : "Confirm these items have shipped? This records a shipment immediately; it does not purchase a label or send a customer email.",
      )
    )
      return;
    busy = true;
    error = "";
    notice = "";
    try {
      const command: ShipmentCommand = pending ?? {
        order_id: id,
        items,
        carrier,
        tracking_number: tracking,
        idempotency_key: crypto.randomUUID(),
      };
      pending = command;
      await dispatchCommand(
        sessionStorage,
        key,
        command,
        (args) => supabase.rpc("create_fulfillment", args),
        (data) => {
          const row = data as { id: string; order_id: string } | null;
          return !!row && row.order_id === id && typeof row.id === "string";
        },
      );
      if (!alive) return;
      pending = null;
      await load();
      notice = ready
        ? "Shipment confirmed. The order has been reloaded."
        : "Shipment confirmed, but the order could not be reloaded. Reload before making further changes.";
    } catch (cause) {
      if (alive) {
        try {
          pending = readCommand(sessionStorage, key, isShipmentCommand);
        } catch {
          ready = false;
        }
        error = `${message(cause)} ${pending ? "The shipment may already exist. Reload the order and retry only the saved request if needed." : "Shipment was not confirmed. Reload the order to check eligibility before trying again."}`;
      }
    } finally {
      if (alive) busy = false;
    }
  }
  function addressLines(address: OrderDetail["shipping_address"]) {
    return [
      "recipient_name",
      "line1",
      "line2",
      "city",
      "region",
      "postal_code",
      "country",
      "phone",
    ]
      .map((key) => address[key])
      .filter((value): value is string => typeof value === "string" && !!value);
  }
</script>

<svelte:head
  ><title>{order ? `Order #${order.order_number}` : "Order"} · Tera Admin</title
  ></svelte:head
>
<svelte:window
  onbeforeunload={(event) => {
    if (busy || fulfillmentBusy || noteDirty || shipmentDirty)
      event.preventDefault();
  }}
/>
<div class="page-heading">
  <div>
    <a class="small" href="/orders">← Orders</a>
    <h1>{order ? `Order #${order.order_number}` : "Order details"}</h1>
    {#if order}<p class="small muted">
        {dateTime(order.created_at)} · USD
      </p>{/if}
  </div>
  <button onclick={reload} disabled={busy || fulfillmentBusy}
    >Reload order</button
  >
</div>
{#if error}<p class="notice error" role="alert">{error}</p>{/if}
{#if notice}<p class="notice" role="status">{notice}</p>{/if}
{#if order}
  <div class="actions status-strip">
    <span class="badge">{order.status}</span><span
      class={["badge", order.financial_status]}
      >{statusLabel(order.financial_status)}</span
    ><span class={["badge", order.fulfillment_status]}
      >{statusLabel(order.fulfillment_status)}</span
    >
  </div>
  <div class="editor-grid">
    <div class="editor-main">
      <section class="card">
        <h2>Order items</h2>
        <div class="table-wrap">
          <table>
            <thead
              ><tr
                ><th scope="col">Item</th><th scope="col">Unit price</th><th
                  scope="col">Qty</th
                ><th scope="col">After discounts</th></tr
              ></thead
            ><tbody>
              {#each order.pricing.lines as line}<tr
                  ><td
                    ><strong>{line.name}</strong><small class="cell-detail"
                      >{line.variant_title} · {line.sku || "No SKU"}</small
                    ></td
                  ><td>{money(line.unit_price)}</td><td>{line.quantity}</td><td
                    class="numeric">{money(line.line_total)}</td
                  ></tr
                >{/each}
            </tbody>
          </table>
        </div>
        <dl class="totals">
          <div>
            <dt>Subtotal</dt>
            <dd>{money(order.subtotal)}</dd>
          </div>
          <div>
            <dt>Discounts</dt>
            <dd>−{money(order.discount_total)}</dd>
          </div>
          <div>
            <dt>Shipping</dt>
            <dd>{money(order.shipping_total)}</dd>
          </div>
          <div>
            <dt>Tax</dt>
            <dd>{money(order.tax_total)}</dd>
          </div>
          <div class="total">
            <dt>Original order total</dt>
            <dd>{money(order.total)}</dd>
          </div>
        </dl>
        <p class="small muted">
          Historical checkout amounts, not net revenue after refunds.
        </p>
      </section>
      <section class="card">
        <h2>Fulfillment</h2>
        {#each order.fulfillments as shipment}<article class="shipment">
            <div class="section-heading">
              <strong>{shipment.carrier || "Shipment"}</strong><span
                class={["badge", shipment.status]}>{shipment.status}</span
              >
            </div>
            <p class="small">
              {shipment.tracking_number || "No tracking number"} · {dateTime(
                shipment.created_at,
              )}
            </p>
            <ul class="small">
              {#each shipment.lines as line}<li>
                  {order.pricing.lines.find(
                    (item) => item.id === line.order_item_id,
                  )?.name ?? line.order_item_id} × {line.quantity}
                </li>{/each}
            </ul>
            <FulfillmentEditor
              fulfillmentId={shipment.id}
              orderId={id}
              disabled={busy ||
                fulfillmentBusy ||
                noteDirty ||
                shipmentDirty ||
                !!pending}
              onSaved={load}
              onBusyChange={(value) => (fulfillmentBusy = value)}
            />
          </article>{:else}<p class="small muted">
            No shipments recorded yet.
          </p>{/each}
        {#if pending}<div class="notice" role="status">
            <strong>A shipment request is unresolved</strong>
            <p class="small break-word">
              Request {pending.idempotency_key}. The original items and tracking
              details are retained across reloads. Review existing shipments
              before retrying.
            </p>
            <button
              onclick={() => ship()}
              disabled={busy || !ready || noteDirty}
              >Retry saved shipment</button
            >
          </div>
        {:else if balance?.is_fulfillable}
          <form onsubmit={ship}>
            <fieldset disabled={busy || fulfillmentBusy || !ready || noteDirty}>
              <h3 class="small">Record a shipment</h3>
              <p class="small muted">
                Enter only the quantities shipped now. Payment and quantity
                eligibility are checked again by the database.
              </p>
              {#each balance.lines.filter((line) => line.available_quantity > 0) as line}<label
                  class="shipment-line"
                  >{order.pricing.lines.find(
                    (item) => item.id === line.order_item_id,
                  )?.name ?? line.order_item_id}<span class="small muted"
                    >{line.available_quantity} available</span
                  ><input
                    aria-label={`Ship ${order.pricing.lines.find((item) => item.id === line.order_item_id)?.sku ?? line.order_item_id}`}
                    type="number"
                    min="0"
                    max={line.available_quantity}
                    step="1"
                    placeholder="0"
                    bind:value={quantities[line.order_item_id]}
                  /></label
                >{/each}
              <div class="fields two">
                <label
                  >Carrier<input
                    bind:value={carrier}
                    maxlength="200"
                    placeholder="e.g. DHL"
                  /></label
                ><label
                  >Tracking number<input
                    bind:value={tracking}
                    maxlength="200"
                  /></label
                >
              </div>
              <button class="primary form-action">Confirm shipment</button>
            </fieldset>
          </form>
        {:else}<p class="notice">
            {balance?.payment_hold
              ? "Payment reconciliation hold. Shipping is blocked."
              : "There are no items eligible to ship. Pending payment, cancelled and fully fulfilled orders cannot create a shipment here."}
          </p>{/if}
        {#if noteDirty}<p class="small muted">
            Save or discard the internal note before recording a shipment.
          </p>{/if}
      </section>
      <section class="card">
        <h2>Internal note</h2>
        <form
          onsubmit={(event) => {
            event.preventDefault();
            void saveNote();
          }}
        >
          <label
            >Only visible to administrators<textarea
              rows="4"
              maxlength="10000"
              bind:value={note}
              disabled={busy || fulfillmentBusy || !ready || noteUncertain}
            ></textarea></label
          >
          <div class="actions form-action">
            <button
              disabled={busy ||
                fulfillmentBusy ||
                !ready ||
                noteUncertain ||
                !noteDirty}>Save note</button
            ><button
              type="button"
              onclick={() => saveNote(true)}
              disabled={busy ||
                fulfillmentBusy ||
                !ready ||
                noteUncertain ||
                order.admin_note === null}>Clear saved note</button
            >
          </div>
        </form>
      </section>
    </div>
    <aside class="editor-main">
      <section class="card">
        <h2>Customer</h2>
        <p class="break-word">{order.email}</p>
        <h2>Ship to</h2>
        <address>
          {#each addressLines(order.shipping_address) as line}<div>
              {line}
            </div>{/each}
        </address>
        <p class="small muted">
          {order.shipping_method_name ?? "No shipping method"}
        </p>
      </section>
      <section class="card">
        <h2>Customer note</h2>
        <p class="preserve-text">
          {order.customer_note || "No note provided."}
        </p>
      </section>
      <p class="small muted">
        Order prices and addresses are historical snapshots. This workspace does
        not capture payments, issue refunds or purchase shipping labels.
      </p>
    </aside>
  </div>
{:else if busy}<p role="status">Loading order…</p>{:else if !error}<p
    class="empty"
  >
    Order not found.
  </p>{/if}
