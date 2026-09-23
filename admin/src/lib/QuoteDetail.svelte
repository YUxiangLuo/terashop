<script lang="ts">
  import { onMount } from "svelte";
  import { supabase, message, money, dateTime } from "./api";
  import type { CheckoutQuote } from "./quotes";
  let { id, query }: { id: string; query: string } = $props();
  let quote = $state.raw<CheckoutQuote | null>(null),
    busy = $state(true),
    error = $state("");
  let alive = true;
  onMount(() => {
    void load();
    return () => {
      alive = false;
    };
  });
  async function load() {
    busy = true;
    error = "";
    quote = null;
    try {
      const result = await supabase.rpc("get_admin_checkout_quote", {
        quote_id: id,
      });
      if (!alive) return;
      if (result.error) throw result.error;
      quote = result.data as unknown as CheckoutQuote | null;
    } catch (cause) {
      if (alive) error = message(cause);
    } finally {
      if (alive) busy = false;
    }
  }
</script>

<svelte:head><title>Checkout quote · Tera Admin</title></svelte:head>
<div class="page-heading">
  <div>
    <a href={`/quotes${query}`}>← Checkout quotes</a>
    <h1>Checkout quote</h1>
    <p class="small">{id}</p>
  </div>
  <button disabled={busy} onclick={load}>Reload quote</button>
</div>
{#if error}<p role="alert" class="notice error">{error}</p>{/if}
{#if busy}<p role="status">Loading quote…</p>{:else if !quote && !error}<p
    class="notice"
  >
    Quote not found.
  </p>{/if}
{#if quote}
  <section class="card">
    <h2>Loaded checkout facts</h2>
    <p>
      Effective status: <strong>{quote.status}</strong> · Stored status: {quote.stored_status}
    </p>
    <p>
      Reservation flag: {quote.is_reserved ? "active" : "inactive"}. This is not
      a stock count or proof of payment.
    </p>
    <p class="muted">
      Expiration is evaluated when loaded. An expired display does not prove
      worker cleanup is complete. Reload for current facts.
    </p>
    <p>
      Created {dateTime(quote.created_at)} · Expires {dateTime(
        quote.expires_at,
      )}
    </p>
    <p>
      <a href={`/customers/${quote.customer_id}`}>View customer</a> · {quote.customer_id}
    </p>
    {#if quote.order_id}<a class="button" href={`/orders/${quote.order_id}`}
        >View linked order</a
      >{:else}<p>No linked order.</p>{/if}
    <p class="small muted">
      Viewing this quote does not cancel an order, extend expiry or release
      inventory.
    </p>
    <a href={`/quotes/${id}/cancel${query}`}
      >Review cancellation / recover request</a
    >
  </section>
  <section class="card">
    <h2>Historical price snapshot</h2>
    <div class="table-wrap">
      <table>
        <thead
          ><tr
            ><th>Item</th><th>Quantity</th><th>Unit price</th><th>Discount</th
            ><th>Net before tax</th></tr
          ></thead
        ><tbody>
          {#each quote.lines as line}<tr
              ><td
                >{line.name}<small class="cell-detail"
                  >{line.variant_title} · {line.sku ?? "No SKU"}</small
                >{#each Object.entries(line.attributes) as [key, value]}<small
                    class="cell-detail">{key}: {value}</small
                  >{/each}</td
              ><td>{line.quantity}</td><td>{money(line.unit_price)}</td><td
                >{money(line.discount_total)}</td
              ><td>{money(line.line_total)}</td></tr
            >{/each}
        </tbody>
      </table>
    </div>
    <p>
      Subtotal {money(quote.subtotal)} · Discounts {money(quote.discount_total)} ·
      Net shipping {money(quote.shipping_total)} · Tax {money(quote.tax_total)}
    </p>
    <h3>Total · {money(quote.total)}</h3>
    <p>
      Shipping method: {quote.shipping_method_name ?? "None"} · Discount code: {quote.discount_code ??
        "None"}
    </p>
    <p class="muted">
      Frozen checkout prices, not current product prices or a refund quote.
    </p>
  </section>
  <section class="card">
    <h2>Delivery and notes</h2>
    <address>
      {#each ["recipient_name", "line1", "line2", "city", "region", "postal_code", "country", "phone"] as key}{#if typeof quote.shipping_address[key] === "string"}<div
          >
            {quote.shipping_address[key]}
          </div>{/if}{/each}
    </address>
    <h3>Customer note</h3>
    <p class="note">{quote.customer_note || "No customer note."}</p>
    <h3>Cancellation reason</h3>
    <p class="note">
      {quote.cancel_reason ?? "No cancellation reason recorded."}
    </p>
  </section>
{/if}

<style>
  .card {
    margin-bottom: 1.25rem;
    overflow-wrap: anywhere;
  }
  .page-heading {
    overflow-wrap: anywhere;
  }
  .note {
    white-space: pre-wrap;
  }
  table {
    min-width: 40rem;
  }
  td {
    max-width: 24rem;
    overflow-wrap: anywhere;
  }
</style>
