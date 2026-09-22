<script lang="ts">
  import { beforeNavigate } from "$app/navigation";
  import { onMount } from "svelte";
  import { supabase, message } from "./api";
  import {
    commandKey,
    dispatchCommand,
    isFulfillmentUpdateCommand,
    readCommand,
    type FulfillmentUpdateCommand,
  } from "./commands";

  export interface Fulfillment {
    id: string;
    order_id: string;
    version: number;
    status: string;
    carrier: string;
    tracking_number: string;
    tracking_url: string | null;
    shipped_at: string | null;
    delivered_at: string | null;
    created_at: string;
  }

  let {
    fulfillmentId,
    orderId,
    disabled = false,
    onSaved,
    onBusyChange,
  }: {
    fulfillmentId: string;
    orderId: string;
    disabled?: boolean;
    onSaved: () => void | Promise<void>;
    onBusyChange?: (busy: boolean) => void;
  } = $props();
  let fulfillment = $state.raw<Fulfillment | null>(null);
  let carrier = $state("");
  let trackingNumber = $state("");
  let trackingUrl = $state("");
  let pending = $state<FulfillmentUpdateCommand | null>(null);
  let key = "";
  let busy = $state(true);
  let ready = $state(false);
  let error = $state("");
  let notice = $state("");
  let alive = true;
  let dirty = $derived(
    !!fulfillment &&
      (carrier !== fulfillment.carrier ||
        trackingNumber !== fulfillment.tracking_number ||
        trackingUrl !== (fulfillment.tracking_url ?? "")),
  );

  onMount(() => {
    void load();
    return () => {
      alive = false;
    };
  });
  beforeNavigate(({ cancel }) => {
    if (
      (busy || dirty) &&
      !window.confirm(
        "Leave this order? Unsaved fulfillment edits will be discarded. Any dispatched update remains saved in this tab.",
      )
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
        throw new Error("Sign in again to manage fulfillments.");
      key = commandKey(
        session.data.session.user.id,
        "fulfillment-update",
        fulfillmentId,
      );
      const saved = readCommand(
        sessionStorage,
        key,
        isFulfillmentUpdateCommand,
      );
      if (saved && saved.fulfillment_id !== fulfillmentId)
        throw new Error("The saved update does not match this fulfillment.");
      const result = await supabase.rpc("get_admin_order", {
        order_id: orderId,
      });
      if (!alive) return;
      if (result.error) throw result.error;
      const detail = result.data as unknown as {
        fulfillments: Fulfillment[];
      } | null;
      const row = detail?.fulfillments.find(
        (item) => item.id === fulfillmentId,
      );
      if (
        !row ||
        row.id !== fulfillmentId ||
        row.order_id !== orderId ||
        !Number.isSafeInteger(row.version) ||
        row.version < 1
      )
        throw new Error("Fulfillment not found on this order.");
      fulfillment = row;
      carrier = row.carrier;
      trackingNumber = row.tracking_number;
      trackingUrl = row.tracking_url ?? "";
      pending = saved;
      ready = true;
    } catch (cause) {
      if (alive) error = message(cause);
    } finally {
      if (alive) busy = false;
    }
  }

  function safeTrackingUrl(value: string | null) {
    if (!value) return null;
    try {
      const url = new URL(value);
      return url.protocol === "https:" || url.protocol === "http:"
        ? url.href
        : null;
    } catch {
      return null;
    }
  }

  async function submit(status?: "delivered" | "cancelled") {
    if (!fulfillment || busy || disabled || !ready) return;
    const changes: FulfillmentUpdateCommand["changes"] = {
      ...(status ? { status } : {}),
      ...(carrier !== fulfillment.carrier ? { carrier } : {}),
      ...(trackingNumber !== fulfillment.tracking_number
        ? { tracking_number: trackingNumber }
        : {}),
      ...(trackingUrl !== (fulfillment.tracking_url ?? "")
        ? { tracking_url: trackingUrl || null }
        : {}),
    };
    if (!pending && Object.keys(changes).length === 0) return;
    const warning = pending
      ? "Retry the SAME saved fulfillment update? The original version and changes will be used."
      : status === "cancelled"
        ? "Cancel this shipment? Cancellation does not refund the customer or restock inventory. The database will reject illegal state changes."
        : status === "delivered"
          ? "Mark this shipped shipment delivered? The database will reject illegal state changes."
          : "Save these carrier and tracking changes?";
    if (!window.confirm(warning)) return;
    busy = true;
    onBusyChange?.(true);
    error = "";
    notice = "";
    try {
      const command: FulfillmentUpdateCommand = pending ?? {
        fulfillment_id: fulfillment.id,
        expected_version: fulfillment.version,
        changes,
        idempotency_key: crypto.randomUUID(),
      };
      pending = command;
      await dispatchCommand(
        sessionStorage,
        key,
        command,
        (args) => supabase.rpc("update_fulfillment", args),
        (data) => {
          const row = data as Partial<Fulfillment> | null;
          return (
            !!row &&
            row.id === fulfillmentId &&
            row.order_id === orderId &&
            Number.isSafeInteger(row.version) &&
            Number(row.version) >= command.expected_version
          );
        },
      );
      if (!alive) return;
      pending = null;
      notice = "Fulfillment update confirmed.";
      await onSaved();
      await load();
    } catch (cause) {
      if (alive) {
        try {
          pending = readCommand(
            sessionStorage,
            key,
            isFulfillmentUpdateCommand,
          );
          if (!pending) ready = false;
        } catch {
          ready = false;
        }
        error = `${message(cause)} ${pending ? "The update may already have succeeded. Retry only the saved request." : "Reload current fulfillment facts before trying again."}`;
      }
    } finally {
      onBusyChange?.(false);
      if (alive) busy = false;
    }
  }
</script>

<svelte:window
  onbeforeunload={(event) => {
    if (busy || dirty) event.preventDefault();
  }}
/>
<div class="actions form-action">
  <button
    type="button"
    disabled={busy || disabled}
    onclick={() => {
      if (
        !dirty ||
        window.confirm(
          "Discard tracking edits and reload current shipment facts?",
        )
      )
        void load();
    }}>Reload shipment</button
  >
  {#if fulfillment}<span class="small muted"
      >Version {fulfillment.version} · {fulfillment.status}</span
    >{/if}
</div>
{#if error}<p class="notice error" role="alert">{error}</p>{/if}
{#if notice}<p class="notice" role="status">{notice}</p>{/if}
{#if pending}
  <div class="notice" role="status">
    <strong>Fulfillment update unresolved</strong>
    <p class="small break-word">
      Request {pending.idempotency_key}, based on version {pending.expected_version},
      is retained. Reloading will not replace its arguments.
    </p>
    <button disabled={busy || disabled || !ready} onclick={() => submit()}
      >Retry saved update</button
    >
  </div>
{:else if fulfillment}
  {#if safeTrackingUrl(fulfillment.tracking_url)}
    <p class="small">
      <a href={safeTrackingUrl(fulfillment.tracking_url)!} rel="noreferrer"
        >Open tracking page</a
      >
    </p>
  {/if}
  <form
    onsubmit={(event) => {
      event.preventDefault();
      void submit();
    }}
  >
    <fieldset disabled={busy || disabled || !ready}>
      <div class="fields two">
        <label>Carrier<input maxlength="200" bind:value={carrier} /></label>
        <label
          >Tracking number<input
            maxlength="200"
            bind:value={trackingNumber}
          /></label
        >
      </div>
      <label
        >Tracking URL<input
          maxlength="2000"
          type="url"
          bind:value={trackingUrl}
        /></label
      >
      <div class="actions form-action">
        <button disabled={!dirty}>Save tracking</button>
        {#if fulfillment.status === "shipped"}
          <button type="button" onclick={() => submit("delivered")}
            >Mark delivered</button
          >
          <button type="button" onclick={() => submit("cancelled")}
            >Cancel shipment</button
          >
        {/if}
      </div>
      <p class="small muted">
        Cancelling a shipment does not refund payment or restock inventory.
        Shipment contents and quantities cannot be edited.
      </p>
    </fieldset>
  </form>
{:else if busy}<p class="small muted">Loading fulfillment…</p>{/if}
