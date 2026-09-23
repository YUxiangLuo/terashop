<script lang="ts">
  import { onMount } from "svelte";
  import { beforeNavigate } from "$app/navigation";
  import { supabase, message, money, dateTime } from "./api";
  import { shippingMoney } from "./shipping";
  import { commandKey, readCommand, dispatchCommand } from "./commands";
  import {
    isManualRefundCommand,
    acknowledgesManualRefund,
    ledgerRemaining,
    manualRefundBlock,
    type ManualRefundCommand,
    type OrderLedger,
  } from "./refunds";
  let { id }: { id: string } = $props();
  let ledger = $state.raw<OrderLedger | null>(null),
    pending = $state<ManualRefundCommand | null>(null);
  let busy = $state(true),
    ready = $state(false),
    error = $state(""),
    notice = $state(""),
    block = $state("");
  let amount = $state(""),
    reason = $state(""),
    confirmed = $state(false);
  let key = "",
    alive = true;
  let dirty = $derived(!!amount || !!reason || confirmed);
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
          "Discard unsaved refund bookkeeping fields? Dispatched requests remain saved in this tab.",
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
        throw Error("Sign in again to view refunds.");
      key = commandKey(session.data.session.user.id, "manual-refund", id);
      const saved = readCommand(sessionStorage, key, isManualRefundCommand);
      if (saved && saved.order_id !== id)
        throw Error("Saved refund does not belong to this order.");
      const [result, operations] = await Promise.all([
        supabase.rpc("get_order_ledger", { order_id: id }),
        supabase.rpc("list_admin_payment_operations", {
          order_id: id,
          kind: "refund_request",
          page_size: 1,
        }),
      ]);
      if (!alive) return;
      if (result.error) throw result.error;
      if (operations.error) throw operations.error;
      const next = result.data as unknown as OrderLedger;
      const requests = operations.data as unknown as { items: unknown[] };
      if (!next || next.order.id !== id || !Array.isArray(requests?.items))
        throw Error("Refund facts could not be verified.");
      ledger = next;
      pending = saved;
      block = manualRefundBlock(next, requests.items.length > 0);
      amount = "";
      reason = "";
      confirmed = false;
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
      window.confirm("Discard unsaved fields and reload the ledger?")
    ) {
      notice = "";
      void load();
    }
  }
  async function submit() {
    if (busy || !ready || !ledger || (!pending && block)) return;
    error = "";
    notice = "";
    let command: ManualRefundCommand;
    try {
      if (!pending && !confirmed)
        throw Error(
          "Confirm that the offline refund has already been completed.",
        );
      command = pending ?? {
        order_id: id,
        amount: shippingMoney(amount),
        reason: reason.trim(),
        restock: false,
        provider: "manual",
        idempotency_key: crypto.randomUUID(),
      };
      if (!isManualRefundCommand(command))
        throw Error(
          "Enter a positive USD amount and a reason (maximum 2000 characters).",
        );
      if (!pending && command.amount > ledgerRemaining(ledger))
        throw Error(
          "Amount exceeds the loaded succeeded-only ledger balance. Reload and reconcile the order.",
        );
    } catch (cause) {
      error = message(cause);
      return;
    }
    if (
      !window.confirm(
        pending
          ? `Replay the exact saved ${money(command.amount)} bookkeeping request? Do not refund the customer a second time.`
          : `Record ${money(command.amount)} as already refunded offline? This marks a succeeded refund in the ledger but sends no money. It does not cancel items, allocate taxes or restock inventory.`,
      )
    )
      return;
    busy = true;
    try {
      await dispatchCommand(
        sessionStorage,
        key,
        command,
        (c) => supabase.rpc("refund_order", c),
        (result) => acknowledgesManualRefund(result, command),
      );
      if (!alive) return;
      pending = null;
      amount = "";
      reason = "";
      confirmed = false;
      notice =
        "Manual refund bookkeeping confirmed. No provider funds were sent; no inventory or item quantities changed.";
      await load();
    } catch (cause) {
      if (!alive) return;
      error = message(cause);
      try {
        pending = readCommand(sessionStorage, key, isManualRefundCommand);
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
    <a class="small" href={`/orders/${id}`}>← Order details</a>
    <h1>Refund ledger{ledger ? ` · #${ledger.order.order_number}` : ""}</h1>
    <p class="muted">Manual bookkeeping is not a payment-provider refund.</p>
  </div>
  <button onclick={reload} disabled={busy}>Reload refund ledger</button>
</div>
{#if error}<p class="notice error" role="alert">{error}</p>{/if}
{#if notice}<p class="notice" role="status">{notice}</p>{/if}
{#if pending}<section class="card">
    <h2>Unconfirmed manual refund request</h2>
    <p>
      Do not refund the customer again or create another record. Replay only
      this exact request, even if the remaining balance changed. Saved only in
      this browser tab.
    </p>
    <p>{money(pending.amount)} · {pending.reason}</p>
    <p class="small">Request {pending.idempotency_key}</p>
    <button class="primary" disabled={busy || !ready} onclick={submit}
      >Replay saved bookkeeping</button
    >
  </section>{/if}
{#if ledger}<section class="card">
    <h2>Recorded balances</h2>
    <p>
      Captured: {money(ledger.balances.captured)} · Refunded: {money(
        ledger.balances.refunded,
      )} · Net paid: {money(ledger.balances.net_paid)}
    </p>
    <p>Succeeded-only remaining balance: {money(ledgerRemaining(ledger))}</p>
    <p class="muted">
      These are loaded ledger facts, not a refund quote. They exclude active
      provider reservations and may change concurrently. See order payment
      activity for pending requests and reconciliation.
    </p>
  </section>{/if}
<section class="card">
  <h2>Record an offline amount refund</h2>
  <p>
    This form only records an already completed offline refund for manual-only
    orders. It does not send money. Amounts are unallocated: no item
    cancellation, tax/shipping allocation or stock change. Real PayPal refunds
    and item-based refunds are not available here.
  </p>
  {#if block}<p class="notice">{block}</p>{/if}
  <form
    onsubmit={(e) => {
      e.preventDefault();
      void submit();
    }}
  >
    <fieldset disabled={busy || !ready || !!pending || !!block}>
      <label for="refund-amount">Amount already refunded (USD)</label><input
        id="refund-amount"
        inputmode="decimal"
        bind:value={amount}
        required
        placeholder="0.00"
      />
      <label for="refund-reason"
        >Reason / offline refund reference (visible to the customer)</label
      ><textarea
        id="refund-reason"
        maxlength="2000"
        bind:value={reason}
        rows="3"
        required></textarea>
      <label class="confirmation"
        ><input
          id="refund-confirm"
          type="checkbox"
          bind:checked={confirmed}
          required
        /> I confirm the offline refund is complete and this is bookkeeping only.</label
      ><button class="primary">Record manual refund</button>
    </fieldset>
  </form>
</section>
<section class="card">
  <h2>Refund records</h2>
  {#if !ready || pending}<p class="muted">
      Last loaded facts only; unresolved requests may not appear yet.
    </p>{/if}
  {#if ledger && !ledger.refunds.length}<p class="muted">
      No refund records.
    </p>{/if}
  {#each ledger?.refunds ?? [] as refund}<article>
      <h3>{money(refund.amount)} · {refund.status} · {refund.source}</h3>
      <p class="small">{dateTime(refund.created_at)} · {refund.id}</p>
      <p>{refund.reason || "No reason"}</p>
      <ul>
        {#each refund.lines as line}<li>
            Item {line.order_item_id}: {line.quantity} × units · Net {money(
              line.amount,
            )} · Cancelled {line.cancelled_quantity} · Stock released {line.restocked_quantity}
          </li>{/each}{#each refund.components as component}<li>
            {component.kind}: {money(component.amount)}
          </li>{/each}
      </ul>
    </article>{/each}
</section>

<style>
  .card {
    margin-bottom: 1.25rem;
    overflow-wrap: anywhere;
  }
  fieldset {
    border: 0;
    padding: 0;
    min-width: 0;
    display: grid;
    gap: 0.8rem;
  }
  .confirmation {
    display: flex;
    align-items: start;
    gap: 0.6rem;
  }
  .confirmation input {
    width: auto;
  }
  article {
    border-top: 1px solid #dfe4dc;
    padding: 1rem 0;
  }
  h3 {
    font-size: 1rem;
  }
</style>
