<script lang="ts">
  import { resolve } from "$app/paths";
  import { onMount } from "svelte";
  import { createClient, type SupabaseClient } from "@supabase/supabase-js";
  import {
    PUBLIC_SUPABASE_URL,
    PUBLIC_SUPABASE_ANON_KEY,
  } from "$env/static/public";
  import type { Database } from "../../../../types/database";
  let client: SupabaseClient<Database> | undefined;
  import { readBag, writeBag, type BagLine } from "$lib/bag";
  import {
    getProduct,
    publicApi,
    imageUrl,
    money,
    type Product,
  } from "$lib/catalog";
  let lines = $state<BagLine[]>([]);
  let products = $state<Record<string, Product | null>>({});
  let loaded = $state(false);
  let busy = $state(false);
  let message = $state("");
  let now = $state(Date.now());
  let email = $state("");
  let name = $state("");
  let line1 = $state("");
  let city = $state("");
  let region = $state("");
  let postal = $state("");
  let country = $state("US");
  let shipping = $state("");
  let methods = $state<
    { id: string; name: string; countries: string[]; price: number }[]
  >([]);
  type Quote = {
    id: string;
    subtotal: number;
    discount_total: number;
    shipping_total: number;
    tax_total: number;
    total: number;
    expires_at: string;
  };
  let quote = $state<Quote | null>(null);
  let expired = $derived(!!quote && Date.parse(quote.expires_at) <= now);
  let availableMethods = $derived(
    methods.filter(
      (method) =>
        !method.countries.length || method.countries.includes(country),
    ),
  );
  let subtotal = $derived(
    lines.reduce(
      (sum, line) =>
        sum +
        Number(
          products[line.product_id]?.variants.find(
            (v) => v.id === line.variant_id,
          )?.price ?? 0,
        ) *
          line.quantity,
      0,
    ),
  );
  let unavailable = $derived(
    lines.some(
      (line) =>
        !products[line.product_id]?.variants.find(
          (v) => v.id === line.variant_id,
        )?.in_stock,
    ),
  );
  async function load() {
    loaded = false;
    message = "";
    try {
      lines = readBag();
      const ids = [...new Set(lines.map((line) => line.product_id))];
      products = Object.fromEntries(
        await Promise.all(ids.map(async (id) => [id, await getProduct(id)])),
      );
      methods = await publicApi(
        "shipping_methods?select=id,name,countries,price&is_active=eq.true&order=position",
      );
      loaded = true;
    } catch {
      message =
        "Unable to load your bag. Check your connection and browser storage, then retry.";
    }
  }
  onMount(() => {
    void load();
    const timer = setInterval(() => {
      now = Date.now();
    }, 1000);
    return () => clearInterval(timer);
  });
  function change(id: string, quantity: number) {
    if (
      busy ||
      quote ||
      !Number.isInteger(quantity) ||
      quantity < 0 ||
      quantity > 10
    )
      return;
    const next = lines.flatMap((line) =>
      line.variant_id !== id ? [line] : quantity ? [{ ...line, quantity }] : [],
    );
    try {
      writeBag(next);
      lines = next;
      message = "";
    } catch {
      message = "Your browser could not save the bag.";
    }
  }
  async function requestQuote(event: SubmitEvent) {
    event.preventDefault();
    if (busy || quote || !loaded || !lines.length || unavailable) return;
    busy = true;
    message = "";
    try {
      client ??= createClient<Database>(
        PUBLIC_SUPABASE_URL,
        PUBLIC_SUPABASE_ANON_KEY,
      );
      const { data: sessionData, error: sessionError } =
        await client.auth.getSession();
      if (sessionError) throw sessionError;
      if (!sessionData.session) {
        const { error } = await client.auth.signInAnonymously();
        if (error) throw error;
      }
      const customer = await client.rpc("current_customer_id");
      if (customer.error || !customer.data)
        throw new Error("Unable to restore your customer session.");
      const contact = await client
        .from("customers")
        .update({ email })
        .eq("id", customer.data);
      if (contact.error) throw contact.error;
      const input = {
        items: lines.map(({ variant_id, quantity }) => ({
          variant_id,
          quantity,
        })),
        address: {
          recipient_name: name,
          line1,
          city,
          region,
          postal_code: postal,
          country,
        },
        ...(shipping &&
        availableMethods.some((method) => method.id === shipping)
          ? { shipping_method_id: shipping }
          : {}),
      };
      const bytes = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify([customer.data, input])),
      );
      const fingerprint = Array.from(new Uint8Array(bytes), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      const slot = `tera-quote-${fingerprint}`;
      const expiresAt = sessionStorage.getItem(`${slot}-expires`);
      if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
        sessionStorage.removeItem(slot);
        sessionStorage.removeItem(`${slot}-expires`);
      }
      const key = sessionStorage.getItem(slot) || crypto.randomUUID();
      sessionStorage.setItem(slot, key);
      const result = await client.rpc("create_checkout_quote", {
        ...input,
        idempotency_key: key,
      });
      if (result.error) throw result.error;
      quote = result.data as unknown as Quote;
      sessionStorage.setItem(`${slot}-expires`, quote.expires_at);
    } catch {
      message =
        "A quote could not be confirmed. Availability, address or your session may have changed. Review your details and retry; retries use the same request key.";
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head
  ><title>Your bag — Atelier Tera</title><meta
    name="robots"
    content="noindex"
  /></svelte:head
>
<section class="section bag-page">
  <p class="eyebrow">A WARDROBE IN THE MAKING</p>
  <h1>Your bag</h1>
  <p class="status" aria-live="polite">{message}</p>
  {#if !loaded}<p>Loading your bag…</p>
    <button class="text-link" onclick={load}>Retry</button>
  {:else if !lines.length}<div class="empty-bag">
      <h2>Room for something lovely.</h2>
      <p>Your bag is currently empty.</p>
      <a class="button" href={resolve("/shop/")}>Explore the collection ↗</a>
    </div>
  {:else}<div class="bag-layout">
      <div>
        {#each lines as line (line.variant_id)}{@const product =
            products[line.product_id]}{@const variant = product?.variants.find(
            (v) => v.id === line.variant_id,
          )}
          <article class="bag-row">
            {#if imageUrl(product?.images[0]?.url)}<img
                src={imageUrl(product?.images[0]?.url)}
                alt={product?.name || ""}
                width="160"
                height="200"
              />{/if}
            <div>
              {#if product}<a
                  href={resolve("/products/[slug]", { slug: product.slug })}
                  ><h3>{product.name}</h3></a
                >{:else}<h3>Unavailable item</h3>{/if}
              <p>
                {product?.options
                  .flatMap((o) =>
                    o.values
                      .filter((v) => variant?.option_value_ids.includes(v.id))
                      .map((v) => v.value),
                  )
                  .join(" / ")}
              </p>
              <p>
                {variant ? money(Number(variant.price)) : "No longer available"}
              </p>
              {#if !variant?.in_stock}<p>
                  Unavailable — remove this item to continue.
                </p>{/if}
              <div class="quantity">
                <button
                  aria-label={`Decrease ${product?.name || "item"} quantity`}
                  disabled={busy || !!quote}
                  onclick={() => change(line.variant_id, line.quantity - 1)}
                  >−</button
                ><span>{line.quantity}</span><button
                  aria-label={`Increase ${product?.name || "item"} quantity`}
                  disabled={busy || !!quote || line.quantity === 10}
                  onclick={() => change(line.variant_id, line.quantity + 1)}
                  >+</button
                ><button
                  class="text-link"
                  disabled={busy || !!quote}
                  onclick={() => change(line.variant_id, 0)}>Remove</button
                >
              </div>
            </div>
          </article>{/each}<a class="text-link" href={resolve("/shop/")}
          >← Continue exploring</a
        >
      </div>
      <aside class="quote-panel">
        <h2>
          {quote
            ? expired
              ? "Your quote has expired"
              : "Your reserved quote"
            : "Review your selection"}
        </h2>
        {#if quote}<dl>
            <div>
              <dt>Items</dt>
              <dd>{money(quote.subtotal)}</dd>
            </div>
            <div>
              <dt>Discount</dt>
              <dd>−{money(quote.discount_total)}</dd>
            </div>
            <div>
              <dt>Shipping</dt>
              <dd>{money(quote.shipping_total)}</dd>
            </div>
            <div>
              <dt>Tax</dt>
              <dd>{money(quote.tax_total)}</dd>
            </div>
            <div class="total">
              <dt>Total · USD</dt>
              <dd>{money(quote.total)}</dd>
            </div>
          </dl>
          <p>
            Quote expires {new Date(quote.expires_at).toLocaleString()}. No
            order has been placed and no payment has been taken.
          </p>
          <p class="fineprint">
            Payments are not enabled in this preview. The reservation expires
            automatically; payment integration will follow Sandbox verification.
          </p>
          {#if expired}<button
              class="button full"
              onclick={() => {
                quote = null;
                void load();
              }}>Review a new quote</button
            >{/if}
        {:else}<div class="summary-total">
            <span>Items · USD</span><span>{money(subtotal)}</span>
          </div>
          <p class="fineprint">
            An estimate only. Confirm a database quote for current prices,
            shipping and availability. This reserves stock briefly; it does not
            place an order.
          </p>
          <form onsubmit={requestQuote}>
            <fieldset disabled={busy || unavailable}>
              <label
                >Email<input
                  type="email"
                  bind:value={email}
                  autocomplete="email"
                  required
                /></label
              ><label
                >Full name<input
                  bind:value={name}
                  autocomplete="name"
                  required
                /></label
              ><label
                >Street address<input
                  bind:value={line1}
                  autocomplete="address-line1"
                  required
                /></label
              >
              <div class="form-pair">
                <label
                  >City<input
                    bind:value={city}
                    autocomplete="address-level2"
                    required
                  /></label
                ><label
                  >State / region<input
                    bind:value={region}
                    autocomplete="address-level1"
                  /></label
                >
              </div>
              <div class="form-pair">
                <label
                  >Postal code<input
                    bind:value={postal}
                    autocomplete="postal-code"
                  /></label
                ><label
                  >Country<select
                    bind:value={country}
                    onchange={() => {
                      shipping = "";
                    }}
                    ><option value="US">United States</option><option value="CA"
                      >Canada</option
                    ><option value="GB">United Kingdom</option><option
                      value="JP">Japan</option
                    ><option value="SG">Singapore</option></select
                  ></label
                >
              </div>
              <label
                >Delivery<select bind:value={shipping}
                  ><option value="">Standard / recommended</option
                  >{#each availableMethods as method (method.id)}<option
                      value={method.id}
                      >{method.name} · {money(Number(method.price))} base rate</option
                    >{/each}</select
                ></label
              ><button class="button full" type="submit"
                >{busy ? "Confirming…" : "Confirm reserved quote"}
                <span>↗</span></button
              >
            </fieldset>
          </form>{/if}
      </aside>
    </div>{/if}
</section>
