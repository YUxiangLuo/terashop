<script lang="ts">
  import { onMount } from "svelte";
  import { beforeNavigate } from "$app/navigation";
  import { supabase, message, dateTime, type OrderDetail } from "./api";
  import { commandKey, readCommand, dispatchCommand } from "./commands";
  import {
    isDisposeCommand,
    dispositionQuantity,
    acknowledgesDisposition,
    type DisposeCommand,
    type ReceiptLine,
    type ReturnReceipt,
    type OrderReturns,
  } from "./returns";
  let { orderId, lineId }: { orderId: string; lineId: string } = $props();
  let line = $state.raw<ReceiptLine | null>(null),
    receipt = $state.raw<ReturnReceipt | null>(null);
  let label = $state(""),
    returnStatus = $state("");
  let pending = $state<DisposeCommand | null>(null);
  let busy = $state(true),
    ready = $state(false),
    error = $state(""),
    notice = $state("");
  let quantity = $state<number | undefined>(),
    disposition = $state<"" | "restock" | "discard">(""),
    note = $state("");
  let key = "",
    alive = true;
  let dirty = $derived(!!quantity || !!disposition || !!note);
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
          "Discard unsaved inspection edits? Dispatched requests remain saved in this tab.",
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
        throw Error("Sign in again to inspect returns.");
      key = commandKey(
        session.data.session.user.id,
        "return-disposition",
        lineId,
      );
      const saved = readCommand(sessionStorage, key, isDisposeCommand);
      if (saved && saved.receipt_line_id !== lineId)
        throw Error("Saved disposition does not match this receipt line.");
      const [detail, result] = await Promise.all([
        supabase.rpc("get_admin_order", { order_id: orderId }),
        supabase.rpc("get_order_returns", { order_id: orderId }),
      ]);
      if (!alive) return;
      if (detail.error) throw detail.error;
      if (result.error) throw result.error;
      const order = detail.data as unknown as OrderDetail | null;
      const summary = result.data as unknown as OrderReturns | null;
      const authorization = summary?.returns.find((r) =>
        r.receipts.some((receipt) =>
          receipt.lines.some((l) => l.id === lineId),
        ),
      );
      const nextReceipt = authorization?.receipts.find((r) =>
        r.lines.some((l) => l.id === lineId),
      );
      const nextLine = nextReceipt?.lines.find((l) => l.id === lineId);
      if (
        order?.id !== orderId ||
        summary?.order_id !== orderId ||
        !authorization ||
        authorization.order_id !== orderId ||
        !nextReceipt ||
        nextReceipt.order_id !== orderId ||
        !nextLine
      )
        throw Error("Receipt line not found in this order.");
      const orderItem = authorization.lines.find(
        (l) => l.id === nextLine.return_line_id,
      )?.order_item_id;
      const item = order.pricing.lines.find((i) => i.id === orderItem);
      label = item
        ? `${item.name} · ${item.sku ?? item.variant_title}`
        : nextLine.return_line_id;
      line = nextLine;
      receipt = nextReceipt;
      returnStatus = authorization.status;
      pending = saved;
      quantity = undefined;
      disposition = "";
      note = "";
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
      window.confirm("Discard unsaved inspection edits and reload?")
    ) {
      notice = "";
      void load();
    }
  }
  async function submit() {
    if (busy || !ready || !line || !receipt) return;
    error = "";
    notice = "";
    let command: DisposeCommand;
    try {
      if (!pending && disposition !== "restock" && disposition !== "discard")
        throw Error("Choose restock or discard explicitly.");
      command = pending ?? {
        receipt_line_id: lineId,
        quantity: dispositionQuantity(quantity, line.undisposed_quantity),
        disposition: disposition as "restock" | "discard",
        note,
        idempotency_key: crypto.randomUUID(),
      };
      if (!isDisposeCommand(command))
        throw Error(
          "Check disposition quantity and note (maximum 2000 characters).",
        );
    } catch (cause) {
      error = message(cause);
      return;
    }
    if (
      !window.confirm(
        pending
          ? "Replay the exact saved disposition request?"
          : `${command.disposition === "restock" ? "Restock" : "Discard"} ${command.quantity} item(s) at receipt location ${receipt.location_id}? ${command.disposition === "restock" ? "This increases sellable stock if the original deduction allows it." : "This records disposal without adding stock."} This cannot be edited or undone here and does not refund payment.`,
      )
    )
      return;
    busy = true;
    try {
      await dispatchCommand(
        sessionStorage,
        key,
        command,
        (c) => supabase.rpc("dispose_return_receipt", c),
        (result) => acknowledgesDisposition(result, command),
      );
      if (!alive) return;
      pending = null;
      quantity = undefined;
      disposition = "";
      note = "";
      notice =
        command.disposition === "restock"
          ? "Restock recorded at the receipt location. No payment refunded."
          : "Discard recorded. No stock added or payment refunded.";
      await load();
    } catch (cause) {
      if (!alive) return;
      error = message(cause);
      try {
        pending = readCommand(sessionStorage, key, isDisposeCommand);
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
    <h1>Inspect returned items</h1>
    <p class="small muted">Receipt line {lineId}</p>
  </div>
  <button onclick={reload} disabled={busy}>Reload inspection facts</button>
</div>
{#if error}<p class="notice error" role="alert">{error}</p>{/if}
{#if notice}<p class="notice" role="status">{notice}</p>{/if}
{#if pending}<section class="card">
    <h2>Unconfirmed disposition request</h2>
    <p>
      Do not submit a new operation. Replay the exact saved request, even if the
      remaining quantity or location availability changed. Saved only in this
      tab.
    </p>
    <p>{pending.disposition} × {pending.quantity} · {label}</p>
    <p>Note: {pending.note || "—"}</p>
    <p class="small">Request {pending.idempotency_key}</p>
    <button class="primary" disabled={busy || !ready} onclick={submit}
      >Replay saved disposition</button
    >
  </section>{/if}
<section class="card">
  <h2>Record inspection outcome</h2>
  {#if line && receipt}<p>{label}</p>
    <p>
      Received {line.quantity} · Undisposed {line.undisposed_quantity} · Return {returnStatus}
    </p>
    <p class="small">
      Receipt {receipt.id} · Actual receiving location {receipt.location_id}
    </p>{/if}
  <p>
    Restock adds sellable stock only at the actual receiving location, which
    must be active. The server checks the original inventory deduction, not the
    product’s current tracking setting. Discard records disposal without adding
    stock. Neither operation refunds payment. Existing receipts may be inspected
    after the return is closed.
  </p>
  {#if ready && line?.undisposed_quantity === 0 && !pending}<p class="notice">
      This receipt line is fully disposed.
    </p>{/if}
  <form
    onsubmit={(e) => {
      e.preventDefault();
      void submit();
    }}
  >
    <fieldset
      disabled={busy || !ready || !!pending || !line?.undisposed_quantity}
    >
      <label for="disposition-kind">Inspection outcome</label><select
        id="disposition-kind"
        bind:value={disposition}
        required
        ><option value="">Select an outcome</option><option value="restock"
          >Restock — increase sellable stock</option
        ><option value="discard">Discard — do not add stock</option></select
      >
      <label for="disposition-quantity">Quantity to dispose</label><input
        id="disposition-quantity"
        type="number"
        min="1"
        max={line?.undisposed_quantity ?? 0}
        step="1"
        bind:value={quantity}
        required
      />
      <label for="disposition-note"
        >Inspection note (visible to the customer)</label
      ><textarea
        id="disposition-note"
        maxlength="2000"
        rows="3"
        bind:value={note}></textarea><button class="primary"
        >Record disposition</button
      >
    </fieldset>
  </form>
</section>
<section class="card">
  <h2>Disposition history</h2>
  {#if !ready || pending}<p class="muted">
      Last loaded facts only; unresolved requests may not appear yet.
    </p>{/if}
  {#if line && !line.dispositions.length}<p class="muted">
      No dispositions recorded.
    </p>{/if}
  {#each line?.dispositions ?? [] as fact}<article>
      <h3>{fact.disposition} × {fact.quantity}</h3>
      <p class="small">{dateTime(fact.created_at)} · {fact.id}</p>
      <p>{fact.note || "No note"}</p>
      <p class="small">
        Inventory movement: {fact.inventory_movement_id ??
          "None (no stock added)"}
      </p>
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
  article {
    border-top: 1px solid #dfe4dc;
    padding: 1rem 0;
  }
  h3 {
    font-size: 1rem;
  }
</style>
