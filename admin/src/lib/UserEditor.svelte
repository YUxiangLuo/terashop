<script lang="ts">
  import { onMount } from "svelte";
  import { message, dateTime, supabase } from "$lib/api";
  import {
    getUser,
    setRole,
    anonymizeUser,
    type AdminUser,
    type UserRole,
  } from "$lib/users";
  let { id }: { id: string } = $props();
  let user = $state.raw<AdminUser | null>(null);
  let self = $state("");
  let busy = $state(false);
  let uncertain = $state(false);
  let error = $state("");
  let notice = $state("");
  let targetRole = $state<UserRole>("customer");
  let confirmation = $state("");
  let privacyConfirmation = $state("");
  onMount(() => {
    void supabase.auth.getUser().then((x) => (self = x.data.user?.id ?? ""));
    void load();
  });
  async function load() {
    busy = true;
    error = "";
    notice = "";
    try {
      const v = await getUser(id);
      if (!v) throw Error("User not found.");
      user = v;
      targetRole = v.role;
      confirmation = "";
      privacyConfirmation = "";
      uncertain = false;
    } catch (e) {
      error = message(e);
      uncertain = true;
    } finally {
      busy = false;
    }
  }
  async function role() {
    if (
      !user ||
      confirmation !== `${user.user_id} ${targetRole}` ||
      targetRole === user.role
    )
      return;
    if (
      self === id &&
      targetRole === "customer" &&
      !confirm(
        "This is your own account. Demoting it will immediately remove admin access. Continue?",
      )
    )
      return;
    await mutate(
      () => setRole(id, targetRole),
      "Role changed. Reload this original user before another mutation.",
    );
    if (self === id) window.dispatchEvent(new Event("focus"));
  }
  async function privacy() {
    if (!user || privacyConfirmation !== `ANONYMIZE ${user.user_id}`) return;
    if (
      !confirm(
        "Irreversibly anonymize this profile, linked customer, and audit actor? Historical orders and Auth credentials remain.",
      )
    )
      return;
    await mutate(
      () => anonymizeUser(id),
      "Anonymization submitted. Auth credentials were not deleted. Reload this original user to verify.",
    );
  }
  async function mutate(fn: () => Promise<unknown>, ok: string) {
    if (busy || uncertain) return;
    busy = true;
    error = "";
    try {
      await fn();
      uncertain = true;
      notice = ok;
    } catch (e) {
      uncertain = true;
      error = `${message(e)} The outcome may be unknown. Reload the original user ID; do not retry automatically.`;
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>User · Tera Admin</title></svelte:head>
<div class="page-heading">
  <div>
    <a href="/users">← Users</a>
    <h1>User profile</h1>
  </div>
  <button onclick={load} disabled={busy}>Reload original user</button>
</div>
{#if error}<p class="notice error" role="alert">{error}</p>{/if}{#if notice}<p
    class="notice"
    role="status"
  >
    {notice}
  </p>{/if}
{#if user}<div class="editor-grid">
    <section class="card fields">
      <h2>Current profile</h2>
      <p class="break-word"><strong>Email</strong> {user.email}</p>
      <p><strong>Role</strong> {user.role}</p>
      <p class="break-word"><strong>Auth user ID</strong> {user.user_id}</p>
      <p><strong>Created</strong> {dateTime(user.created_at)}</p>
      {#if user.customer_id}<p>
          <a href={`/customers/${user.customer_id}`}>Open linked customer</a
          >{user.customer_anonymized_at
            ? ` · anonymized ${dateTime(user.customer_anonymized_at)}`
            : ""}
        </p>{:else}<p>
          No linked customer. This does not prove Auth deletion.
        </p>{/if}
    </section>
    <section class="card fields">
      <h2>Role</h2>
      <select bind:value={targetRole} disabled={busy || uncertain}
        ><option value="admin">Admin</option><option value="customer"
          >Customer</option
        ></select
      ><label
        >Type <code>{user.user_id} {targetRole}</code><input
          bind:value={confirmation}
          autocomplete="off"
        /></label
      ><button
        onclick={role}
        disabled={busy ||
          uncertain ||
          targetRole === user.role ||
          confirmation !== `${user.user_id} ${targetRole}`}
        >Set exact role</button
      >
      <p class="small muted">
        The final admin cannot be demoted. Self-demotion removes this session's
        admin access.
      </p>
      <h2>Privacy</h2>
      <p>
        This is irreversible but does not delete or revoke Auth credentials.
        Historical order snapshots remain.
      </p>
      <label
        >Type <code>ANONYMIZE {user.user_id}</code><input
          bind:value={privacyConfirmation}
          autocomplete="off"
        /></label
      ><button
        onclick={privacy}
        disabled={busy ||
          uncertain ||
          privacyConfirmation !== `ANONYMIZE ${user.user_id}`}
        >Anonymize user</button
      >
    </section>
  </div>{:else if busy}<p>Loading user…</p>{/if}
