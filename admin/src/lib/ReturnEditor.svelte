<script lang="ts">
  import { onMount } from "svelte";
  import { beforeNavigate } from "$app/navigation";
  import { supabase, message, dateTime, type OrderDetail } from "./api";
  import { commandKey, readCommand, dispatchCommand } from "./commands";
  import {
    isReturnCommand,
    acknowledgesReturn,
    returnItems,
    type ReturnCommand,
    type OrderReturns,
  } from "./returns";
  let { id }: { id: string } = $props();
  let order = $state.raw<OrderDetail | null>(null);
  let facts = $state.raw<OrderReturns | null>(null);
  let pending = $state<ReturnCommand | null>(null);
  let busy = $state(true),
    ready = $state(false),
    error = $state(""),
    notice = $state("");
  let fulfillmentId = $state(""),
    reason = $state("");
  let quantities = $state<Record<string, number | undefined>>({});
  let key = "",
    alive = true;
  let dirty = $derived(!!reason || Object.values(quantities).some((v) => !!v));
  let lines = $derived(
    facts?.lines.filter((line) => line.fulfillment_id === fulfillmentId) ?? [],
  );
  const label = (itemId: string) => {
    const item = order?.pricing.lines.find((item) => item.id === itemId);
    return item ? `${item.name} · ${item.sku ?? item.variant_title}` : itemId;
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
          "Discard unsaved edits? Dispatched return requests remain saved in this tab.",
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
        throw Error("Sign in again to manage returns.");
      key = commandKey(session.data.session.user.id, "return", id);
      const saved = readCommand(sessionStorage, key, isReturnCommand);
      const [detail, summary] = await Promise.all([
        supabase.rpc("get_admin_order", { order_id: id }),
        supabase.rpc("get_order_returns", { order_id: id }),
      ]);
      if (!alive) return;
      if (detail.error) throw detail.error;
      if (summary.error) throw summary.error;
      if (!detail.data || !summary.data) throw Error("Order not found.");
      const next = detail.data as unknown as OrderDetail;
      const returns = summary.data as unknown as OrderReturns;
      if (next.id !== id || returns.order_id !== id)
        throw Error("Order response did not match this page.");
      if (
        saved &&
        !next.fulfillments.some((f) => f.id === saved.fulfillment_id)
      )
        throw Error(
          "Saved return does not belong to this order. Resolve it before continuing.",
        );
      order = next;
      facts = returns;
      pending = saved;
      fulfillmentId =
        saved?.fulfillment_id ??
        next.fulfillments.find((f) =>
          returns.lines.some(
            (l) => l.fulfillment_id === f.id && l.available_quantity > 0,
          ),
        )?.id ??
        "";
      quantities = {};
      reason = "";
      ready = true;
    } catch (cause) {
      if (alive) error = message(cause);
    } finally {
      if (alive) busy = false;
    }
  }
  function reload() {
    if (
      !dirty ||
      window.confirm("Discard unsaved edits and reload return facts?")
    ) {
      notice = "";
      void load();
    }
  }
  async function submit() {
    if (busy || !ready || !facts) return;
    error = "";
    notice = "";
    let command: ReturnCommand;
    try {
      command = pending ?? {
        fulfillment_id: fulfillmentId,
        items: returnItems(facts.lines, fulfillmentId, quantities),
        reason,
        idempotency_key: crypto.randomUUID(),
      };
      if (!isReturnCommand(command))
        throw Error(
          "Check return quantities and reason (maximum 500 characters).",
        );
    } catch (cause) {
      error = message(cause);
      return;
    }
    if (
      !window.confirm(
        pending
          ? "Replay the exact saved return request?"
          : "Authorize this return? This does not refund payment or add sellable stock.",
      )
    )
      return;
    busy = true;
    try {
      await dispatchCommand(
        sessionStorage,
        key,
        command,
        (c) => supabase.rpc("create_return", c),
        (result) => acknowledgesReturn(result, command, id),
      );
      if (!alive) return;
      pending = null;
      quantities = {};
      reason = "";
      notice = "Return authorized. No payment refunded or stock added.";
      await load();
    } catch (cause) {
      if (!alive) return;
      error = message(cause);
      try {
        pending = readCommand(sessionStorage, key, isReturnCommand);
      } catch (cause) {
        ready = false;
        error = message(cause);
      }
      // Explicit rejection needs fresh availability; an unknown request must remain replayable.
      if (!pending) ready = false;
    } finally {
      if (alive) busy = false;
    }
  }
</script>

<div class="page-heading">
  <div>
    <a class="small" href={`/orders/${id}`}>← Order details</a>
    <h1>Returns{order ? ` · #${order.order_number}` : ""}</h1>
    <p class="muted">
      Authorize shipped items and track physical returns independently from
      refunds.
    </p>
  </div>
  <button onclick={reload} disabled={busy}>Reload returns</button>
</div>
{#if error}<p class="notice error" role="alert">{error}</p>{/if}
{#if notice}<p class="notice" role="status">{notice}</p>{/if}
{#if pending}
  <section class="card panel">
    <h2>Unconfirmed return request</h2>
    <p>
      Do not create another return. Replay the exact saved request, even if
      available quantities have changed. This record is saved only in this
      browser tab.
    </p>
    <p class="small">
      Shipment {pending.fulfillment_id} · Request {pending.idempotency_key}
    </p>
    <ul>
      {#each pending.items as item}<li>
          {label(item.order_item_id)} × {item.quantity}
        </li>{/each}
    </ul>
    <p>Reason: {pending.reason || "—"}</p>
    <button class="primary" disabled={busy || !ready} onclick={submit}
      >Replay saved return</button
    >
  </section>
{/if}
<section class="card panel">
  <h2>Authorize a return</h2>
  <p class="muted">
    Each authorization covers one shipment. Creation does not record receipt,
    restock inventory, or refund payment.
  </p>
  <form
    onsubmit={(event) => {
      event.preventDefault();
      void submit();
    }}
  >
    <fieldset disabled={busy || !ready || !!pending}>
      <label for="return-shipment">Shipment</label>
      <select
        id="return-shipment"
        bind:value={fulfillmentId}
        onchange={() => {
          quantities = {};
        }}
      >
        <option value="">Select a shipment</option>
        {#each order?.fulfillments.filter((f) => f.status === "shipped" || f.status === "delivered") ?? [] as shipment}<option
            value={shipment.id}
            >{dateTime(shipment.created_at)} · {shipment.tracking_number ||
              shipment.id} · {shipment.status}</option
          >{/each}
      </select>
      {#if lines.length}
        <p class="small muted scroll-hint">
          Scroll the table horizontally to see all quantities.
        </p>
        <div class="table-wrap">
          <table>
            <thead
              ><tr
                ><th>Item</th><th>Shipped</th><th>Awaiting receipt</th><th
                  >Received</th
                ><th>Available</th><th>Return quantity</th></tr
              ></thead
            ><tbody>
              {#each lines as line}<tr
                  ><td>{label(line.order_item_id)}</td><td
                    >{line.shipped_quantity}</td
                  ><td>{line.authorized_unreceived_quantity}</td><td
                    >{line.received_quantity}</td
                  ><td>{line.available_quantity}</td><td
                    ><input
                      aria-label={`Return quantity for ${label(line.order_item_id)}`}
                      type="number"
                      min="0"
                      max={line.available_quantity}
                      step="1"
                      bind:value={quantities[line.order_item_id]}
                      disabled={!line.available_quantity}
                    /></td
                  ></tr
                >{/each}
            </tbody>
          </table>
        </div>
      {:else}<p class="muted">
          No returnable lines selected. Only shipped or delivered items can be
          authorized.
        </p>{/if}
      <label for="return-reason">Reason (visible to the customer)</label
      ><textarea id="return-reason" maxlength="500" rows="3" bind:value={reason}
      ></textarea>
      <button
        class="primary"
        disabled={!lines.some((l) => l.available_quantity > 0)}
        >Authorize return</button
      >
    </fieldset>
  </form>
</section>
<section class="card panel">
  <h2>Return history</h2>
  {#if pending || !ready}<p class="muted">
      Last loaded facts only; unresolved requests may not appear here yet.
    </p>{/if}
  {#if facts && !facts.returns.length}<p class="muted">
      No return authorizations yet.
    </p>{/if}
  {#each facts?.returns ?? [] as authorization}
    <article class="return-record">
      <div class="actions">
        <h3>Return {authorization.id}</h3>
        <span class="badge">{authorization.status}</span>
        <a href={`/orders/${id}/returns/${authorization.id}/receive`}
          >Receive items / recover request</a
        >
      </div>
      <p class="small muted">
        {dateTime(authorization.created_at)} · Shipment {authorization.fulfillment_id}{authorization.closed_at
          ? ` · Closed ${dateTime(authorization.closed_at)}`
          : ""}
      </p>
      <p>Reason: {authorization.reason || "—"}</p>
      <ul>
        {#each authorization.lines as line}<li>
            {label(line.order_item_id)} — Authorized {line.quantity} · Received {line.received_quantity}
            · Receivable {line.receivable_quantity}
          </li>{/each}
      </ul>
      {#if !authorization.receipts.length}<p class="muted">
          No receipts recorded.
        </p>{/if}
      {#each authorization.receipts as receipt}
        <details>
          <summary
            >Receipt · {dateTime(receipt.received_at)} · {receipt.id}</summary
          >
          <p class="small">
            Location {receipt.location_id} · {receipt.note || "No receipt note"}
          </p>
          {#each receipt.lines as line}
            <p>
              {label(
                authorization.lines.find((l) => l.id === line.return_line_id)
                  ?.order_item_id ?? line.return_line_id,
              )} — Received {line.quantity} · Undisposed {line.undisposed_quantity}
            </p>
            <ul>
              {#each line.dispositions as disposition}<li>
                  {disposition.disposition} × {disposition.quantity} · {dateTime(
                    disposition.created_at,
                  )} · {disposition.note ||
                    "No note"}{disposition.inventory_movement_id
                    ? ` · Inventory movement ${disposition.inventory_movement_id}`
                    : ""}
                </li>{/each}
            </ul>
          {/each}
        </details>
      {/each}
    </article>
  {/each}
</section>

<style>
  .panel {
    margin-bottom: 1.25rem;
    overflow-wrap: anywhere;
  }
  .scroll-hint {
    display: none;
  }
  @media (max-width: 700px) {
    .scroll-hint {
      display: block;
    }
  }
  fieldset {
    border: 0;
    padding: 0;
    min-width: 0;
    display: grid;
    gap: 0.8rem;
  }
  input[type="number"] {
    width: 7rem;
  }
  table {
    min-width: 760px;
    overflow-wrap: normal;
  }
  .return-record {
    padding: 1rem 0;
    border-top: 1px solid var(--border, #ddd);
    overflow-wrap: anywhere;
  }
  h3 {
    font-size: 1rem;
  }
  details {
    padding: 0.6rem 0;
  }
</style>
