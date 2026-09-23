<script lang="ts">
  import { onMount } from "svelte";
  import { supabase, message } from "./api";
  interface Target {
    id: string;
    role: string;
    product_id: string | null;
    category_id: string | null;
    variant_id: string | null;
  }
  interface Redemption {
    id: string;
    customer_id: string;
    order_id: string | null;
    created_at: string;
  }
  let {
    id,
    kind,
    role,
  }: { id: string; kind: "targets" | "redemptions"; role: string } = $props();
  let items = $state<(Target | Redemption)[]>([]);
  let cursor = $state<string | null>(null);
  let busy = $state(false),
    error = $state("");
  let alive = true;
  onMount(() => {
    void load();
    return () => {
      alive = false;
    };
  });
  async function load() {
    if (busy) return;
    busy = true;
    error = "";
    try {
      const args = {
        promotion_id: id,
        page_size: 20,
        ...(cursor ? { after_id: cursor } : {}),
      };
      const result =
        kind === "targets"
          ? await supabase.rpc("list_admin_promotion_targets", {
              ...args,
              ...(role ? { role_filter: role } : {}),
            })
          : await supabase.rpc("list_admin_discount_redemptions", args);
      if (result.error) throw result.error;
      if (!alive) return;
      const data = result.data as unknown as {
        items: (Target | Redemption)[];
        next_cursor: string | null;
      };
      items = [
        ...items,
        ...data.items.filter(
          (item) => !items.some((old) => old.id === item.id),
        ),
      ];
      cursor = data.next_cursor;
    } catch (cause) {
      if (alive) error = message(cause);
    } finally {
      if (alive) busy = false;
    }
  }
</script>

{#if error}<p class="notice error" role="alert">{error}</p>
  <button onclick={load} disabled={busy}>Retry records</button>{/if}
<div class="table-wrap">
  <table>
    <thead
      >{#if kind === "targets"}<tr
          ><th>Role</th><th>Reference type</th><th>Reference ID</th></tr
        >{:else}<tr><th>Customer</th><th>Order</th><th>Created at</th></tr
        >{/if}</thead
    >
    <tbody
      >{#each items as item (item.id)}<tr>
          {#if "role" in item}<td>{item.role}</td><td
              >{item.product_id
                ? "Product"
                : item.category_id
                  ? "Category"
                  : "Variant"}</td
            ><td>{item.product_id ?? item.category_id ?? item.variant_id}</td>
          {:else}<td
              ><a href={`/customers/${item.customer_id}`}>{item.customer_id}</a
              ></td
            ><td
              >{#if item.order_id}<a href={`/orders/${item.order_id}`}
                  >{item.order_id}</a
                >{:else}—{/if}</td
            ><td>{item.created_at}</td>{/if}
        </tr>{/each}</tbody
    >
  </table>
</div>
{#if busy}<p role="status">
    Loading records…
  </p>{:else if !items.length && !error}<p class="muted">
    No {kind} found.
  </p>{/if}
{#if cursor}<button onclick={load} disabled={busy}>More records</button>{/if}
