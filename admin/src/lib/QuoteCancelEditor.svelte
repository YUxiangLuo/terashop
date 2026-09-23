<script lang="ts">
  import { onMount } from "svelte";
  import { beforeNavigate } from "$app/navigation";
  import { supabase, message } from "./api";
  import { commandKey, readCommand, dispatchCommand } from "./commands";
  import {
    isCancelQuoteCommand,
    cancellationOutcome,
    type CancelQuoteCommand,
    type CheckoutQuote,
  } from "./quotes";
  let { id, query }: { id: string; query: string } = $props();
  let quote = $state.raw<CheckoutQuote | null>(null);
  let pending = $state<CancelQuoteCommand | null>(null);
  let busy = $state(true),
    ready = $state(false),
    reason = $state(""),
    error = $state(""),
    notice = $state("");
  let key = "",
    alive = true;
  onMount(() => {
    void load();
    return () => {
      alive = false;
    };
  });
  beforeNavigate(({ cancel }) => {
    if (busy) cancel();
  });
  async function load(preserveError = false) {
    busy = true;
    ready = false;
    if (!preserveError) error = "";
    try {
      const session = await supabase.auth.getSession();
      if (session.error || !session.data.session)
        throw Error("Sign in again to cancel quotes.");
      key = commandKey(session.data.session.user.id, "quote-cancel", id);
      const saved = readCommand(sessionStorage, key, isCancelQuoteCommand);
      if (saved && saved.quote_id !== id)
        throw Error("Saved request belongs to another quote.");
      pending = saved;
      if (saved) reason = saved.reason;
      const result = await supabase.rpc("get_admin_checkout_quote", {
        quote_id: id,
      });
      if (!alive) return;
      if (result.error) throw result.error;
      const next = result.data as unknown as CheckoutQuote | null;
      if (!next || next.id !== id) throw Error("Quote not found.");
      quote = next;
      const outcome = cancellationOutcome(next);
      if (outcome) {
        if (saved) sessionStorage.removeItem(key);
        pending = null;
        notice = outcome;
        error = "";
      }
      ready = true;
    } catch (cause) {
      if (alive) error = message(cause);
    } finally {
      if (alive) busy = false;
    }
  }
  async function submit() {
    if (busy || !ready || !quote || cancellationOutcome(quote)) return;
    const command = pending ?? { quote_id: id, reason: reason.trim() };
    if (!isCancelQuoteCommand(command)) {
      error = "Enter a cancellation reason (1–500 characters).";
      return;
    }
    if (
      !window.confirm(
        pending
          ? "Retry the exact saved cancellation request? This may cancel its linked unpaid order."
          : "Permanently cancel this quote and any linked unpaid order? Reservations and discount usage may be released. This does not refund money, restore shipped stock or stop a provider payment. The server will reject unsafe cancellation.",
      )
    )
      return;
    busy = true;
    error = "";
    notice = "";
    try {
      await dispatchCommand(
        sessionStorage,
        key,
        command,
        (c) => supabase.rpc("cancel_checkout_quote", c),
        // Effective expired is ambiguous; only cancelled is an unambiguous receipt.
        (data) =>
          !!data &&
          typeof data === "object" &&
          "id" in data &&
          data.id === id &&
          "status" in data &&
          data.status === "cancelled",
      );
    } catch (cause) {
      if (!alive) return;
      error = message(cause);
      try {
        pending = readCommand(sessionStorage, key, isCancelQuoteCommand);
      } catch (cause) {
        error = message(cause);
      }
      ready = false;
    } finally {
      if (alive) busy = false;
    }
    // Read after every attempt, including a lost response. Failed reads keep actions locked.
    if (alive) await load(true);
  }
</script>

<svelte:head><title>Cancel checkout quote · Tera Admin</title></svelte:head>
<div class="page-heading">
  <div>
    <a href={`/quotes/${id}${query}`}>← Checkout quote</a>
    <h1>Cancel checkout quote</h1>
    <p class="small">{id}</p>
  </div>
  <button disabled={busy} onclick={() => load()}
    >Check current quote state</button
  >
</div>
{#if error}<p role="alert" class="notice error">{error}</p>{/if}
{#if notice}<p role="status" class="notice">{notice}</p>{/if}
<section class="card">
  <h2>Cancellation facts</h2>
  <p>
    Cancellation is permanent. A converted quote also cancels its linked unpaid
    order and releases reservations and discount usage. It does not refund money
    or restore shipped stock.
  </p>
  <p>
    Payment capture in progress, completed payment or fulfillment can prevent
    cancellation. Loaded status is not permission to cancel; the server checks
    current facts.
  </p>
  {#if quote}<p>
      Effective status: {quote.status} · Stored status: {quote.stored_status}
    </p>
    <p>Recorded reason: {quote.cancel_reason ?? "None"}</p>
    {#if quote.order_id}<a href={`/orders/${quote.order_id}`}
        >View linked order</a
      >{/if}
  {/if}
  {#if !ready}<p>
      Actions are locked until current facts have been checked.
    </p>{/if}
  {#if pending}<p class="notice">
      Unconfirmed cancellation request retained in this tab. Only the original
      reason can be retried. Closing the tab loses this recovery record; check
      backend facts before another attempt.
    </p>{/if}
  <!-- HTML maxlength counts UTF-16 units; validation enforces 500 Unicode code points. -->
  <label
    >Customer-visible reason<textarea
      id="quote-cancel-reason"
      maxlength="1000"
      bind:value={reason}
      oninput={() => {
        error = "";
      }}
      disabled={busy ||
        !ready ||
        !!pending ||
        !!(quote && cancellationOutcome(quote))}></textarea></label
  >
  <button
    class="danger"
    disabled={busy || !ready || !quote || !!cancellationOutcome(quote)}
    onclick={submit}
    >{pending ? "Retry saved cancellation" : "Cancel quote"}</button
  >
</section>

<style>
  .card,
  .page-heading {
    overflow-wrap: anywhere;
  }
  label {
    margin: 1rem 0;
  }
</style>
