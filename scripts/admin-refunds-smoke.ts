// Local disposable fixtures only. No payment-provider network calls.
import { localSupabase } from "./lib/local-supabase";
import { strict as assert } from "node:assert";
Object.assign(process.env, localSupabase());
const { api, rpc, checked, TEST_ADDRESS } = await import("../tests/helpers");
const { paymentFixture, fixtureOrder, fixtureIntent, settleIntent } =
  await import("../tests/payment-fixtures");
const origin = new URL(process.env.ADMIN_URL ?? "http://127.0.0.1:5174");
if (!["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))
  throw Error("Local admin URL required");
const session = `refund-${crypto.randomUUID()}`,
  email = `${session}@example.test`,
  password = crypto.randomUUID() + "Aa1!";
let user = "",
  product = "",
  shippingMethod = "",
  taxRate = "";
async function browser(...args: string[]) {
  const proc = Bun.spawn(["agent-browser", "--session", session, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code)
    throw Error(
      `Browser ${args[0]} ${args[0] === "wait" ? args.slice(1).join(" ") : ""} failed: ${err || out}`,
    );
}
const click = (name: string) =>
  browser("find", "role", "button", "click", "--name", name, "--exact");
const wait = (text: string) => browser("wait", "--text", text);
const ready = () =>
  browser(
    "wait",
    "--fn",
    '!!document.querySelector("#refund-amount") && !document.querySelector("#refund-amount").closest("fieldset").disabled',
  );
try {
  user = (
    await checked<{ id: string }>(
      api("/auth/v1/admin/users", {
        service: true,
        method: "POST",
        body: { email, password, email_confirm: true },
      }),
    )
  ).id;
  await checked(
    api(`/rest/v1/profiles?id=eq.${user}`, {
      service: true,
      method: "PATCH",
      body: { role: "admin" },
    }),
  );
  const auth = await checked<{ access_token: string }>(
    api("/auth/v1/token?grant_type=password", {
      method: "POST",
      body: { email, password },
    }),
  );
  const actor = {
    userId: user,
    token: auth.access_token,
    email,
    customerId: await checked<string>(
      rpc("current_customer_id", {}, auth.access_token),
    ),
  };
  const fixture = await paymentFixture(actor);
  product = fixture.productId;
  const order = await fixtureOrder(fixture, actor, 2);
  await checked(
    rpc(
      "mark_order_paid",
      { order_id: order.id, idempotency_key: crypto.randomUUID() },
      actor.token,
    ),
  );
  const ledger = () =>
    checked<any>(rpc("get_order_ledger", { order_id: order.id }, actor.token));
  const stock = () =>
    checked<any[]>(
      api(
        `/rest/v1/inventory_levels?variant_id=eq.${fixture.variantId}&select=on_hand&order=location_id`,
        { service: true },
      ),
    );
  const fulfillment = () =>
    checked<any>(
      rpc("get_order_fulfillment_balance", { order_id: order.id }, actor.token),
    );
  const beforeStock = await stock(),
    beforeFulfillment = await fulfillment();
  await browser("open", `${origin.origin}/orders/${order.id}`);
  await browser("wait", "input[type=email]");
  await browser("fill", "input[type=email]", email);
  await browser("fill", "input[type=password]", password);
  await click("Sign in");
  await browser("wait", `a[href="/orders/${order.id}/refunds"]`);
  // Links render before the order read finishes; its navigation guard blocks
  // leaving while busy, so wait for the actual ready state rather than the link.
  await browser(
    "wait",
    "--fn",
    'Array.from(document.querySelectorAll("button")).some(b => b.textContent.trim() === "Reload order" && !b.disabled)',
  );
  await browser("click", `a[href="/orders/${order.id}/refunds"]`);
  await ready();
  await browser("fill", "#refund-amount", "7.251");
  await browser("fill", "#refund-reason", "Offline refund REF-001");
  await click("Preview refund");
  await wait("at most two decimal places");
  assert.equal((await ledger()).refunds.length, 0);
  await browser("fill", "#refund-amount", "7.25");
  await click("Preview refund");
  await wait("Total including tax: $7.25");
  assert.equal((await ledger()).refunds.length, 0);
  await browser("check", "#refund-confirm");
  await browser(
    "eval",
    `(() => { const original = window.fetch; window.fetch = async (...args) => {
    if (String(args[0]).includes('/rpc/commit_manual_refund')) { window.fetch = original; const response = await original(...args); if (!response.ok) return response; return new Response(JSON.stringify({message:'Simulated lost refund response'}), {status:503,headers:{'Content-Type':'application/json'}}); } return original(...args);
  }; })()`,
  );
  await click("Record manual refund");
  await browser("dialog", "accept");
  await wait("Unconfirmed manual refund request");
  await browser("screenshot", "/tmp/admin-refund-uncertain.png", "--full");
  assert.equal((await ledger()).refunds.length, 1);
  await browser("reload");
  await wait("Unconfirmed manual refund request");
  await browser(
    "wait",
    "--fn",
    'Array.from(document.querySelectorAll("button")).some(b => b.textContent.trim() === "Replay saved bookkeeping" && !b.disabled)',
  );
  await click("Replay saved bookkeeping");
  await browser("dialog", "accept");
  await wait("Manual refund bookkeeping confirmed");
  await ready();
  const result = await ledger();
  assert.equal(result.refunds.length, 1);
  assert.equal(result.balances.refunded, 7.25);
  assert.equal(result.refunds[0].source, "custom_amount");
  assert.equal(result.refunds[0].lines.length, 0);
  assert.equal(result.refunds[0].components[0].kind, "unallocated");
  assert.deepEqual(await stock(), beforeStock);
  assert.deepEqual(await fulfillment(), beforeFulfillment);
  await browser("screenshot", "/tmp/admin-refund.png", "--full");
  await browser("set", "viewport", "390", "844");
  await browser("screenshot", "/tmp/admin-refund-mobile.png", "--full");
  await browser(
    "eval",
    'if (document.documentElement.scrollWidth > innerWidth) throw Error("Refund mobile overflow")',
  );
  // Server-side balance race must reject a stale new request without an extra record.
  await browser("fill", "#refund-amount", "12.00");
  await browser("fill", "#refund-reason", "Offline REF-002");
  await click("Preview refund");
  await wait("Total including tax: $12.00");
  await browser("check", "#refund-confirm");
  await checked(
    rpc(
      "refund_order",
      {
        order_id: order.id,
        amount: 10,
        reason: "Concurrent bookkeeping",
        provider: "manual",
        restock: false,
        idempotency_key: crypto.randomUUID(),
      },
      actor.token,
    ),
  );
  await click("Record manual refund");
  await browser("dialog", "accept");
  await browser("wait", "[role=alert]");
  await browser(
    "eval",
    'if (!document.querySelector("fieldset").disabled) throw Error("Stale refund form editable")',
  );
  assert.equal((await ledger()).refunds.length, 2);
  await click("Reload refund ledger");
  await browser("dialog", "accept");
  await ready();
  // Historical item labels and linked payment records use owned real RPC facts.
  const itemOrder = await fixtureOrder(fixture, actor, 3);
  await checked(
    rpc(
      "mark_order_paid",
      { order_id: itemOrder.id, idempotency_key: crypto.randomUUID() },
      actor.token,
    ),
  );
  await browser("open", `${origin.origin}/orders/${itemOrder.id}/refunds`);
  await ready();
  await browser("select", "#refund-mode", "items");
  await browser("fill", "[data-refund-item]", "2");
  await browser("fill", "#refund-reason", "Historical item refund");
  await browser("check", "#refund-restock");
  await click("Preview refund");
  await wait("Total including tax: $20.00");
  await wait("Cancel 2 · Release stock 2");
  await checked(
    rpc(
      "create_fulfillment",
      {
        order_id: itemOrder.id,
        items: [{ order_item_id: itemOrder.itemId, quantity: 2 }],
        idempotency_key: crypto.randomUUID(),
      },
      actor.token,
    ),
  );
  await browser("check", "#refund-confirm");
  await click("Record manual refund");
  await browser("dialog", "accept");
  await wait("refund preview changed");
  assert.equal(
    (
      await checked<any>(
        rpc("get_order_ledger", { order_id: itemOrder.id }, actor.token),
      )
    ).refunds.length,
    0,
  );
  await click("Reload refund ledger");
  await browser("dialog", "accept");
  await ready();
  await browser("select", "#refund-mode", "items");
  await browser("fill", "[data-refund-item]", "1");
  await browser("fill", "#refund-reason", "Historical item refund");
  await browser("check", "#refund-restock");
  await click("Preview refund");
  await wait("Total including tax: $10.00");
  await wait("Cancel 1 · Release stock 1");
  await browser("check", "#refund-confirm");
  await click("Change selection");
  await browser(
    "eval",
    'if (document.querySelector("#refund-confirm")) throw Error("Old confirmation survived selection change")',
  );
  await click("Preview refund");
  await wait("Total including tax: $10.00");
  await browser(
    "eval",
    'if (document.querySelector("#refund-confirm").checked) throw Error("Confirmation was reused")',
  );
  await browser("screenshot", "/tmp/admin-refund-preview-mobile.png", "--full");
  await browser("set", "viewport", "1280", "900");
  await browser("screenshot", "/tmp/admin-refund-preview.png", "--full");
  const beforeRelease = (await stock()).reduce(
    (sum, row) => sum + row.on_hand,
    0,
  );
  await browser("check", "#refund-confirm");
  await click("Record manual refund");
  await browser("dialog", "accept");
  await wait("Manual refund bookkeeping confirmed");
  await ready();
  assert.equal(
    (await stock()).reduce((sum, row) => sum + row.on_hand, 0),
    beforeRelease + 1,
  );
  // Shipped units the customer sent back return to stock only when entered per line.
  await browser("select", "#refund-mode", "items");
  await browser("fill", "[data-refund-item]", "1");
  await browser("fill", "[data-refund-returned]", "1");
  await browser("fill", "#refund-reason", "Returned shipped unit");
  await click("Preview refund");
  await wait("Cancel 0 · Release stock 0 · Restock returned 1");
  await browser("check", "#refund-confirm");
  await click("Record manual refund");
  await browser("dialog", "accept");
  await wait("Manual refund bookkeeping confirmed");
  await ready();
  assert.equal(
    (await stock()).reduce((sum, row) => sum + row.on_hand, 0),
    beforeRelease + 2,
  );
  await browser("set", "viewport", "390", "844");
  await wait(fixture.sku);
  await wait("Allocated total: $10.00");
  await wait("manual · refund · succeeded · $10.00");
  await wait("Recorded payment transactions");
  await browser(
    "eval",
    'if (document.documentElement.scrollWidth > innerWidth) throw Error("Refund detail mobile overflow")',
  );
  await browser("screenshot", "/tmp/admin-refund-detail-mobile.png", "--full");
  await browser("set", "viewport", "1280", "900");
  await browser("screenshot", "/tmp/admin-refund-detail.png", "--full");
  // A missing optional price snapshot must fall back to IDs, without hiding ledger facts.
  await browser(
    "eval",
    `(() => { const original = window.fetch; window.fetch = async (...args) => {
    if (String(args[0]).includes('/rpc/get_order_pricing')) { window.fetch = original; return new Response(JSON.stringify({message:'Simulated missing price snapshot'}), {status:400,headers:{'Content-Type':'application/json'}}); } return original(...args);
  }; })()`,
  );
  await click("Reload refund ledger");
  await wait("Price snapshot unavailable");
  await wait(`Item ${itemOrder.itemId}: 1 units`);
  await ready();
  await browser(
    "screenshot",
    "/tmp/admin-refund-detail-fallback.png",
    "--full",
  );
  await click("Reload refund ledger");
  await ready();
  await wait(fixture.sku);
  await browser(
    "eval",
    'if (document.body.innerText.includes("Price snapshot unavailable")) throw Error("Snapshot warning not cleared")',
  );
  // Corrupt only the browser response; never mutate immutable accounting records.
  await browser(
    "eval",
    `(() => { const original = window.fetch; window.fetch = async (...args) => {
    const response = await original(...args);
    if (!String(args[0]).includes('/rpc/get_order_ledger') || !response.ok) return response;
    window.fetch = original;
    const data = await response.json();
    data.refunds[0].components.push({kind:'unallocated',amount:0.01,tax_line_id:null,shipping_line_id:null});
    data.balances.is_balanced = false;
    return new Response(JSON.stringify(data), {headers:{'Content-Type':'application/json'}});
  }; })()`,
  );
  await click("Reload refund ledger");
  await wait("Allocation does not match the refund amount");
  await wait("Allocated total: $10.01");
  await browser(
    "eval",
    'if (!document.querySelector("fieldset").disabled) throw Error("Unbalanced ledger allowed bookkeeping")',
  );
  await browser(
    "screenshot",
    "/tmp/admin-refund-detail-mismatch.png",
    "--full",
  );
  shippingMethod = (
    await checked<{ id: string }[]>(
      api("/rest/v1/shipping_methods", {
        service: true,
        method: "POST",
        body: { name: "Preview shipping", price: 4, countries: ["AQ"] },
      }),
    )
  )[0].id;
  taxRate = (
    await checked<{ id: string }[]>(
      api("/rest/v1/tax_rates", {
        service: true,
        method: "POST",
        body: {
          name: "Preview tax",
          country: "AQ",
          rate: 0.13,
          include_shipping: true,
        },
      }),
    )
  )[0].id;
  const taxed = await fixtureOrder(fixture, actor, 1, true, {
    shipping_method_id: shippingMethod,
    address: { ...TEST_ADDRESS, country: "AQ" },
  });
  await checked(
    rpc(
      "mark_order_paid",
      { order_id: taxed.id, idempotency_key: crypto.randomUUID() },
      actor.token,
    ),
  );
  await browser("open", `${origin.origin}/orders/${taxed.id}/refunds`);
  await ready();
  await browser("select", "#refund-mode", "items");
  await browser("fill", "[data-refund-item]", "1");
  await browser("fill", "#refund-shipping", "4");
  await browser("fill", "#refund-reason", "Offline taxed refund");
  await click("Preview refund");
  await wait("Total including tax: $15.82");
  await wait("Shipping tax · Preview tax");
  await browser("screenshot", "/tmp/admin-refund-preview-tax.png", "--full");
  await click("Change selection");
  await browser("fill", "[data-refund-item]", "");
  await browser("fill", "#refund-shipping", "1.25");
  await click("Preview refund");
  await wait("Total including tax: $1.41");
  await browser("check", "#refund-confirm");
  await click("Record manual refund");
  await browser("dialog", "accept");
  await wait("Manual refund bookkeeping confirmed");
  const shippingRefund = (
    await checked<any>(
      rpc("get_order_ledger", { order_id: taxed.id }, actor.token),
    )
  ).refunds[0];
  assert.equal(shippingRefund.source, "shipping");
  assert.equal(shippingRefund.amount, 1.41);
  assert.equal(shippingRefund.lines.length, 0);
  // A real local PayPal-settlement fixture is read-only in this UI; no provider network call.
  const online = await fixtureOrder(fixture, actor, 1);
  const intent = await fixtureIntent(online, actor);
  await settleIntent(intent);
  await browser("open", `${origin.origin}/orders/${online.id}/refunds`);
  await wait("Online or mixed payment history detected");
  await browser(
    "eval",
    'if (!document.querySelector("fieldset").disabled) throw Error("Provider refund allowed via manual form")',
  );
  await browser(
    "eval",
    `if (document.body.innerText.includes(${JSON.stringify(intent.provider_reference)})) throw Error("Provider reference exposed")`,
  );
  await browser("screenshot", "/tmp/admin-refund-online-blocked.png", "--full");
  console.log(
    "Refund smoke passed: exact amount, lost-response replay once, unallocated record, stock/quantities unchanged, stale balance rejected, historical item details, returned shipped unit restocked, snapshot fallback/recovery, linked transactions, hidden provider reference, PayPal read-only, mobile.",
  );
} catch (error) {
  await browser("screenshot", "/tmp/admin-refund-failure.png", "--full").catch(
    () => {},
  );
  throw error;
} finally {
  await browser("close").catch(() => {});
  for (const [table, id] of [
    ["shipping_methods", shippingMethod],
    ["tax_rates", taxRate],
  ])
    if (id)
      await checked(
        api(`/rest/v1/${table}?id=eq.${id}`, {
          service: true,
          method: "PATCH",
          body: { is_active: false },
        }),
      );
  if (product)
    await checked(
      api(`/rest/v1/products?id=eq.${product}`, {
        service: true,
        method: "PATCH",
        body: { status: "archived" },
      }),
    );
  if (user)
    await checked(
      api(`/rest/v1/profiles?id=eq.${user}`, {
        service: true,
        method: "PATCH",
        body: { role: "customer" },
      }),
    );
}
