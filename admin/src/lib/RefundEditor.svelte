<script lang="ts">
  import { onMount } from "svelte";
  import { beforeNavigate } from "$app/navigation";
  import { supabase, message, money, dateTime } from "./api";
  import { commandKey, readCommand, dispatchCommand } from "./commands";
  import {
    isRefundOperation,
    isRefundPreview,
    previewMatchesScope,
    refundScope,
    acknowledgesPreviewedRefund,
    ledgerRemaining,
    manualRefundBlock,
    refundItemLabel,
    refundComponentLabel,
    refundAllocatedTotal,
    type RefundPricing,
    type PreviewedRefund,
    type RefundPreview,
    type RefundScope,
    type OrderLedger,
  } from "./refunds";
  let { id }: { id: string } = $props();
  let pricing = $state.raw<RefundPricing | null>(null),
    pricingError = $state("");
  let ledger = $state.raw<OrderLedger | null>(null),
    pending = $state<PreviewedRefund | null>(null);
  let mode = $state<"amount" | "items">("amount"),
    quantities = $state<Record<string, string>>({}),
    returned = $state<Record<string, string>>({}),
    shipping = $state(""),
    restock = $state(false),
    preview = $state.raw<{ scope: RefundScope; result: RefundPreview } | null>(
      null,
    );
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
  let dirty = $derived(
    !!amount ||
      !!reason ||
      confirmed ||
      !!shipping ||
      restock ||
      Object.values(quantities).some(Boolean) ||
      Object.values(returned).some(Boolean),
  );
  let displayedPreview = $derived(pending?.preview ?? preview?.result);
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
    preview = null;
    try {
      const session = await supabase.auth.getSession();
      if (session.error || !session.data.session)
        throw Error("Sign in again to view refunds.");
      key = commandKey(session.data.session.user.id, "manual-refund", id);
      const saved = readCommand(sessionStorage, key, isRefundOperation);
      if (saved && saved.request.order_id !== id)
        throw Error("Saved refund does not belong to this order.");
      const [result, operations, snapshot] = await Promise.all([
        supabase.rpc("get_order_ledger", { order_id: id }),
        supabase.rpc("list_admin_payment_operations", {
          order_id: id,
          kind: "refund_request",
          page_size: 1,
        }),
        supabase.rpc("get_order_pricing", { order_id: id }),
      ]);
      if (!alive) return;
      if (result.error) throw result.error;
      if (operations.error) throw operations.error;
      const next = result.data as unknown as OrderLedger;
      const requests = operations.data as unknown as { items: unknown[] };
      if (!next || next.order.id !== id || !Array.isArray(requests?.items))
        throw Error("Refund facts could not be verified.");
      const prices = snapshot.data as unknown as RefundPricing | null;
      pricing = !snapshot.error && prices?.order_id === id ? prices : null;
      pricingError = pricing
        ? ""
        : "Price snapshot unavailable. Source IDs are shown instead of names. Reload refund ledger to retry.";
      ledger = next;
      pending = saved;
      block = manualRefundBlock(next, requests.items.length > 0);
      amount = "";
      reason = "";
      confirmed = false;
      quantities = {};
      returned = {};
      shipping = "";
      restock = false;
      mode = "amount";
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
  async function calculate() {
    if (busy || !ready || pending || block) return;
    preview = null;
    confirmed = false;
    error = "";
    notice = "";
    busy = true;
    try {
      if (!reason.trim() || reason.length > 2000)
        throw Error("Enter a reason (maximum 2000 characters).");
      if (mode === "items" && !pricing)
        throw Error(
          "Reload the price snapshot before selecting items or shipping.",
        );
      const scope = refundScope(
        id,
        mode,
        amount,
        quantities,
        shipping,
        restock,
        returned,
      );
      const response = await supabase.rpc("preview_manual_refund", scope);
      if (!alive) return;
      if (response.error) throw response.error;
      if (
        !isRefundPreview(response.data) ||
        !previewMatchesScope(response.data, scope)
      )
        throw Error(
          "Refund preview could not be verified. No refund was recorded.",
        );
      preview = { scope, result: response.data };
    } catch (cause) {
      if (alive) error = message(cause);
    } finally {
      if (alive) busy = false;
    }
  }
  async function submit() {
    if (busy || !ready || !ledger || (!pending && block)) return;
    error = "";
    notice = "";
    let command: PreviewedRefund;
    try {
      if (!pending && !confirmed)
        throw Error(
          "Confirm that the offline refund has already been completed.",
        );
      if (!pending && !preview)
        throw Error("Preview the refund before confirming.");
      command = pending ?? {
        request: {
          ...preview!.scope,
          preview_token: preview!.result.preview_token,
          reason: reason.trim(),
          idempotency_key: crypto.randomUUID(),
        },
        preview: preview!.result,
      };
      if (!isRefundOperation(command))
        throw Error("Refund request could not be verified.");
    } catch (cause) {
      error = message(cause);
      return;
    }
    if (
      !window.confirm(
        pending
          ? `Replay the exact saved bookkeeping request? Do not refund the customer a second time.`
          : `Record ${money(preview!.result.amount)} as already refunded offline, with the displayed item cancellation and stock release? This sends no money. Changed facts will reject this preview.`,
      )
    )
      return;
    busy = true;
    try {
      await dispatchCommand(
        sessionStorage,
        key,
        command,
        (c) => supabase.rpc("commit_manual_refund", c.request),
        (result) => acknowledgesPreviewedRefund(result, command),
      );
      if (!alive) return;
      pending = null;
      amount = "";
      reason = "";
      confirmed = false;
      notice =
        "Manual refund bookkeeping confirmed. No provider funds were sent. See the recorded allocation and stock effects below.";
      await load();
    } catch (cause) {
      if (!alive) return;
      error = message(cause);
      try {
        pending = readCommand(sessionStorage, key, isRefundOperation);
      } catch (cause) {
        ready = false;
        error = message(cause);
      }
      if (!pending) ready = false;
      preview = null;
      confirmed = false;
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
    <p>{pending.request.reason}</p>
    <p class="small">Request {pending.request.idempotency_key}</p>
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
  <h2>Preview an offline refund</h2>
  <p>
    This form only records an already completed offline refund for manual-only
    orders. It does not send money. Item refunds include their tax and may
    cancel unshipped quantities. Stock release restores cancelled unshipped
    stock; shipped units the customer sent back are restocked only when entered
    per line. Real PayPal refunds are not available here.
  </p>
  {#if block}<p class="notice">{block}</p>{/if}
  <form
    onsubmit={(e) => {
      e.preventDefault();
      void calculate();
    }}
  >
    <fieldset disabled={busy || !ready || !!pending || !!block || !!preview}>
      <label for="refund-mode">Refund scope</label>
      <select id="refund-mode" bind:value={mode}>
        <option value="amount">Unallocated amount</option>
        <option value="items" disabled={!pricing}>Items / net shipping</option>
      </select>
      {#if mode === "amount"}
        <label for="refund-amount">Amount already refunded (USD)</label><input
          id="refund-amount"
          inputmode="decimal"
          bind:value={amount}
          required
          placeholder="0.00"
        />
        <p class="muted">
          Amount-only refunds do not cancel items, allocate taxes or release
          stock.
        </p>
      {:else}
        <p class="muted">
          Enter quantities to refund, leaving others blank. Ordered quantities
          are historical, not current refundable limits; the server checks
          eligibility during preview.
        </p>
        {#each pricing?.lines ?? [] as line}
          <label for={`refund-item-${line.id}`}
            >{refundItemLabel(pricing, line.id)} · Ordered {line.quantity}</label
          >
          <input
            id={`refund-item-${line.id}`}
            data-refund-item
            inputmode="numeric"
            bind:value={quantities[line.id]}
            placeholder="0"
          />
          <label for={`refund-returned-${line.id}`} class="small"
            >Shipped units returned by the customer to put back on hand</label
          >
          <input
            id={`refund-returned-${line.id}`}
            data-refund-returned
            inputmode="numeric"
            bind:value={returned[line.id]}
            placeholder="0"
          />
        {/each}
        <p class="muted">
          Returned units count toward the refunded quantity, are never treated as
          unshipped cancellations and are restocked at the warehouse that
          originally shipped them. They cannot exceed shipped units not already
          restocked.
        </p>
        {#if pricing?.shipping_line}
          <label for="refund-shipping"
            >Net shipping to refund (USD, excluding tax)</label
          >
          <input
            id="refund-shipping"
            inputmode="decimal"
            bind:value={shipping}
            placeholder="Leave blank to exclude shipping"
          />
        {/if}
        <label class="confirmation"
          ><input id="refund-restock" type="checkbox" bind:checked={restock} /> Release
          stock for cancelled unshipped quantities only.</label
        >
      {/if}
      <label for="refund-reason"
        >Reason / offline refund reference (visible to the customer)</label
      ><textarea
        id="refund-reason"
        maxlength="2000"
        bind:value={reason}
        rows="3"
        required></textarea>
      <button class="primary">Preview refund</button>
    </fieldset>
  </form>
</section>
{#if displayedPreview}
  <section class="card" aria-label="Refund preview">
    <h2>Refund preview · {money(displayedPreview.amount)}</h2>
    <p>
      No funds sent. This preview reserves nothing; changes to balances or stock
      effects require a new preview and confirmation.
    </p>
    <ul>
      {#each displayedPreview.lines as line}<li>
          {refundItemLabel(pricing, line.order_item_id)} · {line.quantity} units ·
          Net {money(line.amount)} · Cancel {line.cancelled_quantity} · Release stock
          {line.restocked_quantity} · Restock returned {line.restock_shipped_quantity}
        </li>{/each}
      {#each displayedPreview.components as component}<li>
          {refundComponentLabel(pricing, component)}: {money(component.amount)}
        </li>{/each}
    </ul>
    <p>Total including tax: {money(displayedPreview.amount)}</p>
    {#if !pending}
      <fieldset disabled={busy || !ready || !!block}>
        <label class="confirmation"
          ><input
            id="refund-confirm"
            type="checkbox"
            bind:checked={confirmed}
            required
          /> I confirm this exact amount has been refunded offline and approve the
          displayed cancellation, stock release and returned-unit restock.</label
        ><button class="primary" disabled={!confirmed} onclick={submit}
          >Record manual refund</button
        >
        <button
          onclick={() => {
            preview = null;
            confirmed = false;
          }}>Change selection</button
        >
      </fieldset>
    {/if}
  </section>
{/if}
<section class="card">
  <h2>Refund records</h2>
  {#if pricingError}<p class="notice" role="status">{pricingError}</p>{/if}
  <p class="muted">
    Item amounts are net of discounts and exclude tax. Tax and shipping are
    separate components. Stock released means cancelled unshipped stock;
    restocked returned means shipped units the customer sent back.
  </p>
  {#if !ready || pending}<p class="muted">
      Last loaded facts only; unresolved requests may not appear yet.
    </p>{/if}
  {#if ledger && !ledger.refunds.length}<p class="muted">
      No refund records.
    </p>{/if}
  {#each ledger?.refunds ?? [] as refund}
    {@const transaction = ledger?.transactions.find(
      (t) => t.id === refund.payment_transaction_id,
    )}
    <article>
      <h3>{money(refund.amount)} · {refund.status} · {refund.source}</h3>
      <p class="small">{dateTime(refund.created_at)} · {refund.id}</p>
      <p>{refund.reason || "No reason"}</p>
      <p class="small">
        {transaction
          ? `${transaction.provider} · ${transaction.kind} · ${transaction.status} · ${money(transaction.amount)}`
          : "No linked transaction in the loaded ledger."}
      </p>
      <ul>
        {#each refund.lines as line}<li>
            {refundItemLabel(pricing, line.order_item_id)}: {line.quantity} units
            · Net {money(line.amount)} · Cancelled {line.cancelled_quantity} · Stock
            released {line.restocked_quantity} · Restocked returned {line.restock_shipped_quantity}
            <span class="small source-id">Item ID: {line.order_item_id}</span>
          </li>{/each}{#each refund.components as component}<li>
            {refundComponentLabel(pricing, component)}: {money(
              component.amount,
            )}
            {#if component.tax_line_id || component.shipping_line_id}<span
                class="small source-id"
                >Source ID: {component.tax_line_id ??
                  component.shipping_line_id}</span
              >{/if}
          </li>{/each}
      </ul>
      <p>Allocated total: {money(refundAllocatedTotal(refund))}</p>
      {#if refundAllocatedTotal(refund) !== refund.amount}<p
          class="notice error"
        >
          Allocation does not match the refund amount. Reconcile this record
          before further bookkeeping.
        </p>{/if}
    </article>{/each}
</section>
<section class="card">
  <h2>Recorded payment transactions</h2>
  <p class="muted">
    Ledger records only, not proof of external settlement. Only succeeded
    captures and refunds contribute to the balances above. Provider references
    are not displayed.
  </p>
  {#if !ready || pending}<p class="muted">
      Last loaded facts; reload after resolving the request.
    </p>{/if}
  {#if ledger && !ledger.transactions.length}<p class="muted">
      No recorded transactions.
    </p>{/if}
  {#each ledger?.transactions ?? [] as transaction}<article>
      <h3>
        {money(transaction.amount)} · {transaction.kind} · {transaction.status}
      </h3>
      <p>
        {transaction.provider} · {dateTime(
          transaction.processed_at ?? transaction.created_at,
        )}
      </p>
      <p class="small">Transaction {transaction.id}</p>
      {#if transaction.parent_transaction_id}<p class="small">
          Parent transaction {transaction.parent_transaction_id}
        </p>{/if}
    </article>{/each}
</section>

<style>
  .source-id {
    display: block;
  }
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
