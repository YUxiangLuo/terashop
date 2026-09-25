<script lang="ts">
  import { onMount } from "svelte";
  import { beforeNavigate } from "$app/navigation";
  import { supabase, message } from "$lib/api";
  import { shopSettings } from "../../../../mcp/src/schemas";
  let saved = $state<typeof shopSettings._output | null>(null);
  let name = $state(""),
    timezone = $state("UTC"),
    busy = $state(false),
    uncertain = $state(false),
    error = $state(""),
    notice = $state("");
  let dirty = $derived(
    !!saved && (name !== saved.name || timezone !== saved.timezone),
  );
  beforeNavigate(({ cancel }) => {
    if (busy || (dirty && !confirm("Discard unsaved shop settings?"))) cancel();
  });
  onMount(() => {
    void load();
  });
  async function load() {
    if (
      busy ||
      (dirty && !confirm("Discard local settings and read current values?"))
    )
      return;
    busy = true;
    error = "";
    try {
      const r = await supabase.rpc("get_admin_shop_settings");
      if (r.error) throw r.error;
      saved = shopSettings.parse(r.data);
      name = saved.name;
      timezone = saved.timezone;
      uncertain = false;
    } catch (e) {
      error = message(e);
      uncertain = true;
    } finally {
      busy = false;
    }
  }
  async function save(e: SubmitEvent) {
    e.preventDefault();
    if (busy || uncertain || !saved || !dirty) return;
    busy = true;
    error = "";
    notice = "";
    try {
      const r = await supabase.rpc("update_shop_settings", {
        expected_revision: saved.revision,
        changes: { name, timezone },
      });
      if (r.error) throw r.error;
      const next = shopSettings.parse(r.data);
      if (
        next.revision <= saved.revision ||
        next.name !== name ||
        next.timezone !== timezone
      )
        throw Error("Unconfirmed settings receipt. Reload current values.");
      saved = next;
      notice = "Shop settings saved.";
    } catch (e) {
      error = message(e);
      uncertain = true;
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>Shop settings · Tera Admin</title></svelte:head>
<svelte:window
  onbeforeunload={(e) => {
    if (dirty || busy) e.preventDefault();
  }}
/>
<div class="page-heading">
  <div>
    <h1>Shop settings</h1>
    <p class="small muted">
      Presentation configuration, not payment, authentication or infrastructure
      settings.
    </p>
  </div>
  <button onclick={load} disabled={busy}>Reload settings</button>
</div>
{#if error}<p class="notice error" role="alert">
    {error} Reload before another write.
  </p>{/if}
{#if notice}<p class="notice" role="status">{notice}</p>{/if}
<form onsubmit={save}>
  <fieldset disabled={busy || uncertain || !saved}>
    <section class="card fields">
      <label
        >Shop name<input required maxlength="200" bind:value={name} /></label
      >
      <label
        >Presentation timezone<input
          required
          maxlength="100"
          bind:value={timezone}
          placeholder="Asia/Shanghai"
        /></label
      >
      <p>
        Currency: USD (fixed). Name and timezone do not currently change the
        static storefront, checkout currency, historical timestamps or report
        time ranges.
      </p>
      <button class="primary" disabled={!dirty}>Save settings</button>
    </section>
  </fieldset>
</form>
