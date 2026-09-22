<script lang="ts">
  import { onMount } from "svelte";
  import {
    supabase,
    message,
    money,
    dateTime,
    statusLabel,
    type OrderSummary,
    type OrderPage,
  } from "$lib/api";
  let orders = $state.raw<OrderSummary[]>([]);
  let cursor = $state<string | null>(null);
  let status = $state("");
  let payment = $state("");
  let fulfillment = $state("");
  let applied = { status: "", payment: "", fulfillment: "" };
  let loading = $state(true);
  let error = $state("");
  let request = 0;
  let alive = true;
  let retryMore = false;
  onMount(() => {
    void load(false);
    return () => {
      alive = false;
      request++;
    };
  });
  async function load(more: boolean) {
    const current = ++request;
    loading = true;
    error = "";
    retryMore = more;
    if (!more) {
      applied = { status, payment, fulfillment };
      cursor = null;
      orders = [];
    }
    try {
      const result = await supabase.rpc("list_admin_orders", {
        page_size: 20,
        ...(applied.status ? { status_filter: applied.status } : {}),
        ...(applied.payment
          ? { financial_status_filter: applied.payment }
          : {}),
        ...(applied.fulfillment
          ? { fulfillment_status_filter: applied.fulfillment }
          : {}),
        ...(more && cursor ? { after_order_number: cursor } : {}),
      });
      if (!alive || current !== request) return;
      if (result.error) throw result.error;
      const page = result.data as unknown as OrderPage;
      orders = more
        ? [
            ...orders,
            ...page.items.filter(
              (item) => !orders.some((old) => old.id === item.id),
            ),
          ]
        : page.items;
      cursor = page.next_cursor;
    } catch (cause) {
      if (alive && current === request) error = message(cause);
    } finally {
      if (alive && current === request) loading = false;
    }
  }
</script>

<svelte:head><title>Orders · Tera Admin</title></svelte:head>
<div class="page-heading">
  <div>
    <p class="eyebrow">Operations</p>
    <h1>Orders</h1>
    <p class="small muted">
      From a confirmed purchase to a considered delivery.
    </p>
  </div>
  <button onclick={() => load(false)} disabled={loading}>Refresh orders</button>
</div>
<section class="card" aria-label="Orders">
  <form
    class="toolbar"
    onsubmit={(event) => {
      event.preventDefault();
      void load(false);
    }}
  >
    <label
      >Order status<select bind:value={status}
        ><option value="">All orders</option
        >{#each ["open", "completed", "cancelled"] as value}<option {value}
            >{statusLabel(value)}</option
          >{/each}</select
      ></label
    >
    <label
      >Payment<select bind:value={payment}
        ><option value="">All payments</option
        >{#each ["pending", "paid", "partially_refunded", "refunded", "voided"] as value}<option
            {value}>{statusLabel(value)}</option
          >{/each}</select
      ></label
    >
    <label
      >Fulfillment<select bind:value={fulfillment}
        ><option value="">All fulfillment</option
        >{#each ["unfulfilled", "partially_fulfilled", "fulfilled"] as value}<option
            {value}>{statusLabel(value)}</option
          >{/each}</select
      ></label
    >
    <button disabled={loading}>Apply filters</button>
  </form>
  {#if error}<p class="notice error" role="alert">{error}</p>
    <button onclick={() => load(retryMore)} disabled={loading}>Retry</button
    >{/if}
  <div class="table-wrap">
    <table>
      <thead
        ><tr
          ><th scope="col">Order</th><th scope="col">Customer</th><th
            scope="col">Payment</th
          ><th scope="col">Fulfillment</th><th scope="col">Total · USD</th></tr
        ></thead
      ><tbody>
        {#each orders as order (order.id)}<tr>
            <td
              ><a class="record-link" href={`/orders/${order.id}`}
                >#{order.order_number}</a
              ><small class="cell-detail">{dateTime(order.created_at)}</small
              ><span class="small muted">{order.status}</span></td
            >
            <td class="break-word">{order.email}</td>
            <td
              ><span class={["badge", order.financial_status]}
                >{statusLabel(order.financial_status)}</span
              ></td
            >
            <td
              ><span class={["badge", order.fulfillment_status]}
                >{statusLabel(order.fulfillment_status)}</span
              ></td
            >
            <td class="numeric">{money(order.total)}</td>
          </tr>{/each}
      </tbody>
    </table>
  </div>
  {#if loading}<p class="empty" role="status">
      Loading orders…
    </p>{:else if !orders.length && !error}<div class="empty">
      <h2>No orders found</h2>
      <p>Orders will appear here after checkout. Try a different filter.</p>
    </div>{/if}
  <div class="list-footer">
    <span class="small muted"
      >{orders.length} loaded · Highest order number first</span
    >{#if cursor}<button onclick={() => load(true)} disabled={loading}
        >Load more</button
      >{/if}
  </div>
</section>
