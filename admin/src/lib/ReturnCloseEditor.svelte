<script lang="ts">
  import { onMount } from "svelte";
  import { beforeNavigate } from "$app/navigation";
  import { supabase, message, dateTime } from "./api";
  import { commandKey, readCommand, dispatchCommand } from "./commands";
  import {
    isCloseReturnCommand,
    acknowledgesClosure,
    type CloseReturnCommand,
    type ReturnAuthorization,
    type OrderReturns,
  } from "./returns";
  let { orderId, returnId }: { orderId: string; returnId: string } = $props();
  let authorization = $state.raw<ReturnAuthorization | null>(null);
  let pending = $state<CloseReturnCommand | null>(null);
  let busy = $state(true),
    ready = $state(false),
    error = $state(""),
    notice = $state("");
  let key = "",
    alive = true;
  let remaining = $derived(
    authorization?.lines.reduce((sum, l) => sum + l.receivable_quantity, 0) ??
      0,
  );
  onMount(() => {
    void load();
    return () => {
      alive = false;
    };
  });
  beforeNavigate(({ cancel }) => {
    if (busy) cancel();
  });
  async function load() {
    busy = true;
    ready = false;
    error = "";
    try {
      const session = await supabase.auth.getSession();
      if (session.error || !session.data.session)
        throw Error("Sign in again to manage returns.");
      key = commandKey(session.data.session.user.id, "return-close", returnId);
      let saved = readCommand(sessionStorage, key, isCloseReturnCommand);
      if (saved && saved.return_id !== returnId)
        throw Error("Saved operation does not match this return.");
      const result = await supabase.rpc("get_order_returns", {
        order_id: orderId,
      });
      if (!alive) return;
      if (result.error) throw result.error;
      const summary = result.data as unknown as OrderReturns | null;
      const next = summary?.returns.find((r) => r.id === returnId);
      if (summary?.order_id !== orderId || !next || next.order_id !== orderId)
        throw Error("Return not found in this order.");
      if (saved) {
        if (acknowledgesClosure(next, saved, orderId)) {
          sessionStorage.removeItem(key);
          saved = null;
          notice =
            "Requested terminal state confirmed from current return facts. This does not identify who completed it.";
        } else if (
          acknowledgesClosure(
            next,
            { ...saved, cancel: !saved.cancel },
            orderId,
          )
        ) {
          sessionStorage.removeItem(key);
          saved = null;
          notice = `The return is already ${next.status}, not the requested state. No further request was sent; terminal returns cannot change state.`;
        } else if (
          next.status === "open" &&
          saved.cancel &&
          next.receipts.length > 0
        ) {
          // Receipts are immutable; an open return with receipts can no longer be cancelled.
          sessionStorage.removeItem(key);
          saved = null;
          notice =
            "Cancellation cannot complete because receipts now exist. The return remains open; review it before choosing Close return.";
        } else if (next.status !== "open") {
          throw Error(
            "Terminal return facts could not be verified. The saved request has been retained.",
          );
        }
      }
      authorization = next;
      pending = saved;
      ready = true;
    } catch (cause) {
      if (alive) error = message(cause);
    } finally {
      if (alive) busy = false;
    }
  }
  async function submit(cancel: boolean) {
    if (busy || !ready || !authorization || authorization.status !== "open")
      return;
    if (!pending && cancel && authorization.receipts.length) return;
    const command = pending ?? { return_id: returnId, cancel };
    if (
      !window.confirm(
        pending
          ? "Retry the exact saved terminal-state request?"
          : command.cancel
            ? "Cancel this unreceived return authorization permanently? It cannot be reopened. No payment or inventory changes."
            : `Close this return permanently? The currently loaded remaining receivable quantity is ${remaining}; concurrent receipts may change it before the command executes. Existing receipts and inspection work remain. No payment or inventory changes.`,
      )
    )
      return;
    busy = true;
    error = "";
    notice = "";
    try {
      // close_return is monotonic and accepts repeating the same terminal state; it has no idempotency-key parameter.
      await dispatchCommand(
        sessionStorage,
        key,
        command,
        (c) => supabase.rpc("close_return", c),
        (result) => acknowledgesClosure(result, command, orderId),
      );
      if (!alive) return;
      pending = null;
      notice = command.cancel
        ? "Return cancelled. No payment or inventory changes."
        : "Return closed. Existing receipts remain available for inspection. No payment or inventory changes.";
      await load();
    } catch (cause) {
      if (!alive) return;
      error = message(cause);
      try {
        pending = readCommand(sessionStorage, key, isCloseReturnCommand);
      } catch (cause) {
        error = message(cause);
      }
      // A fresh read reconciles a race or an unknown result before any retry.
      ready = false;
    } finally {
      if (alive) busy = false;
    }
  }
</script>

<div class="page-heading">
  <div>
    <a class="small" href={`/orders/${orderId}/returns`}>← Return history</a>
    <h1>Close or cancel return</h1>
    <p class="small muted">{returnId}</p>
  </div>
  <button
    onclick={() => {
      notice = "";
      void load();
    }}
    disabled={busy}>Check current return state</button
  >
</div>
{#if error}<p class="notice error" role="alert">{error}</p>{/if}
{#if notice}<p class="notice" role="status">{notice}</p>{/if}
{#if pending}<section class="card">
    <h2>Unconfirmed {pending.cancel ? "cancellation" : "closure"} request</h2>
    <p>
      Check current return state before retrying. The saved request is retained
      in this tab; do not switch operations while its result is unknown.
    </p>
    <p class="small">
      Return {pending.return_id} · Requested state {pending.cancel
        ? "cancelled"
        : "closed"}
    </p>
    <button disabled={busy || !ready} onclick={() => submit(pending!.cancel)}
      >Retry saved request</button
    >
  </section>{/if}
<section class="card">
  <h2>Return facts</h2>
  {#if !ready}<p class="muted">
      Actions are locked until current facts have been checked.
    </p>{/if}
  {#if authorization}<p>
      Status: <span class="badge">{authorization.status}</span>
    </p>
    <p>
      Remaining receivable: {remaining} · Receipt records: {authorization
        .receipts.length}
    </p>
    <p>Reason: {authorization.reason || "—"}</p>
    {#if authorization.closed_at}<p>
        Ended: {dateTime(authorization.closed_at)}
      </p>{/if}
    <ul>
      {#each authorization.lines as line}<li>
          Item {line.order_item_id} — Authorized {line.quantity} · Received {line.received_quantity}
          · Receivable {line.receivable_quantity}
        </li>{/each}
    </ul>
  {/if}
</section>
<section class="card">
  <h2>Choose a terminal state</h2>
  <p>
    Both actions are permanent. They release unreceived authorization
    quantities, but do not undo receipts, change stock, refund payment, or
    cancel the order or shipment.
  </p>
  <h3>Close return</h3>
  <p>
    Stop further receipts. Existing receipts and their pending inspection remain
    available, including after closure.
  </p>
  <button
    disabled={busy || !ready || !!pending || authorization?.status !== "open"}
    onclick={() => submit(false)}>Close return</button
  >
  <h3>Cancel authorization</h3>
  <p>
    Only allowed before any receipt exists. If items have been received, close
    the return instead.
  </p>
  <button
    class="danger"
    disabled={busy ||
      !ready ||
      !!pending ||
      authorization?.status !== "open" ||
      !!authorization?.receipts.length}
    onclick={() => submit(true)}>Cancel authorization</button
  >
  {#if authorization && authorization.status !== "open"}<p class="notice">
      This return is terminal and cannot be reopened or switched to another
      terminal state.
    </p>{/if}
</section>

<style>
  .card {
    margin-bottom: 1.25rem;
    overflow-wrap: anywhere;
  }
  .page-heading {
    overflow-wrap: anywhere;
  }
  h3 {
    margin-top: 1.5rem;
    font-size: 1rem;
  }
</style>
