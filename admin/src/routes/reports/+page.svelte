<script lang="ts">
  import { supabase, message } from "$lib/api";
  import { reportRange } from "$lib/reporting";
  import {
    paymentSummary,
    orderSummary,
    orderExport,
    operationsSummary,
  } from "../../../../mcp/src/schemas";
  let start = $state(new Date(Date.now() - 86400_000).toISOString()),
    end = $state(new Date().toISOString());
  let mode = $state("orders"),
    component = $state("outbox"),
    busy = $state(false),
    error = $state("");
  let summary = $state<Record<string, unknown> | null>(null);
  let exported = $state<typeof orderExport._output | null>(null);
  let applied = $state<{ start_at: string; end_at: string } | null>(null);
  async function load(more = false) {
    if (busy) return;
    busy = true;
    error = "";
    try {
      const range = more && applied ? applied : reportRange(start, end);
      if (!more) {
        summary = null;
        exported = null;
        applied = range;
      }
      if (mode === "export") {
        const r = await supabase.rpc("export_admin_orders", {
          ...range,
          page_size: 100,
          ...(more && exported?.next_cursor
            ? { after_id: exported.next_cursor }
            : {}),
        });
        if (r.error) throw r.error;
        const data = orderExport.parse(r.data);
        exported = {
          ...data,
          items:
            more && exported
              ? [
                  ...exported.items,
                  ...data.items.filter(
                    (x) => !exported!.items.some((old) => old.id === x.id),
                  ),
                ]
              : data.items,
        };
      } else if (mode === "payments") {
        const r = await supabase.rpc("get_admin_payment_summary", range);
        if (r.error) throw r.error;
        summary = paymentSummary.parse(r.data);
      } else if (mode === "operations") {
        const r = await supabase.rpc("get_admin_operations_summary", {
          ...range,
          component,
        });
        if (r.error) throw r.error;
        summary = operationsSummary.parse(r.data);
      } else {
        const r = await supabase.rpc("get_admin_order_summary", range);
        if (r.error) throw r.error;
        summary = orderSummary.parse(r.data);
      }
    } catch (e) {
      error = message(e);
    } finally {
      busy = false;
    }
  }
  function download() {
    if (
      !exported ||
      !confirm(
        `Download ${exported.items.length} loaded order rows? IDs remain linkable private data. This exports only loaded pages, not a frozen snapshot.`,
      )
    )
      return;
    const url = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify(
            {
              ...exported,
              start_at: applied!.start_at,
              end_at: applied!.end_at,
            },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      ),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "orders.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
</script>

<svelte:head><title>Reports · Tera Admin</title></svelte:head>
<div class="page-heading">
  <div>
    <h1>Reports & export</h1>
    <p class="small muted">
      Explicit time ranges, bounded reads and original decimal strings.
    </p>
  </div>
</div>
<form
  class="card fields"
  onsubmit={(e) => {
    e.preventDefault();
    void load();
  }}
>
  <fieldset disabled={busy} class="fields">
    <label
      >Report<select
        bind:value={mode}
        onchange={() => {
          summary = null;
          exported = null;
        }}
        ><option value="orders">Orders</option><option value="payments"
          >Payment ledger</option
        ><option value="operations">Operations</option><option value="export"
          >Order export</option
        ></select
      ></label
    >
    {#if mode === "operations"}<label
        >Component<select bind:value={component}
          ><option>outbox</option><option>inbox</option><option
            >reconciliation</option
          ></select
        ></label
      >{/if}
    <label
      >Start (inclusive, ISO with timezone)<input
        required
        bind:value={start}
      /></label
    ><label
      >End (exclusive, ISO with timezone)<input
        required
        bind:value={end}
      /></label
    ><button class="primary">Run report</button>
  </fieldset>
</form>
<p class="notice">
  Maximum range: 744 hours and 10,000 matching records. Narrow the range on
  limit errors. Orders use creation time and current statuses; totals are
  original order amounts, not net revenue. Payments include succeeded ledger
  captures/refunds and manual bookkeeping, not bank settlement. Operations show
  unresolved records created in the range; older backlog is excluded. Separate
  calls and export pages are not a shared snapshot.
</p>
{#if error}<p class="notice error" role="alert">{error}</p>{/if}
{#if summary}<section class="card">
    <h2>Report result</h2>
    <dl>
      {#each Object.entries(summary) as [key, value]}<dt>
          {key.replaceAll("_", " ")}
        </dt>
        <dd>
          {typeof value === "object" && value !== null
            ? Object.entries(value)
                .map(([k, v]) => `${k}: ${v}`)
                .join(" · ")
            : value === null
              ? "Not applicable"
              : String(value)}
        </dd>{/each}
    </dl>
  </section>{/if}
{#if exported}<section class="card">
    <h2>Loaded order export · {exported.items.length} rows</h2>
    <p>
      Range: {applied?.start_at} → {applied?.end_at}. Changing the inputs does
      not change loaded pages until you run a new report.
    </p>
    <div class="table-wrap">
      <table>
        <thead
          ><tr
            ><th>Order</th><th>Status</th><th>Financial</th><th>Total USD</th
            ><th>Created</th></tr
          ></thead
        ><tbody
          >{#each exported.items as row}<tr
              ><td><a href={`/orders/${row.id}`}>{row.order_number}</a></td><td
                >{row.status}</td
              ><td>{row.financial_status}</td><td>{row.total}</td><td
                >{row.created_at}</td
              ></tr
            >{/each}</tbody
        >
      </table>
    </div>
    <div class="actions">
      {#if exported.next_cursor}<button
          disabled={busy}
          onclick={() => load(true)}>Load next export page</button
        >{/if}<button disabled={busy} onclick={download}
        >Download loaded JSON</button
      >
    </div>
  </section>{/if}
