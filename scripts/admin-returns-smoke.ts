// Local-only browser regression; retains immutable order/return audit fixtures.
import { localSupabase } from "./lib/local-supabase";
import { strict as assert } from "node:assert";
const config = localSupabase();
Object.assign(process.env, config);
const { api, rpc, checked } = await import("../tests/helpers");
const { paymentFixture, fixtureOrder } =
  await import("../tests/payment-fixtures");
const origin = new URL(process.env.ADMIN_URL ?? "http://127.0.0.1:5174");
if (!["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))
  throw Error("Local admin URL required");
const session = `returns-${crypto.randomUUID()}`,
  email = `${session}@example.test`,
  password = crypto.randomUUID() + "Aa1!";
let user = "",
  receiptLocation = "",
  product = "";
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
  if (code) throw Error(`Browser ${args[0]} failed: ${err || out}`);
}
const click = (name: string) =>
  browser("find", "role", "button", "click", "--name", name, "--exact");
const wait = (text: string) => browser("wait", "--text", text);
const ready = () =>
  browser(
    "wait",
    "--fn",
    '!!document.querySelector("fieldset") && !document.querySelector("fieldset").disabled',
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
  const order = await fixtureOrder(fixture, actor, 5);
  await checked(
    rpc(
      "mark_order_paid",
      { order_id: order.id, idempotency_key: crypto.randomUUID() },
      actor.token,
    ),
  );
  const ship = async (quantity: number) =>
    checked<{ id: string }>(
      rpc(
        "create_fulfillment",
        {
          order_id: order.id,
          items: [{ order_item_id: order.itemId, quantity }],
          idempotency_key: crypto.randomUUID(),
        },
        actor.token,
      ),
    );
  const first = await ship(3),
    second = await ship(2);
  const facts = () =>
    checked<any>(rpc("get_order_returns", { order_id: order.id }, actor.token));
  const stock = () =>
    checked<any[]>(
      api(
        `/rest/v1/inventory_levels?variant_id=eq.${fixture.variantId}&select=on_hand`,
        { service: true },
      ),
    );
  const before = await stock();
  await browser("open", `${origin.origin}/orders/${order.id}`);
  await browser("wait", "input[type=email]");
  await browser("fill", "input[type=email]", email);
  await browser("fill", "input[type=password]", password);
  await click("Sign in");
  await browser("wait", `a[href="/orders/${order.id}/returns"]`);
  await browser("click", `a[href="/orders/${order.id}/returns"]`);
  await ready();
  await wait("No return authorizations yet.");
  await browser("select", "#return-shipment", first.id);
  await browser("fill", "input[type=number]", "4");
  await browser(
    "eval",
    'if (document.querySelector("input[type=number]").checkValidity()) throw Error("Over-return permitted")',
  );
  await browser("fill", "input[type=number]", "3");
  await browser(
    "fill",
    "#return-reason",
    "Wrong size — customer requested return",
  );
  // Execute the real server write but replace its response with an unknown failure.
  await browser(
    "eval",
    `(() => { const original = window.fetch; window.fetch = async (...args) => {
    if (String(args[0]).includes('/rpc/create_return')) { window.fetch = original; const response = await original(...args); if (!response.ok) return response; return new Response(JSON.stringify({message:'Simulated lost response'}), {status:503,headers:{'Content-Type':'application/json'}}); }
    return original(...args);
  }; })()`,
  );
  await click("Authorize return");
  await browser("dialog", "accept");
  await wait("Unconfirmed return request");
  assert.equal((await facts()).returns.length, 1);
  await browser("screenshot", "/tmp/admin-returns-uncertain.png", "--full");
  await browser("reload");
  await wait("Unconfirmed return request");
  await browser(
    "wait",
    "--fn",
    '!Array.from(document.querySelectorAll("button")).find(b => b.textContent.includes("Replay saved return")).disabled',
  );
  await click("Replay saved return");
  await browser("dialog", "accept");
  await wait("Return authorized.");
  await ready();
  assert.equal((await facts()).returns.length, 1);
  await browser(
    "eval",
    'if (Object.keys(sessionStorage).some(k => k.includes(":return:"))) throw Error("Journal not cleared")',
  );
  assert.deepEqual(await stock(), before);
  const ledger = await checked<any>(
    rpc("get_order_ledger", { order_id: order.id }, actor.token),
  );
  assert.equal(ledger.balances.refunded, 0);
  // Receive through the UI; a committed receipt must replay after its location is disabled.
  const authorization = (await facts()).returns[0];
  const [location] = await checked<{ id: string }[]>(
    api("/rest/v1/locations", {
      service: true,
      method: "POST",
      body: { code: session, name: "Returns inspection", is_active: true },
    }),
  );
  receiptLocation = location.id;
  const receiveUrl = `/orders/${order.id}/returns/${authorization.id}/receive`;
  await browser("click", `a[href="${receiveUrl}"]`);
  await ready();
  await browser(
    "eval",
    'if (document.querySelector("#receipt-location").value !== "") throw Error("Location auto-selected")',
  );
  await browser("select", "#receipt-location", receiptLocation);
  await browser("fill", "input[type=number]", "4");
  await browser(
    "eval",
    'if (document.querySelector("input[type=number]").checkValidity()) throw Error("Over-receipt permitted")',
  );
  await browser("fill", "input[type=number]", "2");
  await browser("fill", "#receipt-note", "Received for inspection");
  await browser(
    "eval",
    `(() => { const original = window.fetch; window.fetch = async (...args) => {
    if (String(args[0]).includes('/rpc/receive_return')) { window.fetch = original; const response = await original(...args); if (!response.ok) return response; return new Response(JSON.stringify({message:'Simulated lost receipt'}), {status:503,headers:{'Content-Type':'application/json'}}); } return original(...args);
  }; })()`,
  );
  await click("Record receipt");
  await browser("dialog", "accept");
  await wait("Unconfirmed receipt request");
  await browser("screenshot", "/tmp/admin-receipt-uncertain.png", "--full");
  assert.equal((await facts()).returns[0].receipts.length, 1);
  await checked(
    api(`/rest/v1/locations?id=eq.${receiptLocation}`, {
      service: true,
      method: "PATCH",
      body: { is_active: false },
    }),
  );
  await browser("reload");
  await wait("Unconfirmed receipt request");
  await browser(
    "wait",
    "--fn",
    '!Array.from(document.querySelectorAll("button")).find(b => b.textContent.includes("Replay saved receipt")).disabled',
  );
  await click("Replay saved receipt");
  await browser("dialog", "accept");
  await wait("Receipt recorded.");
  await ready();
  const receipt = (await facts()).returns[0].receipts[0];
  assert.equal((await facts()).returns[0].receipts.length, 1);
  assert.equal(receipt.location_id, receiptLocation);
  assert.equal(receipt.lines[0].quantity, 2);
  assert.equal((await facts()).returns[0].lines[0].receivable_quantity, 1);
  assert.deepEqual(await stock(), before);
  assert.equal(
    (
      await checked<any>(
        rpc("get_order_ledger", { order_id: order.id }, actor.token),
      )
    ).balances.refunded,
    0,
  );
  await browser(
    "eval",
    'if (Object.keys(sessionStorage).some(k => k.includes(":return-receipt:"))) throw Error("Receipt journal retained")',
  );
  await browser("screenshot", "/tmp/admin-receipt.png", "--full");
  await browser("set", "viewport", "390", "844");
  await browser(
    "eval",
    'document.querySelector(".table-wrap").scrollLeft = 10000; if (document.documentElement.scrollWidth > innerWidth) throw Error("Receipt mobile overflow")',
  );
  await browser("screenshot", "/tmp/admin-receipt-mobile.png", "--full");
  await browser("set", "viewport", "1280", "900");
  await checked(
    api(`/rest/v1/locations?id=eq.${receiptLocation}`, {
      service: true,
      method: "PATCH",
      body: { is_active: true },
    }),
  );
  await click("Reload receipt facts");
  await ready();
  await browser("select", "#receipt-location", receiptLocation);
  await browser("fill", "input[type=number]", "1");
  await browser("fill", "#receipt-note", "Second delivery");
  await click("Record receipt");
  await browser("dialog", "accept");
  await wait("Receipt recorded.");
  await wait("No quantities can be received on this return.");
  assert.equal((await facts()).returns[0].receipts.length, 2);
  assert.equal((await facts()).returns[0].lines[0].received_quantity, 3);
  assert.deepEqual(await stock(), before);
  await browser("screenshot", "/tmp/admin-receipt-complete.png", "--full");
  await browser("click", `a[href="/orders/${order.id}/returns"]`);
  await ready();
  await checked(
    rpc(
      "dispose_return_receipt",
      {
        receipt_line_id: receipt.lines[0].id,
        quantity: 1,
        disposition: "discard",
        note: "Damaged item",
        idempotency_key: crypto.randomUUID(),
      },
      actor.token,
    ),
  );
  await click("Reload returns");
  await ready();
  await browser("select", "#return-shipment", second.id);
  await browser("click", "details:first-of-type > summary");
  await wait("Undisposed 1");
  await wait("discard × 1");
  await browser("screenshot", "/tmp/admin-returns.png", "--full");
  await browser("set", "viewport", "390", "844");
  await browser("screenshot", "/tmp/admin-returns-mobile.png", "--full");
  await browser(
    "eval",
    'if (document.documentElement.scrollWidth > innerWidth) throw Error("Mobile page overflow")',
  );
  await browser(
    "eval",
    'const table = document.querySelector(".table-wrap"); table.scrollLeft = table.scrollWidth; if (table.scrollLeft === 0) throw Error("Table not scrollable")',
  );
  await browser("fill", "input[type=number]", "1");
  await browser(
    "screenshot",
    "/tmp/admin-returns-mobile-quantity.png",
    "--full",
  );
  await browser("fill", "input[type=number]", "");
  // Failed reads must not leave an editable stale snapshot.
  await browser(
    "eval",
    `(() => { const original = window.fetch; window.fetch = async (...args) => {
    if (String(args[0]).includes('/rpc/get_order_returns')) { window.fetch = original; return new Response(JSON.stringify({message:'Simulated read failure'}), {status:503,headers:{'Content-Type':'application/json'}}); } return original(...args);
  }; })()`,
  );
  await click("Reload returns");
  await wait("Simulated read failure");
  await browser(
    "eval",
    'if (!document.querySelector("fieldset").disabled) throw Error("Stale form editable")',
  );
  console.log(
    "Return smoke passed: shipment bounds, lost-response replay after reload, no duplicate/stock/refund, receipt/disposition history, mobile, read-failure lock.",
  );
} finally {
  await browser("close").catch(() => {});
  if (receiptLocation)
    await checked(
      api(`/rest/v1/locations?id=eq.${receiptLocation}`, {
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
