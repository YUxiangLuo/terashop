<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { beforeNavigate } from "$app/navigation";
  import { onMount } from "svelte";
  import { message } from "./api";
  import { createCustomer, getCustomerCreationResult } from "./customers";
  import { customerCreateArguments } from "./customer-draft";
  let fields = $state({ full_name: "", email: "", phone: "" });
  let busy = $state(false);
  let completed = $state(false);
  let uncertain = $state(false);
  let error = $state("");
  let key = $state(page.url.searchParams.get("request") ?? "");
  // A reopened URL retains identity, not the original private request body.
  const recovering = Boolean(page.url.searchParams.get("request"));
  let recoveryMessage = $state("Checking the original creation result…");
  let submitted = $state.raw<{
    email?: string;
    full_name?: string;
    phone?: string;
  } | null>(null);
  let unsettled = $derived(
    !completed &&
      (busy || submitted !== null || Object.values(fields).some(Boolean)),
  );
  onMount(() => {
    if (recovering) {
      void recover();
      return;
    }
    key = crypto.randomUUID();
    const url = new URL(page.url);
    url.searchParams.set("request", key);
    void goto(`${url.pathname}${url.search}`, {
      replaceState: true,
      noScroll: true,
    });
  });
  beforeNavigate(({ cancel }) => {
    if (
      unsettled &&
      !window.confirm(
        uncertain
          ? "Creation may have succeeded. Leave and lose the original request recovery context?"
          : "Leave and discard this customer draft?",
      )
    )
      cancel();
  });
  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (recovering || busy || !key) return;
    busy = true;
    error = "";
    try {
      // The request UUID lives in the URL, while contact details remain only in memory.
      submitted ??= customerCreateArguments(fields);
      // Unknown-result retries must replay the exact in-memory arguments. PII is
      // never persisted in the URL or browser storage.
      const customer = await createCustomer(key, submitted);
      fields = { full_name: "", email: "", phone: "" };
      completed = true;
      await goto(`/customers/${customer.id}`, { replaceState: true });
    } catch (cause) {
      uncertain = true;
      error = `${message(cause)} Retry will use the original submitted details and request ID; do not start another customer.`;
    } finally {
      busy = false;
    }
  }

  async function recover() {
    if (busy) return;
    busy = true;
    error = "";
    try {
      const id = await getCustomerCreationResult(key);
      if (id) {
        completed = true;
        await goto(`/customers/${id}`, { replaceState: true });
      } else {
        recoveryMessage =
          "No committed customer was found yet. The original request may still be running. Check again before starting another customer.";
      }
    } catch (cause) {
      error = message(cause);
      recoveryMessage =
        "The original creation result could not be checked. Check again; do not submit another customer.";
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>New customer · Tera Admin</title></svelte:head>
<svelte:window
  onbeforeunload={(event) => {
    if (unsettled) event.preventDefault();
  }}
/>
<div class="page-heading">
  <div>
    <a class="small" href="/customers">← Customers</a>
    <h1>New customer</h1>
    <p class="small muted">
      Creates an offline store record, not a sign-in account.
    </p>
  </div>
</div>
{#if error}<p class="notice error" role="alert">{error}</p>{/if}
{#if recovering}
  <section class="card" aria-label="Customer creation recovery">
    <h2>Recover customer creation</h2>
    <p>
      Contact details were kept only in memory and are no longer available. This
      request cannot be resubmitted with different details.
    </p>
    <p role="status">{recoveryMessage}</p>
    <button class="primary" disabled={busy} onclick={recover}
      >Check creation result</button
    >
  </section>
{:else}
  <form class="card" onsubmit={save}>
    <h2>Contact</h2>
    <label
      >Full name<input
        bind:value={fields.full_name}
        disabled={busy || uncertain}
      /></label
    >
    <label
      >Email<input
        type="email"
        bind:value={fields.email}
        disabled={busy || uncertain}
      /></label
    >
    <label
      >Phone<input
        type="tel"
        bind:value={fields.phone}
        disabled={busy || uncertain}
      /></label
    >
    <div class="actions form-action">
      <button class="primary" disabled={busy || !key}
        >{uncertain ? "Retry customer creation" : "Create customer"}</button
      >
    </div>
  </form>
{/if}
