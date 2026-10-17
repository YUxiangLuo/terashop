<script lang="ts">
  import { onMount } from "svelte";
  import { beforeNavigate } from "$app/navigation";
  import { supabase, message, money } from "./api";
  import { dispatchCommand } from "./commands";
  import OrderActivity from "./OrderActivity.svelte";
  import {
    orderLedger,
    orderPricing,
    adminOrderResult,
    orderResult,
    paypalRefundResult,
    checkoutQuote,
  } from "../../../mcp/src/schemas";
  import {
    actionStorageKey,
    paypalAmount,
    readOrderAction,
    saveOrderAction,
    type OrderActionsLedger,
    type OrderActionsPricing,
    type SavedOrderAction,
  } from "./order-actions";

  let { id }: { id: string } = $props();
  let ledger = $state.raw<OrderActionsLedger | null>(null),
    pricing = $state.raw<OrderActionsPricing | null>(null);
  let quoteId = $state<string | null>(null),
    pending = $state<SavedOrderAction | null>(null);
  let activityVersion = $state(0);
  let busy = $state(true),
    ready = $state(false),
    error = $state(""),
    notice = $state("");
  let cancelReason = $state(""),
    manualProvider = $state("manual"),
    manualReference = $state("");
  let refundMode = $state<"amount" | "items" | "shipping">("amount"),
    refundAmount = $state("");
  let refundShipping = $state(""),
    refundReason = $state(""),
    refundRestock = $state(false);
  let refundItems = $state<Record<string, string>>({}),
    refundReturned = $state<Record<string, string>>({});
  let confirmed = $state<Record<string, boolean>>({}),
    key = "",
    alive = true;
  let dirty = $derived(
    !!cancelReason ||
      !!manualReference ||
      !!refundAmount ||
      !!refundShipping ||
      !!refundReason ||
      Object.values(confirmed).some(Boolean) ||
      Object.values(refundItems).some(Boolean) ||
      Object.values(refundReturned).some(Boolean),
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
      (dirty &&
        !window.confirm(
          "Leave and discard unsaved action fields? A dispatched action remains retained in this tab.",
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
        throw Error("Sign in again to manage order actions.");
      key = actionStorageKey(session.data.session.user.id, id);
      pending = readOrderAction(sessionStorage, key);
      if (pending && pending.arguments.order_id !== id)
        throw Error("The retained action belongs to another order.");
      const [l, p, q] = await Promise.all([
        supabase.rpc("get_order_ledger", { order_id: id }),
        supabase.rpc("get_order_pricing", { order_id: id }),
        supabase.rpc("get_order_checkout_quote", { order_id: id }),
      ]);
      if (!alive) return;
      if (l.error) throw l.error;
      if (p.error) throw p.error;
      ledger = orderLedger.parse(l.data);
      pricing = orderPricing.parse(p.data);
      if (
        !ledger ||
        ledger.order.id !== id ||
        !pricing ||
        pricing.order_id !== id
      )
        throw Error("Order action facts could not be verified.");
      if (q.error) throw q.error;
      const quote = q.data === null ? null : checkoutQuote.parse(q.data);
      quoteId = quote?.id ?? null;
      activityVersion++;
      ready = true;
    } catch (cause) {
      if (alive) error = message(cause);
    } finally {
      if (alive) busy = false;
    }
  }

  function prepare(
    kind: SavedOrderAction["kind"],
    args: Record<string, unknown>,
  ) {
    const action = { kind, arguments: args } satisfies SavedOrderAction;
    return action;
  }
  async function rpcWrite(
    action: SavedOrderAction,
    rpc: "cancel_order" | "mark_order_paid",
  ) {
    await dispatchCommand(
      sessionStorage,
      key,
      action,
      () => supabase.rpc(rpc, action.arguments as never),
      (data) => {
        const receipt =
          rpc === "mark_order_paid"
            ? adminOrderResult.parse(data)
            : orderResult.parse(data);
        if (receipt.id !== id)
          throw Error("The server receipt could not be bound to this order.");
        return true;
      },
    );
    pending = null;
  }
  async function submit(kind: SavedOrderAction["kind"]) {
    if (
      busy ||
      !ready ||
      !ledger ||
      !pricing ||
      pending ||
      !confirmed[kind]
    )
      return;
    let action: SavedOrderAction;
    try {
      if (kind === "cancel-order") {
        if (!cancelReason.trim() || Array.from(cancelReason).length > 500)
          throw Error("Enter a cancellation reason of at most 500 characters.");
        action = prepare(kind, { order_id: id, reason: cancelReason });
      } else if (kind === "mark-paid") {
        if (
          !manualProvider.trim() ||
          manualProvider.length > 200 ||
          manualReference.length > 500
        )
          throw Error("Check the provider and reference lengths.");
        action = prepare(kind, {
          order_id: id,
          idempotency_key: crypto.randomUUID(),
          provider: manualProvider.trim(),
          ...(manualReference.trim()
            ? { provider_ref: manualReference.trim() }
            : {}),
        });
      } else {
        const args: Record<string, unknown> = {
          order_id: id,
          idempotency_key: crypto.randomUUID(),
          reason: refundReason.trim(),
          restock: refundRestock,
        };
        if (refundReason.length > 1000)
          throw Error("Refund reason must be at most 1000 characters.");
        if (refundMode === "amount") {
          args.amount = paypalAmount(refundAmount);
          args.restock = false;
        } else if (refundMode === "shipping") {
          args.shipping_amount = paypalAmount(refundShipping);
          args.restock = false;
        } else {
          const items = Object.entries(refundItems)
            .filter(([, q]) => Number(q) > 0)
            .map(([order_item_id, q]) => ({
              order_item_id,
              quantity: Number(q),
              restock_shipped_quantity: Number(refundReturned[order_item_id] ?? 0),
            }));
          if (
            !items.length ||
            items.some((x) => !Number.isInteger(x.quantity) || x.quantity < 1)
          )
            throw Error("Select positive whole item quantities.");
          if (
            items.some(
              (x) =>
                !Number.isInteger(x.restock_shipped_quantity) ||
                x.restock_shipped_quantity < 0 ||
                x.restock_shipped_quantity > x.quantity,
            ) ||
            Object.entries(refundReturned).some(
              ([order_item_id, q]) =>
                Number(q) > 0 && !(Number(refundItems[order_item_id]) > 0),
            )
          )
            throw Error(
              "Returned units to restock must be whole numbers within each line's refunded quantity.",
            );
          args.items = items;
          if (refundShipping.trim())
            args.shipping_amount = paypalAmount(refundShipping);
        }
        action = prepare(kind, args);
      }
    } catch (cause) {
      error = message(cause);
      return;
    }
    if (
      !window.confirm(
        (kind === "paypal-refund"
          ? "Issue this exact REAL PayPal refund? Provider acknowledgement may still require ledger reconciliation."
          : "Submit this exact administrative action? Eligibility is checked again by the server.") +
          "\n" +
          JSON.stringify(action.arguments, null, 2),
      )
    ) {
      sessionStorage.removeItem(key);
      pending = null;
      return;
    }
    busy = true;
    error = "";
    notice = "";
    try {
      if (kind === "paypal-refund") {
        saveOrderAction(sessionStorage, key, action);
        pending = action;
        const result = await supabase.functions.invoke("paypal-create-refund", {
          body: action.arguments,
        });
        if (result.error) throw result.error;
        const data = paypalRefundResult.parse(result.data);
        if (
          !data ||
          data.order_id !== id ||
          data.provider !== "paypal" ||
          typeof data.refund_request_id !== "string" ||
          !["PENDING", "COMPLETED", "FAILED", "CANCELLED"].includes(
            String(data.provider_status),
          ) ||
          typeof data.pending_reconciliation !== "boolean"
        )
          throw Error("Provider response could not be verified.");
        sessionStorage.removeItem(key);
        pending = null;
        notice = data.pending_reconciliation
          ? "PayPal acknowledged the request; local settlement is still pending reconciliation. The ledger below was re-read."
          : "PayPal acknowledged the refund. The ledger was re-read; only its settled entries prove local settlement.";
      } else
        await rpcWrite(
          action,
          kind === "cancel-order" ? "cancel_order" : "mark_order_paid",
        );
      confirmed = {};
      await load();
      if (!notice)
        notice = "Action confirmed and current order facts were loaded.";
    } catch (cause) {
      error = `${message(cause)} The outcome is unknown. The exact original arguments are retained; reload and reconcile the ledger/payment operations before choosing an identical retry.`;
      try {
        pending = readOrderAction(sessionStorage, key);
        if (!pending)
          error = `${message(cause)} The first request was rejected before committing. Review current facts and correct the inputs.`;
      } catch {
        ready = false;
      }
      await reconcile();
    } finally {
      if (alive) busy = false;
    }
  }
  async function reconcile() {
    const [l, ops] = await Promise.all([
      supabase.rpc("get_order_ledger", { order_id: id }),
      supabase.rpc("list_admin_payment_operations", {
        order_id: id,
        kind:
          pending?.kind === "paypal-refund"
            ? "refund_request"
            : "money_movement",
        page_size: 100,
      }),
    ]);
    ready = false;
    if (!l.error && l.data) {
      try {
        const next = orderLedger.parse(l.data);
        if (next.order.id !== id) throw Error("Order identity mismatch.");
        ledger = next;
        ready = !ops.error;
      } catch {
        error += " Ledger response could not be verified.";
      }
    }
    activityVersion++;
    if (ops.error) error += " Payment operations could not be re-read.";
  }
  async function retry() {
    if (
      busy ||
      !ready ||
      !pending ||
      !window.confirm(
        "Retry the exact retained arguments and idempotency key? Do this only after reconciliation shows it is appropriate.",
      )
    )
      return;
    const action = pending;
    busy = true;
    error = "";
    try {
      if (action.kind === "paypal-refund") {
        const result = await supabase.functions.invoke("paypal-create-refund", {
          body: action.arguments,
        });
        if (result.error) throw result.error;
        const data = paypalRefundResult.parse(result.data);
        if (
          !data ||
          data.order_id !== id ||
          data.provider !== "paypal" ||
          typeof data.refund_request_id !== "string" ||
          !["PENDING", "COMPLETED", "FAILED", "CANCELLED"].includes(
            String(data.provider_status),
          ) ||
          typeof data.pending_reconciliation !== "boolean"
        )
          throw Error("Response could not be verified.");
        sessionStorage.removeItem(key);
        pending = null;
        notice =
          "Provider acknowledged the retained request. Re-read ledger facts before treating it as settled.";
      } else
        await rpcWrite(
          action,
          action.kind === "cancel-order" ? "cancel_order" : "mark_order_paid",
        );
      await load();
    } catch (cause) {
      error = `${message(cause)} Outcome remains unknown; the original request is still retained.`;
      await reconcile();
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>Order actions · Tera Admin</title></svelte:head>
<svelte:window
  onbeforeunload={(e) => {
    if (busy || dirty) e.preventDefault();
  }}
/>
<div class="page-heading">
  <div>
    <a href={`/orders/${id}`}>← Order</a>
    <h1>Order and payment actions</h1>
  </div>
  <button onclick={load} disabled={busy}>Reload and reconcile</button>
</div>
{#if error}<p class="notice error" role="alert">{error}</p>{/if}{#if notice}<p
    class="notice"
    role="status"
  >
    {notice}
  </p>{/if}
{#if pending}<section class="card">
    <h2>Unresolved {pending.kind}</h2>
    <p>
      The exact original arguments are retained in this tab. Reconcile current
      facts before retrying; no new key or refreshed arguments will be
      generated.
    </p>
    <details>
      <summary>Retained exact request</summary>
      <pre class="preserve-text">{JSON.stringify(
          pending.arguments,
          null,
          2,
        )}</pre>
    </details>
    <button onclick={retry} disabled={busy || !ready}
      >Retry retained request</button
    >
  </section>{/if}
{#if ledger && pricing}
  <section class="card">
    <h2>Current facts</h2>
    <p>
      {ledger.order.status} · {ledger.order.financial_status} · captured {money(
        ledger.balances.captured,
      )} · refunded {money(ledger.balances.refunded)} · balanced: {ledger
        .balances.is_balanced
        ? "yes"
        : "no"}
    </p>
    {#if quoteId}<a href={`/quotes/${quoteId}`}>Read linked checkout quote</a
      >{:else}<p class="small muted">
        No linked checkout quote was available.
      </p>{/if}
  </section>
  <p><a href={`/orders/${id}/refunds`}>Inspect complete refund ledger</a></p>
  {#key activityVersion}<OrderActivity orderId={id} />{/key}
  <fieldset disabled={busy || !ready || !!pending}>
    <section class="card">
      <h2>Cancel unpaid order</h2>
      <p>
        Only an unpaid, unshipped eligible order can be cancelled. This is not a
        refund.
      </p>
      <label
        >Customer-visible reason<textarea
          bind:value={cancelReason}
          maxlength="500"></textarea></label
      ><label class="check-label"
        ><input type="checkbox" bind:checked={confirmed["cancel-order"]} /> I confirm
        this cancellation and its reservation release.</label
      ><button onclick={() => submit("cancel-order")}
        >Cancel eligible order</button
      >
    </section>
    <section class="card">
      <h2>Record external payment</h2>
      <p>
        <strong>Bookkeeping only.</strong> This does not capture provider funds.
      </p>
      <label
        >Provider<input bind:value={manualProvider} maxlength="200" /></label
      ><label
        >Safe external reference (optional)<input
          bind:value={manualReference}
          maxlength="500"
        /></label
      ><label class="check-label"
        ><input type="checkbox" bind:checked={confirmed["mark-paid"]} /> I confirm
        the full order payment was independently received.</label
      ><button onclick={() => submit("mark-paid")}>Mark order paid</button>
    </section>
    <section class="card">
      <h2>Issue real PayPal refund</h2>
      <p>
        This calls the authenticated Edge endpoint. A provider acknowledgement
        is not proof that the local ledger settled.
      </p>
      <label
        >Scope<select bind:value={refundMode}
          ><option value="amount">Exact amount</option><option value="items"
            >Item quantities</option
          ><option value="shipping">Net shipping</option></select
        ></label
      >
      {#if refundMode === "amount"}<label
          >USD amount<input
            inputmode="decimal"
            bind:value={refundAmount}
          /></label
        >{:else if refundMode === "shipping"}<label
          >Net shipping USD<input
            inputmode="decimal"
            bind:value={refundShipping}
          /></label
        >{:else}{#each pricing.lines as line}<label
            >{line.name}<input
              aria-label={`Refund ${line.name}`}
              type="number"
              min="0"
              max={line.quantity}
              step="1"
              bind:value={refundItems[line.id]}
            /></label
          ><label class="small"
            >Shipped units of {line.name} returned to put back on hand<input
              aria-label={`Returned ${line.name} to restock`}
              type="number"
              min="0"
              max={line.quantity}
              step="1"
              bind:value={refundReturned[line.id]}
            /></label
          >{/each}<p class="muted">
            Returned units are restocked at the original warehouse only after
            PayPal confirms the refund, up to shipped units not already restocked.
          </p><label
          >Additional net shipping USD (optional)<input
            inputmode="decimal"
            bind:value={refundShipping}
          /></label
        ><label class="check-label"
          ><input type="checkbox" bind:checked={refundRestock} /> Release cancelled,
          unshipped inventory</label
        >{/if}
      <label
        >Provider note (optional)<textarea
          bind:value={refundReason}
          maxlength="1000"></textarea></label
      ><label class="check-label"
        ><input type="checkbox" bind:checked={confirmed["paypal-refund"]} /> I explicitly
        approve this exact real-money refund scope and stock effect.</label
      ><button class="primary" onclick={() => submit("paypal-refund")}
        >Issue PayPal refund</button
      >
    </section>
  </fieldset>
{:else if busy}<p role="status">Loading current order and ledger facts…</p>{/if}
