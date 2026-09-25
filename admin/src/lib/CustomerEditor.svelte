<script lang="ts">
  import { onMount } from "svelte";
  import { beforeNavigate } from "$app/navigation";
  import {
    supabase,
    message,
    money,
    dateTime,
    statusLabel,
    type OrderPage,
    type OrderSummary,
  } from "./api";
  import {
    getCustomer,
    updateCustomer,
    deleteCustomerAddress,
    setDefaultCustomerAddress,
    type CustomerDetail,
    type CustomerAddress,
  } from "./customers";
  import CustomerAddressEditor from "./CustomerAddressEditor.svelte";

  let { id }: { id: string } = $props();
  let customer = $state.raw<CustomerDetail | null>(null);
  let fields = $state({ email: "", full_name: "", phone: "" });
  let baseline = $state("");
  let orders = $state.raw<OrderSummary[]>([]);
  let orderCursor = $state<string | null>(null);
  let loading = $state(true);
  let ordersLoading = $state(false);
  let error = $state("");
  let ordersError = $state("");
  let notice = $state("");
  let uncertain = $state(false);
  let addressEditor = $state.raw<CustomerAddress | "new" | null>(null);
  let addressUnsettled = $state(false);
  let addressBusy = $state(false);
  let anonymizeConfirmation = $state("");
  let alive = true;
  let request = 0;
  let dirty = $derived(!!customer && JSON.stringify(fields) !== baseline);
  let readOnly = $derived(!!customer?.anonymized_at);

  onMount(() => {
    void load();
    return () => {
      alive = false;
      request++;
    };
  });
  beforeNavigate(({ cancel }) => {
    if (
      (loading || dirty || addressUnsettled || addressBusy) &&
      !window.confirm("Leave and discard unsaved customer edits?")
    )
      cancel();
  });

  function install(value: CustomerDetail) {
    customer = value;
    fields = {
      email: value.email ?? "",
      full_name: value.full_name,
      phone: value.phone ?? "",
    };
    baseline = JSON.stringify(fields);
    uncertain = false;
    addressEditor = null;
    addressUnsettled = false;
    addressBusy = false;
  }
  async function load() {
    const current = ++request;
    loading = true;
    error = "";
    notice = "";
    try {
      const value = await getCustomer(id);
      if (!alive || current !== request) return;
      if (!value)
        throw new Error("Customer not found. Return to the customer list.");
      install(value);
      orders = [];
      orderCursor = null;
      ordersError = "";
      await loadOrders(false, current);
    } catch (cause) {
      if (alive && current === request) error = message(cause);
    } finally {
      if (alive && current === request) loading = false;
    }
  }
  function reload() {
    if (
      (!dirty && !addressUnsettled) ||
      window.confirm("Discard local edits and load the saved customer?")
    )
      void load();
  }
  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (
      !customer ||
      loading ||
      uncertain ||
      readOnly ||
      addressBusy ||
      addressUnsettled ||
      addressEditor
    )
      return;
    loading = true;
    error = "";
    notice = "";
    try {
      const saved = await updateCustomer(customer, {
        email: fields.email.trim() || null,
        full_name: fields.full_name,
        phone: fields.phone.trim() || null,
      });
      if (!alive) return;
      install(saved);
      notice = "Customer saved.";
    } catch (cause) {
      if (alive) {
        uncertain = true;
        error = `${message(cause)} Reload the saved customer before another save; the request may have succeeded.`;
      }
    } finally {
      if (alive) loading = false;
    }
  }
  async function loadOrders(more: boolean, parentRequest = request) {
    if (!customer) return;
    ordersLoading = true;
    ordersError = "";
    try {
      const result = await supabase.rpc("list_admin_orders", {
        page_size: 20,
        customer_id: id,
        ...(more && orderCursor ? { after_order_number: orderCursor } : {}),
      });
      if (!alive || parentRequest !== request) return;
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
      orderCursor = page.next_cursor;
    } catch (cause) {
      if (alive && parentRequest === request) ordersError = message(cause);
    } finally {
      if (alive && parentRequest === request) ordersLoading = false;
    }
  }
  function addressLines(address: CustomerAddress) {
    return [
      address.recipient_name,
      address.line1,
      address.line2,
      [address.city, address.region, address.postal_code]
        .filter(Boolean)
        .join(", "),
      address.country,
      address.phone,
    ].filter(Boolean);
  }
  function installAddressResult(value: CustomerDetail, text: string) {
    install(value);
    addressEditor = null;
    addressUnsettled = false;
    notice = text;
  }
  async function addressCommand(
    action: "delete" | "default" | "unset",
    address: CustomerAddress,
  ) {
    if (
      !customer ||
      loading ||
      dirty ||
      addressBusy ||
      uncertain ||
      addressUnsettled ||
      readOnly
    )
      return;
    const prompt =
      action === "delete"
        ? `Delete ${address.label || "this address"}? Historical orders are unchanged.`
        : action === "default"
          ? `Make ${address.label || "this address"} the default address?`
          : `Unset ${address.label || "this address"} as the default address?`;
    if (!window.confirm(prompt)) return;
    addressBusy = true;
    error = "";
    notice = "";
    try {
      const value =
        action === "delete"
          ? await deleteCustomerAddress(customer.id, address)
          : await setDefaultCustomerAddress(
              customer.id,
              address.id,
              action === "default",
            );
      if (alive)
        installAddressResult(
          value,
          action === "delete" ? "Address deleted." : "Default address changed.",
        );
    } catch (cause) {
      if (alive) {
        uncertain = true;
        error = `${message(cause)} Reload the customer before another command; the request may have succeeded.`;
      }
    } finally {
      if (alive) addressBusy = false;
    }
  }
  async function anonymize() {
    if (
      !customer ||
      loading ||
      uncertain ||
      dirty ||
      addressBusy ||
      addressUnsettled ||
      readOnly ||
      anonymizeConfirmation !== `ANONYMIZE ${customer.id}`
    )
      return;
    if (
      !window.confirm(
        "Irreversibly anonymize this customer's contact data, addresses, carts, and metafields? Historical order snapshots and Auth credentials remain.",
      )
    )
      return;
    loading = true;
    error = "";
    notice = "";
    try {
      const { data, error: rpcError } = await supabase.rpc(
        "anonymize_customer",
        { customer_id: customer.id },
      );
      if (rpcError) throw rpcError;
      const receipt = data as { id?: string; anonymized_at?: unknown };
      if (
        !receipt ||
        receipt.id?.toLowerCase() !== customer.id.toLowerCase() ||
        typeof receipt.anonymized_at !== "string"
      )
        throw Error("Invalid anonymization receipt.");
      uncertain = true;
      notice =
        "Customer anonymization submitted. Auth credentials were not deleted. Reload the original customer before another mutation.";
    } catch (cause) {
      uncertain = true;
      error = `${message(cause)} The outcome may be unknown. Reload the original customer ID; do not retry automatically.`;
    } finally {
      loading = false;
    }
  }
</script>

<svelte:head
  ><title>{customer?.full_name || "Customer"} · Tera Admin</title></svelte:head
>
<svelte:window
  onbeforeunload={(event) => {
    if (loading || dirty || addressUnsettled || addressBusy)
      event.preventDefault();
  }}
/>
<div class="page-heading">
  <div>
    <a class="small" href="/customers">← Customers</a>
    <h1>{customer?.full_name || "Customer details"}</h1>
    {#if customer}<p class="small muted">
        Customer since {dateTime(customer.created_at)} · {customer.has_account
          ? "Account"
          : "Guest"}
      </p>{/if}
  </div>
  <button onclick={reload} disabled={loading || addressBusy}
    >Reload customer</button
  >
</div>
{#if error}<p class="notice error" role="alert">{error}</p>{/if}
{#if notice}<p class="notice" role="status">{notice}</p>{/if}
{#if loading && !customer}<p class="empty" role="status">
    Loading customer…
  </p>{/if}
{#if customer}
  {#if readOnly}<p class="notice">
      This customer was anonymized {dateTime(customer.anonymized_at!)} and is read-only.
    </p>{/if}
  <div class="editor-grid">
    <div class="editor-main">
      <form class="card" onsubmit={save}>
        <h2>Contact</h2>
        <p class="small muted">
          These are store contact details. Editing email does not change the
          customer's sign-in account or historical order addresses.
        </p>
        <label
          >Full name<input
            bind:value={fields.full_name}
            disabled={loading ||
              readOnly ||
              uncertain ||
              addressBusy ||
              addressUnsettled ||
              !!addressEditor}
          /></label
        >
        <label
          >Email<input
            type="email"
            bind:value={fields.email}
            disabled={loading ||
              readOnly ||
              uncertain ||
              addressBusy ||
              addressUnsettled ||
              !!addressEditor}
          /></label
        >
        <label
          >Phone<input
            type="tel"
            bind:value={fields.phone}
            disabled={loading ||
              readOnly ||
              uncertain ||
              addressBusy ||
              addressUnsettled ||
              !!addressEditor}
          /></label
        >
        <div class="actions form-action">
          <button
            class="primary"
            disabled={loading ||
              readOnly ||
              uncertain ||
              addressBusy ||
              addressUnsettled ||
              !!addressEditor ||
              !dirty}>Save customer</button
          >
        </div>
      </form>
      <section class="card">
        <h2>Orders</h2>
        {#if ordersError}<p class="notice error" role="alert">{ordersError}</p>
          <button
            onclick={() => loadOrders(!!orderCursor)}
            disabled={ordersLoading}>Retry</button
          >{/if}
        <div class="table-wrap">
          <table>
            <thead
              ><tr
                ><th>Order</th><th>Status</th><th>Payment</th><th
                  >Total · USD</th
                ></tr
              ></thead
            ><tbody>
              {#each orders as order (order.id)}<tr
                  ><td
                    ><a class="record-link" href={`/orders/${order.id}`}
                      >#{order.order_number}</a
                    ><small class="cell-detail"
                      >{dateTime(order.created_at)}</small
                    ></td
                  ><td>{statusLabel(order.status)}</td><td
                    >{statusLabel(order.financial_status)}</td
                  ><td class="numeric">{money(order.total)}</td></tr
                >{/each}
            </tbody>
          </table>
        </div>
        {#if ordersLoading}<p class="empty" role="status">
            Loading orders…
          </p>{:else if !orders.length && !ordersError}<p class="empty">
            No orders found.
          </p>{/if}
        {#if orderCursor}<div class="list-footer">
            <span></span><button
              onclick={() => loadOrders(true)}
              disabled={ordersLoading}>Load more</button
            >
          </div>{/if}
      </section>
    </div>
    <aside class="editor-side">
      <section class="card">
        <div class="page-heading">
          <h2>Addresses</h2>
          <button
            disabled={loading ||
              dirty ||
              addressBusy ||
              uncertain ||
              readOnly ||
              !!addressEditor}
            onclick={() => (addressEditor = "new")}>Add address</button
          >
        </div>
        {#if customer.addresses.length}{#each customer.addresses as address (address.id)}<div
              class="shipment"
            >
              <strong
                >{address.label || "Address"}{address.is_default
                  ? " · Default"
                  : ""}</strong
              >{#each addressLines(address) as line}<div
                  class="small break-word"
                >
                  {line}
                </div>{/each}
              <div class="actions">
                <button
                  disabled={dirty ||
                    addressBusy ||
                    uncertain ||
                    !!addressEditor}
                  onclick={() => (addressEditor = address)}>Edit</button
                >{#if address.is_default}<button
                    disabled={dirty ||
                      addressBusy ||
                      uncertain ||
                      !!addressEditor}
                    onclick={() => addressCommand("unset", address)}
                    >Unset default</button
                  >{:else}<button
                    disabled={dirty ||
                      addressBusy ||
                      uncertain ||
                      !!addressEditor}
                    onclick={() => addressCommand("default", address)}
                    >Make default</button
                  >{/if}<button
                  disabled={dirty ||
                    addressBusy ||
                    uncertain ||
                    !!addressEditor}
                  onclick={() => addressCommand("delete", address)}
                  >Delete</button
                >
              </div>
            </div>{/each}{:else}<p class="muted small">
            No saved addresses.
          </p>{/if}
      </section>
      {#if addressEditor}<CustomerAddressEditor
          {customer}
          address={addressEditor === "new" ? undefined : addressEditor}
          onstate={(value, busy) => {
            addressUnsettled = value;
            addressBusy = busy;
          }}
          oncancel={() => {
            addressEditor = null;
            addressUnsettled = false;
          }}
          onsaved={(value) =>
            installAddressResult(
              value,
              addressEditor === "new" ? "Address added." : "Address saved.",
            )}
        />{/if}
      {#if !readOnly}<section class="card fields">
          <h2>Privacy</h2>
          <p>
            Irreversibly removes current contact data, addresses, carts, and
            metafields. Historical order snapshots remain. This does not delete
            or revoke Auth credentials.
          </p>
          <label
            >Type <code>ANONYMIZE {customer.id}</code><input
              autocomplete="off"
              bind:value={anonymizeConfirmation}
              disabled={loading ||
                uncertain ||
                dirty ||
                addressBusy ||
                addressUnsettled}
            /></label
          >
          <button
            onclick={anonymize}
            disabled={loading ||
              uncertain ||
              dirty ||
              addressBusy ||
              addressUnsettled ||
              anonymizeConfirmation !== `ANONYMIZE ${customer.id}`}
            >Anonymize customer</button
          >
        </section>{/if}
    </aside>
  </div>
{/if}
