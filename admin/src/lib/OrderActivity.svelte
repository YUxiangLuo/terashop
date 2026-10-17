<script lang="ts">
  import { onMount } from "svelte";
  import { supabase, message, dateTime } from "./api";
  let { orderId }: { orderId: string } = $props();
  type Kind = "events" | "payment_intent" | "refund_request" | "money_movement";
  type Row = {
    id: string;
    order_id: string;
    created_at: string;
    type?: string;
    actor_id?: string | null;
    amount?: string;
    currency?: string;
    provider?: string;
    status?: string;
    kind?: string;
    reconciliation_status?: string;
    has_error?: boolean;
    restock_requested?: boolean;
    source?: string;
    expires_at?: string;
    provider_capture_requested_at?: string | null;
    last_provider_poll_at?: string | null;
    provider_poll_attempts?: number;
    updated_at?: string;
    parent_transaction_id?: string;
    result_refund_id?: string | null;
    submitted_at?: string | null;
    processed_at?: string | null;
    provider_refund_requested_at?: string | null;
    provider_event_id?: string;
    payment_intent_id?: string | null;
    refund_request_id?: string | null;
    payment_transaction_id?: string | null;
    matched_at?: string | null;
  };
  // Only documented, redacted DTO fields are rendered. Never dump arbitrary JSON.
  const detailFields: Record<Exclude<Kind, "events">, (keyof Row)[]> = {
    payment_intent: [
      "expires_at",
      "provider_capture_requested_at",
      "last_provider_poll_at",
      "provider_poll_attempts",
      "updated_at",
    ],
    refund_request: [
      "source",
      "parent_transaction_id",
      "result_refund_id",
      "submitted_at",
      "processed_at",
      "provider_refund_requested_at",
      "last_provider_poll_at",
      "provider_poll_attempts",
      "updated_at",
    ],
    money_movement: [
      "provider_event_id",
      "payment_intent_id",
      "refund_request_id",
      "payment_transaction_id",
      "matched_at",
    ],
  };
  let kind = $state<Kind>("events");
  let typeFilter = $state("");
  let appliedType = "";
  let rows = $state<Row[]>([]);
  let cursor = $state<string | null>(null);
  let busy = $state(false);
  let error = $state("");
  let alive = true;
  onMount(() => {
    void load(false);
    return () => {
      alive = false;
    };
  });
  async function load(more: boolean) {
    if (busy) return;
    busy = true;
    error = "";
    if (!more) {
      rows = [];
      cursor = null;
      appliedType = typeFilter;
    }
    try {
      const args = {
        order_id: orderId,
        page_size: 20,
        ...(more && cursor ? { after_id: cursor } : {}),
      };
      const result =
        kind === "events"
          ? await supabase.rpc("list_admin_order_events", {
              ...args,
              ...(appliedType ? { type_filter: appliedType } : {}),
            })
          : await supabase.rpc("list_admin_payment_operations", {
              ...args,
              kind,
            });
      if (result.error) throw result.error;
      if (!alive) return;
      const data = result.data as unknown as {
        items: Row[];
        next_cursor: string | null;
      };
      rows = more
        ? [
            ...rows,
            ...data.items.filter(
              (item) => !rows.some((old) => old.id === item.id),
            ),
          ]
        : data.items;
      cursor = data.next_cursor;
    } catch (cause) {
      if (alive) error = message(cause);
    } finally {
      if (alive) busy = false;
    }
  }
</script>

<section class="card form-action" aria-label="Order activity">
  <div class="section-heading">
    <h2>Order activity & payments</h2>
    <button type="button" disabled={busy} onclick={() => load(false)}
      >Refresh activity</button
    >
  </div>
  <form
    class="toolbar"
    onsubmit={(event) => {
      event.preventDefault();
      void load(false);
    }}
  >
    <label
      >Record type<select
        disabled={busy}
        bind:value={kind}
        onchange={(event) => {
          kind = event.currentTarget.value as Kind;
          void load(false);
        }}
      >
        <option value="events">Order events</option><option
          value="payment_intent">Payment intents</option
        ><option value="refund_request">Refund requests</option><option
          value="money_movement">Provider money movements</option
        >
      </select></label
    >
    {#if kind === "events"}<label
        >Exact event type<input
          disabled={busy}
          maxlength="200"
          bind:value={typeFilter}
          placeholder="All event types"
        /></label
      ><button disabled={busy}>Filter events</button>{/if}
  </form>
  {#if kind === "events"}<p class="small muted">
      Newest event ID first, not transaction commit order. Type filtering is
      case-sensitive and preserves spaces. Events are not proof of payment;
      payloads and user profiles are not exposed.
    </p>
  {:else}<p class="small muted">
      Read-only provider records, in ID order (not chronological). Amounts
      retain their exact precision and currency. Manual ledger entries and
      unassigned provider movements are not included.
    </p>
    <p class="notice">
      A refund request is not a completed refund. A provider movement is not
      necessarily reconciled. Diagnostics do not imply final failure or
      permission to retry. Restock requested does not prove stock was returned.
    </p>{/if}
  {#if error}<p role="alert" class="notice error">{error}</p>
    <button type="button" disabled={busy} onclick={() => load(!!cursor)}
      >Retry activity read</button
    >{/if}
  <div
    class="table-wrap"
    role="region"
    aria-label="Activity records, scroll horizontally for all columns"
  >
    <table>
      <thead
        ><tr
          ><th scope="col">Created / ID</th><th scope="col"
            >{kind === "events" ? "Event type" : "Provider / status"}</th
          ><th scope="col"
            >{kind === "events" ? "Actor Auth ID" : "Exact amount"}</th
          >{#if kind !== "events"}<th scope="col">Details</th>{/if}</tr
        ></thead
      >
      <tbody
        >{#each rows as row (row.id)}<tr data-record-id={row.id}>
            <td
              >{dateTime(row.created_at)}<small class="cell-detail break-word"
                >{row.id}</small
              ></td
            >
            {#if kind === "events"}<td class="preserve-text break-word"
                >{row.type}</td
              ><td class="break-word">{row.actor_id ?? "Not recorded"}</td>
            {:else}<td
                >{row.provider}<small class="cell-detail"
                  >{kind === "money_movement"
                    ? `${row.kind} · ${row.reconciliation_status}`
                    : row.status}</small
                >
                {#if row.has_error}<small class="cell-detail"
                    >Diagnostics present (redacted)</small
                  >{/if}
                {#if kind === "refund_request"}<small class="cell-detail"
                    >Restock requested: {row.restock_requested
                      ? "Yes"
                      : "No"}</small
                  >{/if}
              </td><td class="numeric">{row.amount} {row.currency}</td>
              <td class="record-details"
                ><details>
                  <summary>Record details</summary>
                  <dl class="small">
                    {#each detailFields[kind] as field}<dt>
                        {field.replaceAll("_", " ")}
                      </dt>
                      <dd class="break-word">
                        {row[field] == null ? "—" : String(row[field])}
                      </dd>{/each}
                  </dl>
                </details></td
              >
            {/if}
          </tr>{/each}</tbody
      >
    </table>
  </div>
  {#if busy}<p role="status">
      Loading activity…
    </p>{:else if !rows.length && !error}<p class="empty">
      No records match this selection. This does not prove that no payment or
      refund occurred.
    </p>{/if}
  {#if cursor}<button
      type="button"
      class="form-action"
      disabled={busy}
      onclick={() => load(true)}>Load more activity</button
    >{/if}
</section>

<style>
  table {
    min-width: 760px;
  }
  td {
    vertical-align: top;
  }
  .numeric {
    white-space: nowrap;
  }
  .record-details {
    min-width: 210px;
  }
  dt {
    color: #626e63;
  }
  dd {
    margin: 0.2rem 0 0.7rem;
  }
</style>
