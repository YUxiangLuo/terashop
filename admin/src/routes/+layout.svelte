<script lang="ts">
  import { onMount, type Snippet } from "svelte";
  import { page } from "$app/state";
  import type { Session } from "@supabase/supabase-js";
  import { supabase, message } from "$lib/api";
  import "../app.css";

  let { children }: { children: Snippet } = $props();
  let phase = $state<"checking" | "signed-out" | "admin" | "denied" | "error">(
    "checking",
  );
  let userId = $state("");
  let account = $state("");
  let email = $state("");
  let password = $state("");
  let busy = $state(false);
  let error = $state("");
  let generation = 0;
  let mounted = false;

  async function verify(session: Session | null) {
    const current = ++generation;
    if (!session) {
      userId = "";
      account = "";
      phase = "signed-out";
      return;
    }
    if (userId !== session.user.id) phase = "checking";
    try {
      const result = await supabase.rpc("is_admin");
      if (!mounted || current !== generation) return;
      if (result.error) throw result.error;
      userId = session.user.id;
      account = session.user.email ?? "Administrator";
      phase = result.data === true ? "admin" : "denied";
    } catch (cause) {
      if (mounted && current === generation) {
        phase = "error";
        error = message(cause);
      }
    }
  }
  onMount(() => {
    mounted = true;
    // Do not await Supabase calls within its auth callback (the SDK holds an auth lock).
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setTimeout(() => {
        if (mounted) void verify(session);
      }, 0);
    });
    return () => {
      mounted = false;
      generation++;
      data.subscription.unsubscribe();
    };
  });
  async function refresh() {
    if (!mounted) return;
    const { data, error: sessionError } = await supabase.auth.getSession();
    if (sessionError) {
      phase = "error";
      error = message(sessionError);
      return;
    }
    await verify(data.session);
  }
  async function login(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    error = "";
    try {
      const result = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (result.error) throw result.error;
      password = "";
    } catch (cause) {
      error = message(cause);
    } finally {
      busy = false;
    }
  }
  async function logout() {
    busy = true;
    error = "";
    const { error: signoutError } = await supabase.auth.signOut({
      scope: "local",
    });
    if (signoutError) error = message(signoutError);
    else {
      generation++;
      phase = "signed-out";
      userId = "";
      account = "";
    }
    busy = false;
  }
</script>

<svelte:window onfocus={refresh} />
<svelte:head><title>Tera Admin</title></svelte:head>

{#if phase === "admin"}
  <div class="workspace">
    <aside class="sidebar" aria-label="Store navigation">
      <a class="brand" href="/">tera<span>ADMIN</span></a>
      <p class="eyebrow">Store management</p>
      <nav aria-label="Main navigation">
        <a
          class:nav-active={page.url.pathname === "/" ||
            page.url.pathname.startsWith("/products/")}
          aria-current={page.url.pathname === "/" ||
          page.url.pathname.startsWith("/products/")
            ? "page"
            : undefined}
          href="/">▦ <span>Products</span></a
        >
        <a
          class:nav-active={page.url.pathname.startsWith("/categories")}
          aria-current={page.url.pathname.startsWith("/categories")
            ? "page"
            : undefined}
          href="/categories">◇ <span>Categories</span></a
        >
        <a
          class:nav-active={page.url.pathname.startsWith("/inventory")}
          aria-current={page.url.pathname.startsWith("/inventory")
            ? "page"
            : undefined}
          href="/inventory">▧ <span>Inventory</span></a
        >
        <a
          class:nav-active={page.url.pathname.startsWith("/locations")}
          aria-current={page.url.pathname.startsWith("/locations")
            ? "page"
            : undefined}
          href="/locations">⌂ <span>Warehouses</span></a
        >
        <a
          class:nav-active={page.url.pathname.startsWith("/shipping")}
          aria-current={page.url.pathname.startsWith("/shipping")
            ? "page"
            : undefined}
          href="/shipping">↗ <span>Shipping</span></a
        >
        <a
          class:nav-active={page.url.pathname.startsWith("/taxes")}
          aria-current={page.url.pathname.startsWith("/taxes")
            ? "page"
            : undefined}
          href="/taxes">% <span>Taxes</span></a
        >
        <a
          class:nav-active={page.url.pathname.startsWith("/promotions")}
          aria-current={page.url.pathname.startsWith("/promotions")
            ? "page"
            : undefined}
          href="/promotions">◇ <span>Promotions</span></a
        >
        <a
          class:nav-active={page.url.pathname.startsWith("/orders")}
          aria-current={page.url.pathname.startsWith("/orders")
            ? "page"
            : undefined}
          href="/orders">▤ <span>Orders</span></a
        >
        <a
          class:nav-active={page.url.pathname.startsWith("/quotes")}
          aria-current={page.url.pathname.startsWith("/quotes")
            ? "page"
            : undefined}
          href="/quotes">▤ <span>Checkout quotes</span></a
        >
        <a
          class:nav-active={page.url.pathname.startsWith("/reconciliation")}
          aria-current={page.url.pathname.startsWith("/reconciliation")
            ? "page"
            : undefined}
          href="/reconciliation">≍ <span>Reconciliation</span></a
        >
        <a
          class:nav-active={page.url.pathname.startsWith("/customers")}
          aria-current={page.url.pathname.startsWith("/customers")
            ? "page"
            : undefined}
          href="/customers">♧ <span>Customers</span></a
        >
      </nav>
      <div class="sidebar-note">
        Products, stock and shipments.<br /><small>Single store · USD</small>
      </div>
    </aside>
    <div class="content">
      <header class="topbar">
        <span>Store workspace</span>
        <div>
          <span class="account">{account}</span><button
            class="quiet"
            onclick={logout}
            disabled={busy}>Sign out</button
          >
        </div>
      </header>
      {#if error}<p class="notice error" role="alert">{error}</p>{/if}
      <main id="main">
        {#key userId}{@render children()}{/key}
      </main>
    </div>
  </div>
{:else}
  <main class="auth-page">
    <div class="auth-brand">
      <span class="brand">tera<span>ADMIN</span></span>
      <p>A considered space for your store.</p>
    </div>
    <section class="auth-card">
      {#if phase === "checking"}
        <h1>Opening your workspace</h1>
        <p role="status">Checking your administrator access…</p>
      {:else if phase === "signed-out"}
        <p class="eyebrow">Welcome back</p>
        <h1>Sign in to your store</h1>
        <p class="muted">
          Use your administrator account to manage your store.
        </p>
        <form onsubmit={login}>
          <label
            >Email<input
              type="email"
              autocomplete="username"
              bind:value={email}
              required
            /></label
          >
          <label
            >Password<input
              type="password"
              autocomplete="current-password"
              bind:value={password}
              required
            /></label
          >
          {#if error}<p class="notice error" role="alert">{error}</p>{/if}
          <button class="primary" disabled={busy}
            >{busy ? "Signing in…" : "Sign in"}</button
          >
        </form>
        <p class="small muted">
          Access is assigned by your store operator. There is no public
          administrator registration.
        </p>
      {:else}
        <p class="eyebrow">Restricted workspace</p>
        <h1>
          {phase === "denied"
            ? "Administrator access required"
            : "Unable to verify access"}
        </h1>
        <p role="alert">
          {phase === "denied"
            ? "This account does not have permission to manage the store."
            : error}
        </p>
        <div class="actions">
          <button onclick={refresh}>Check again</button><button
            onclick={logout}
            disabled={busy}>Sign out</button
          >
        </div>
      {/if}
    </section>
  </main>
{/if}
