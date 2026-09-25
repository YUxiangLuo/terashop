<script lang="ts">
  import { onMount } from "svelte";
  import { supabase, message, dateTime } from "$lib/api";
  import { userPage, type AdminUser } from "$lib/users";
  let email = $state("");
  let role = $state("");
  let items = $state.raw<AdminUser[]>([]);
  let cursor = $state<string | null>(null);
  let busy = $state(false);
  let error = $state("");
  let applied = { email: "", role: "" };
  async function load(more = false) {
    if (busy) return;
    busy = true;
    error = "";
    if (!more) {
      applied = { email: email.trim(), role };
      items = [];
      cursor = null;
    }
    try {
      const { data, error: e } = await supabase.rpc("list_admin_users", {
        page_size: 50,
        search: applied.email,
        ...(applied.role ? { role_filter: applied.role } : {}),
        ...(more && cursor ? { after_id: cursor } : {}),
      });
      if (e) throw e;
      const p = userPage(data);
      items = more
        ? [
            ...items,
            ...p.items.filter(
              (x) => !items.some((y) => y.user_id === x.user_id),
            ),
          ]
        : p.items;
      cursor = p.next_cursor;
    } catch (e) {
      error = message(e);
    } finally {
      busy = false;
    }
  }
  function apply(e: SubmitEvent) {
    e.preventDefault();
    items = [];
    cursor = null;
    void load();
  }
  onMount(() => {
    void load();
  });
</script>

<svelte:head><title>Users · Tera Admin</title></svelte:head>
<div class="page-heading">
  <div>
    <p class="eyebrow">Access and privacy</p>
    <h1>Users</h1>
  </div>
  <button onclick={() => load()} disabled={busy}>Refresh</button>
</div>
<section class="card">
  <form class="toolbar" onsubmit={apply}>
    <label
      >Email contains<input
        type="search"
        maxlength="200"
        bind:value={email}
      /></label
    ><label
      >Role<select bind:value={role}
        ><option value="">All roles</option><option value="admin">Admin</option
        ><option value="customer">Customer</option></select
      ></label
    ><button disabled={busy}>Apply filters</button>
  </form>
  <p class="small muted">
    Profile email is private and does not prove login, verification, or Auth
    account status.
  </p>
  {#if error}<p class="notice error" role="alert">{error}</p>{/if}
  <div class="table-wrap">
    <table>
      <thead
        ><tr><th>Email</th><th>Role</th><th>Customer</th><th>Created</th></tr
        ></thead
      ><tbody
        >{#each items as user (user.user_id)}<tr
            ><td
              ><a class="record-link" href={`/users/${user.user_id}`}
                >{user.email}</a
              ><small class="cell-detail break-word">{user.user_id}</small></td
            ><td>{user.role}</td><td>{user.customer_id ?? "Not linked"}</td><td
              >{dateTime(user.created_at)}</td
            ></tr
          >{/each}</tbody
      >
    </table>
  </div>
  {#if busy}<p role="status">
      Loading users…
    </p>{:else if !items.length && !error}<p class="empty">
      No users found.
    </p>{/if}{#if cursor}<div class="list-footer">
      <span></span><button onclick={() => load(true)} disabled={busy}
        >Load more</button
      >
    </div>{/if}
</section>
