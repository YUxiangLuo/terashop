import { localSupabase } from "./lib/local-supabase";
import { strict as assert } from "node:assert";
Object.assign(process.env, localSupabase());
const { api, rpc, checked, TEST_ADDRESS } = await import("../tests/helpers");
const { paymentFixture } = await import("../tests/payment-fixtures");
const origin = new URL(process.env.ADMIN_URL ?? "http://127.0.0.1:5174");
if (!["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))
  throw Error("Local admin URL required");
const session = `quotes-${crypto.randomUUID()}`,
  email = `${session}@example.test`,
  password = crypto.randomUUID() + "Aa1!";
let user = "",
  product = "",
  openQuote = "",
  token = "";
async function browser(...args: string[]) {
  const p = Bun.spawn(["agent-browser", "--session", session, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code) throw Error(`Browser ${args[0]} failed: ${err || out}`);
}
const click = (name: string) =>
  browser("find", "role", "button", "click", "--name", name, "--exact");
const wait = (text: string) => browser("wait", "--text", text);
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
  token = (
    await checked<{ access_token: string }>(
      api("/auth/v1/token?grant_type=password", {
        method: "POST",
        body: { email, password },
      }),
    )
  ).access_token;
  const customerId = await checked<string>(
    rpc("current_customer_id", {}, token),
  );
  const fixture = await paymentFixture({
    userId: user,
    token,
    email,
    customerId,
  });
  product = fixture.productId;
  const quotes: string[] = [];
  for (let i = 0; i < 22; i++) {
    const q = await checked<{ id: string }>(
      rpc(
        "create_checkout_quote",
        {
          items: [{ variant_id: fixture.variantId, quantity: 1 }],
          address: TEST_ADDRESS,
          idempotency_key: crypto.randomUUID(),
        },
        token,
      ),
    );
    openQuote = q.id;
    quotes.push(q.id);
    if (i < 21) {
      await checked(
        rpc(
          "cancel_checkout_quote",
          { quote_id: q.id, reason: "Fixture cancellation" },
          token,
        ),
      );
      openQuote = "";
    }
  }
  const order = await checked<{ id: string }>(
    rpc("create_order_from_quote", { quote_id: openQuote }, token),
  );
  const query = `?customer=${customerId}&status=cancelled&linked=no`;
  await browser("open", `${origin.origin}/quotes${query}`);
  await browser("wait", "input[type=email]");
  await browser("fill", "input[type=email]", email);
  await browser("fill", "input[type=password]", password);
  await click("Sign in");
  await wait("20 loaded");
  await browser(
    "eval",
    `if(document.querySelectorAll('tbody tr').length!==20) throw Error('Wrong first page'); if(document.querySelector('#quote-linked').value!=='no') throw Error('Filter not restored')`,
  );
  // Failed next page must preserve rows and retry the same cursor.
  await browser(
    "eval",
    `(() => {const original=window.fetch; window.fetch=async (...args)=>{if(String(args[0]).includes('/rpc/list_admin_checkout_quotes')){window.fetch=original;return new Response(JSON.stringify({message:'Simulated page failure'}),{status:400,headers:{'Content-Type':'application/json'}});}return original(...args);};})()`,
  );
  await click("More quotes");
  await wait("Simulated page failure");
  await browser(
    "eval",
    `if(document.querySelectorAll('tbody tr').length!==20) throw Error('Lost first page')`,
  );
  await click("Retry quotes");
  await wait("21 loaded");
  await browser(
    "eval",
    `const ids=[...document.querySelectorAll('tbody .record-link')].map(a=>a.textContent.trim());if(JSON.stringify(ids)!==JSON.stringify(${JSON.stringify(quotes.slice(0, 21).sort())})) throw Error('Pagination returned wrong records or order')`,
  );
  await browser("screenshot", "/tmp/admin-quotes-list.png", "--full");
  await browser("select", "#quote-status", "converted");
  await browser("select", "#quote-linked", "yes");
  await click("Apply filters");
  await wait("1 loaded");
  await browser("click", `a.record-link[href^="/quotes/${openQuote}"]`);
  await wait("Historical price snapshot");
  await browser("wait", `a[href="/orders/${order.id}"]`);
  await wait("Effective status: converted");
  await browser("reload");
  await wait("Historical price snapshot");
  const before = await checked<any>(
    rpc("get_admin_checkout_quote", { quote_id: openQuote }, token),
  );
  await browser("screenshot", "/tmp/admin-quote-detail.png", "--full");
  await browser("set", "viewport", "390", "844");
  await browser("screenshot", "/tmp/admin-quote-mobile.png", "--full");
  await browser(
    "eval",
    `if(document.documentElement.scrollWidth>innerWidth) throw Error('Page overflow'); const table=document.querySelector('.table-wrap');if(table.scrollWidth<=table.clientWidth)throw Error('Expected internally scrollable price table')`,
  );
  // Stored state and effective expiry are separate; injected text must remain text.
  await browser(
    "eval",
    `(() => {const original=window.fetch;window.fetch=async (...args)=>{const response=await original(...args);if(!String(args[0]).includes('/rpc/get_admin_checkout_quote') || !response.ok)return response;window.fetch=original;const data=await response.json();data.status='expired';data.is_reserved=false;data.customer_note='<img src=x onerror="window.quoteXss=true">';return new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});};})()`,
  );
  await click("Reload quote");
  await wait("Effective status: expired");
  await wait("Stored status: converted");
  await browser(
    "eval",
    `if(window.quoteXss || document.querySelector('.note img'))throw Error('Untrusted note executed')`,
  );
  await browser("screenshot", "/tmp/admin-quote-expired.png", "--full");
  assert.deepEqual(
    await checked(
      rpc("get_admin_checkout_quote", { quote_id: openQuote }, token),
    ),
    before,
  );
  await browser("open", `${origin.origin}/quotes/${crypto.randomUUID()}`);
  await wait("Quote not found.");
  await browser("open", `${origin.origin}/quotes?customer=invalid`);
  await wait("Enter a valid customer UUID.");
  await browser("open", `${origin.origin}/quotes/${openQuote}/cancel`);
  await wait("Stored status: converted");
  await click("Cancel quote");
  await wait("Enter a cancellation reason");
  await browser("fill", "#quote-cancel-reason", "😀".repeat(500));
  await browser(
    "eval",
    `if(Array.from(document.querySelector('#quote-cancel-reason').value).length!==500)throw Error('Unicode reason truncated');`,
  );
  await click("Cancel quote");
  await browser("dialog", "dismiss");
  await browser("fill", "#quote-cancel-reason", "x".repeat(501));
  await click("Cancel quote");
  await wait("Enter a cancellation reason");
  await browser("fill", "#quote-cancel-reason", "Customer changed plans");
  await browser("screenshot", "/tmp/admin-quote-cancel-mobile.png", "--full");
  // Do not send the first attempt, but lose its response. Keep the exact reason on reload.
  await browser(
    "eval",
    `(() => {const original=window.fetch;window.fetch=async (...args)=>{if(String(args[0]).includes('/rpc/cancel_checkout_quote')){window.fetch=original;throw Error('Simulated offline request');}return original(...args);};})()`,
  );
  await click("Cancel quote");
  await browser("dialog", "accept");
  await wait("Unconfirmed cancellation request");
  await browser("reload");
  await wait("Unconfirmed cancellation request");
  await browser(
    "eval",
    `const reason=document.querySelector('#quote-cancel-reason');if(!reason.disabled || reason.value!=='Customer changed plans')throw Error('Saved reason not locked')`,
  );
  // Commit the retry, then lose both its response and the immediate reconciliation read.
  await browser(
    "eval",
    `(() => {const original=window.fetch;let cancelled=false;window.fetch=async (...args)=>{const url=String(args[0]);if(url.includes('/rpc/cancel_checkout_quote')){const result=await original(...args);if(!result.ok) return result;cancelled=true;throw Error('Lost cancellation response');}if(cancelled && url.includes('/rpc/get_admin_checkout_quote')){window.fetch=original;throw Error('Lost reconciliation read');}return original(...args);};})()`,
  );
  await click("Retry saved cancellation");
  await browser("dialog", "accept");
  await wait("Actions are locked");
  await browser("reload");
  await wait("Cancellation confirmed from current facts");
  await wait("Recorded reason: Customer changed plans");
  await browser(
    "eval",
    `if([...document.querySelectorAll('button')].find(b=>b.textContent==='Cancel quote')?.disabled!==true)throw Error('Terminal action enabled');if(Object.keys(sessionStorage).some(k=>k.includes(':quote-cancel:')))throw Error('Pending command not reconciled');if(document.documentElement.scrollWidth>innerWidth)throw Error('Mobile overflow')`,
  );
  const cancelled = await checked<any>(
    rpc("get_admin_checkout_quote", { quote_id: openQuote }, token),
  );
  assert.equal(cancelled.stored_status, "cancelled");
  assert.equal(cancelled.cancel_reason, "Customer changed plans");
  const storedOrder = await checked<any[]>(
    api(`/rest/v1/orders?id=eq.${order.id}&select=status`, { service: true }),
  );
  assert.equal(storedOrder[0].status, "cancelled");
  await browser("set", "viewport", "1280", "900");
  await browser("screenshot", "/tmp/admin-quote-cancelled.png", "--full");
  console.log(
    "Quotes smoke passed: pagination, filters, details, mobile, cancellation validation, saved reason, retry, lost response and reconciliation read, refresh recovery, linked order cancelled.",
  );
} finally {
  await browser("close").catch(() => {});
  if (openQuote && token)
    await checked(rpc("cancel_checkout_quote", { quote_id: openQuote }, token));
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
