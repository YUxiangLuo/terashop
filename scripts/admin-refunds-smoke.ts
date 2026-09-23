// Local disposable fixtures only. No payment-provider network calls.
import { localSupabase } from "./lib/local-supabase";
import { strict as assert } from "node:assert";
Object.assign(process.env, localSupabase());
const { api, rpc, checked } = await import("../tests/helpers");
const { paymentFixture, fixtureOrder, fixtureIntent, settleIntent } =
  await import("../tests/payment-fixtures");
const origin = new URL(process.env.ADMIN_URL ?? "http://127.0.0.1:5174");
if (!["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))
  throw Error("Local admin URL required");
const session = `refund-${crypto.randomUUID()}`,
  email = `${session}@example.test`,
  password = crypto.randomUUID() + "Aa1!";
let user = "",
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
  await browser("click", `a[href="/orders/${order.id}/refunds"]`);
  await ready();
  await browser("fill", "#refund-amount", "7.251");
  await browser("fill", "#refund-reason", "Offline refund REF-001");
  await browser("check", "#refund-confirm");
  await click("Record manual refund");
  await wait("at most two decimal places");
  assert.equal((await ledger()).refunds.length, 0);
  await browser("fill", "#refund-amount", "7.25");
  await browser(
    "eval",
    `(() => { const original = window.fetch; window.fetch = async (...args) => {
    if (String(args[0]).includes('/rpc/refund_order')) { window.fetch = original; const response = await original(...args); if (!response.ok) return response; return new Response(JSON.stringify({message:'Simulated lost refund response'}), {status:503,headers:{'Content-Type':'application/json'}}); } return original(...args);
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
  await browser("screenshot", "/tmp/admin-refund-online-blocked.png", "--full");
  console.log(
    "Refund smoke passed: exact amount, lost-response replay once, unallocated record, stock/quantities unchanged, stale balance rejected, PayPal read-only, mobile.",
  );
} finally {
  await browser("close").catch(() => {});
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
