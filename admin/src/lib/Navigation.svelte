<script lang="ts">
  import { onMount, tick } from "svelte";
  import { afterNavigate } from "$app/navigation";
  import { page } from "$app/state";

  let { admin }: { admin: boolean } = $props();
  const groups = [
    {
      name: "Orders",
      href: "/orders",
      links: [
        ["Orders", "/orders"],
        ["Checkout quotes", "/quotes"],
      ],
    },
    {
      name: "Products",
      href: "/",
      links: [
        ["Products", "/"],
        ["Categories", "/categories"],
        ["Managed media", "/media"],
      ],
    },
    {
      name: "Inventory",
      href: "/inventory",
      links: [
        ["Stock", "/inventory"],
        ["Warehouses", "/locations"],
      ],
    },
    {
      name: "Customers",
      href: "/customers",
      links: [["Customers", "/customers"]],
    },
    {
      name: "Promotions",
      href: "/promotions",
      links: [["Promotions", "/promotions"]],
    },
    {
      name: "Operations",
      href: "/reconciliation",
      links: [
        ["Reconciliation issues", "/reconciliation"],
        ["Payment events", "/payment-events"],
        ["Event delivery (Outbox)", "/outbox"],
        ["Agent approvals", "/approvals"],
      ],
    },
    {
      name: "Settings",
      href: "/shipping",
      links: [
        ["Shipping & rates", "/shipping"],
        ["Tax rates", "/taxes"],
      ],
    },
  ];
  const matches = (href: string) =>
    href === "/"
      ? page.url.pathname === "/" || page.url.pathname.startsWith("/products/")
      : page.url.pathname === href || page.url.pathname.startsWith(`${href}/`);
  let drawer: HTMLDialogElement;
  let open = $state(false);
  let expanded = $state<string | null>(null);
  // Deep links and history navigation reveal their owning module.
  $effect(() => {
    expanded =
      groups.find((group) => group.links.some(([, href]) => matches(href)))
        ?.name ?? null;
  });
  async function show() {
    open = true;
    await tick();
    drawer.showModal();
  }
  function close() {
    drawer?.close();
    open = false;
  }
  afterNavigate(close);
  onMount(() => {
    const desktop = matchMedia("(min-width: 651px)");
    const resized = () => {
      if (desktop.matches) close();
    };
    desktop.addEventListener("change", resized);
    return () => desktop.removeEventListener("change", resized);
  });
</script>

{#snippet links()}
  {#if admin}
    <p class="eyebrow">Store management</p>
    <nav aria-label="Main navigation">
      {#each groups as group, index}
        <div class:utilities={index === 5}>
          <div
            class="module"
            class:active={group.links.some(([, href]) => matches(href))}
          >
            <a
              href={group.href}
              aria-current={group.links.length === 1 && matches(group.href)
                ? "page"
                : undefined}>{group.name}</a
            >
            {#if group.links.length > 1}
              <button
                class="disclosure"
                aria-label={`${expanded === group.name ? "Collapse" : "Expand"} ${group.name}`}
                aria-expanded={expanded === group.name}
                onclick={() =>
                  (expanded = expanded === group.name ? null : group.name)}
              >
                <span aria-hidden="true"
                  >{expanded === group.name ? "−" : "+"}</span
                >
              </button>
            {/if}
          </div>
          {#if group.links.length > 1 && expanded === group.name}
            <div class="subnav">
              {#each group.links as [label, href]}
                <a {href} aria-current={matches(href) ? "page" : undefined}
                  >{label}</a
                >
              {/each}
            </div>
          {/if}
        </div>
      {/each}
    </nav>
  {/if}
  <nav class="personal" aria-label="Personal navigation">
    <p class="eyebrow">Personal</p>
    <a
      href="/connections"
      aria-current={matches("/connections") ? "page" : undefined}
      >My Agent connections</a
    >
  </nav>
  <p class="store-note">Single store · USD</p>
{/snippet}

<aside class="store-sidebar" aria-label="Store navigation">
  <a class="brand" href={admin ? "/" : "/connections"}>tera<span>ADMIN</span></a
  >
  {@render links()}
</aside>
<div class="mobile-navigation">
  <a class="brand" href={admin ? "/" : "/connections"}>tera<span>ADMIN</span></a
  >
  <button aria-haspopup="dialog" aria-expanded={open} onclick={show}
    >Menu</button
  >
</div>
<dialog
  bind:this={drawer}
  aria-label="Store navigation"
  onclose={() => (open = false)}
  onclick={(event) => {
    if (event.target === drawer) close();
  }}
>
  {#if open}
    <div class="drawer-content">
      <div class="drawer-heading">
        <span class="brand">tera<span>ADMIN</span></span><button
          onclick={close}
          aria-label="Close navigation">Close</button
        >
      </div>
      {@render links()}
    </div>
  {/if}
</dialog>

<style>
  .store-sidebar {
    background: #ecf0e9;
    padding: 2rem 1.3rem;
    border-right: 1px solid #dce2d9;
    display: flex;
    flex-direction: column;
  }
  .store-sidebar > .brand {
    margin: 0 0.55rem 2rem;
  }
  .eyebrow {
    padding: 0 0.6rem;
  }
  nav a {
    display: block;
    padding: 0.75rem 0.65rem;
    color: #2d4735;
    text-decoration: none;
    border-radius: 5px;
    font-size: 0.88rem;
    font-weight: 600;
  }
  nav a:hover,
  nav a[aria-current="page"] {
    background: #dbe5d9;
  }
  .module {
    display: flex;
    align-items: center;
    border-radius: 5px;
    margin-bottom: 0.2rem;
  }
  .module > a {
    flex: 1;
  }
  .module.active > a {
    color: #214c3b;
    font-weight: 750;
  }
  .disclosure {
    padding: 0.55rem;
    min-width: 38px;
    background: transparent;
    border: 0;
  }
  .subnav {
    border-left: 1px solid #c6d3c4;
    margin: 0.1rem 0 0.7rem 0.8rem;
    padding-left: 0.45rem;
  }
  .subnav a {
    font-size: 0.8rem;
    font-weight: 500;
    padding: 0.6rem;
  }
  .utilities {
    border-top: 1px solid #d3ddcf;
    padding-top: 0.8rem;
    margin-top: 0.8rem;
  }
  .personal {
    margin-top: 1.5rem;
    border-top: 1px solid #d3ddcf;
    padding-top: 1rem;
  }
  .store-note {
    margin-top: auto;
    padding: 2rem 0.6rem 0;
    font-size: 0.75rem;
    color: #626e63;
  }
  .mobile-navigation {
    display: none;
  }
  dialog {
    padding: 0;
    border: 0;
    margin: 0;
    width: min(320px, 90vw);
    max-width: 90vw;
    height: 100dvh;
    max-height: 100dvh;
    background: #ecf0e9;
    color: inherit;
  }
  dialog::backdrop {
    background: #15261d80;
  }
  .drawer-content {
    min-height: 100%;
    padding: 1.2rem;
    box-sizing: border-box;
  }
  .drawer-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1.5rem;
    gap: 1rem;
  }
  :global(body:has(dialog[open])) {
    overflow: hidden;
  }
  @media (max-width: 650px) {
    .store-sidebar {
      display: none;
    }
    .mobile-navigation {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.8rem 1rem;
      background: #ecf0e9;
      border-bottom: 1px solid #dce2d9;
    }
    .brand {
      font-size: 1.8rem;
    }
  }
</style>
