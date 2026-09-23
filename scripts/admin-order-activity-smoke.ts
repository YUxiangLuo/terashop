// Real local login/order read; deterministic browser-only activity fixtures.
// No order, payment or refund writes. Only the temporary Auth account is created/deleted.
import { localSupabase } from "./lib/local-supabase";
const config = localSupabase();
const origin = new URL(process.env.ADMIN_URL ?? "http://127.0.0.1:5174");
if (!["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))
  throw Error("Local admin URL required");
const session = `activity-${crypto.randomUUID()}`;
const email = `${session}@example.test`,
  password = crypto.randomUUID() + "Aa1!";
let user = "";
async function api(path: string, method: string, body?: unknown) {
  const response = await fetch(`${config.API_URL}${path}`, {
    method,
    headers: {
      apikey: config.SERVICE_ROLE_KEY,
      Authorization: `Bearer ${config.SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw Error(`Fixture API failed (${response.status})`);
  return response.status === 204 ? null : response.json();
}
async function browser(...args: string[]) {
  const proc = Bun.spawn(["agent-browser", "--session", session, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw Error(`Browser ${args[0]} failed: ${stderr || stdout}`);
}
const click = (name: string) =>
  browser("find", "role", "button", "click", "--name", name, "--exact");
const panel = 'section[aria-label="Order activity"]';
const ready = () =>
  browser(
    "wait",
    "--fn",
    `!!document.querySelector('${panel} select') && !document.querySelector('${panel} select').disabled`,
  );
const select = async (kind: string) => {
  await browser("select", `${panel} select`, kind);
  await ready();
};
try {
  const orders = await api("/rest/v1/rpc/list_admin_orders", "POST", {
    page_size: 1,
  });
  const id = orders.items[0]?.id;
  if (!id)
    throw Error(
      "A local fixture order is required (run order database tests first).",
    );
  user = (
    await api("/auth/v1/admin/users", "POST", {
      email,
      password,
      email_confirm: true,
    })
  ).id;
  await api(`/rest/v1/profiles?id=eq.${user}`, "PATCH", { role: "admin" });
  await browser("open", `${origin.origin}/orders/${id}`);
  await browser("wait", "input[type=email]");
  await browser("fill", "input[type=email]", email);
  await browser("fill", "input[type=password]", password);
  await click("Sign in");
  await ready();
  for (const kind of [
    "events",
    "payment_intent",
    "refund_request",
    "money_movement",
  ]) {
    await select(kind);
    await browser(
      "eval",
      `if(document.querySelector('${panel} [role=alert]')) throw Error('Real activity read failed');`,
    );
  }
  await select("events");
  // First load uses the real authenticated event RPC. Subsequent reads exercise
  // precision, paging, empty/error states and redaction with asymmetric fixtures.
  await browser(
    "eval",
    `(() => {
    const original = window.fetch;
    window.activityRequests = [];
    window.failActivity = false;
    window.fetch = async (input, init) => {
      const url = String(input);
      if (!url.endsWith('/rpc/list_admin_order_events') && !url.endsWith('/rpc/list_admin_payment_operations')) return original(input, init);
      const args = JSON.parse(init.body);
      window.activityRequests.push(args);
      if (window.failActivity) return new Response(JSON.stringify({message:'Fixture read failure', code:'XX000'}), {status:500, headers:{'Content-Type':'application/json'}});
      const base = {order_id:args.order_id, created_at:'2026-09-20T12:34:56.123456Z'};
      let items, next_cursor = null;
      if (url.endsWith('/rpc/list_admin_order_events')) {
        const event = { ...base, actor_id:null, type:'custom.<b>literal</b>', data:{secret:'DO-NOT-EXPOSE'} };
        items = args.type_filter ? [] : [{...event, id:args.after_id ? '9007199254740993' : '9007199254740995'}];
        next_cursor = !args.type_filter && !args.after_id ? '9007199254740995' : null;
      } else {
        const common = {...base, id:'00000000-0000-4000-8000-000000000001', provider:'paypal', amount:'19.49', currency:'USD', status:'processing', metadata:{secret:'DO-NOT-EXPOSE'}, failure_message:'DO-NOT-EXPOSE'};
        if (args.kind === 'payment_intent') items = [{...common, payment_method:'card', provider_poll_attempts:0}];
        if (args.kind === 'refund_request') items = [{...common, status:'requested', source:'custom_amount', restock_requested:true, has_error:true, provider_poll_attempts:3}];
        if (args.kind === 'money_movement') items = [{...common, kind:'refund', amount:'1234567890.12345678', currency:'EUR', reconciliation_status:'action_required', has_error:true}];
      }
      return new Response(JSON.stringify({order_id:args.order_id,kind:args.kind,items,next_cursor}), {headers:{'Content-Type':'application/json'}});
    };
  })()`,
  );
  await click("Refresh activity");
  await browser("wait", '[data-record-id="9007199254740995"]');
  await click("Load more activity");
  await browser("wait", '[data-record-id="9007199254740993"]');
  await browser(
    "eval",
    `if (window.activityRequests.at(-1).after_id !== '9007199254740995') throw Error('Event cursor lost precision'); if (document.querySelector('${panel} b')) throw Error('Event type interpreted as HTML');`,
  );
  await browser("set", "viewport", "1440", "1000");
  await browser("eval", `document.querySelector('${panel}').scrollIntoView()`);
  await browser("screenshot", "/tmp/admin-order-events.png");
  await browser("fill", `${panel} input`, " Custom.Test ");
  await click("Filter events");
  await ready();
  await browser(
    "eval",
    `if (window.activityRequests.at(-1).type_filter !== ' Custom.Test ' || window.activityRequests.at(-1).after_id) throw Error('Filter changed or cursor retained'); if(document.querySelector('${panel} tbody tr')) throw Error('Stale events remain');`,
  );
  await select("payment_intent");
  await browser("wait", "--text", "19.49 USD");
  await select("refund_request");
  await browser("wait", "--text", "Restock requested: Yes");
  await browser("click", `${panel} summary`);
  await browser("eval", `document.querySelector('${panel}').scrollIntoView()`);
  await browser("screenshot", "/tmp/admin-order-refunds.png");
  await select("money_movement");
  await browser("wait", "--text", "1234567890.12345678 EUR");
  await browser(
    "eval",
    `if(window.activityRequests.at(-1).after_id || window.activityRequests.at(-1).type_filter) throw Error('Category switch retained filters'); if(document.querySelector('${panel}').innerText.includes('DO-NOT-EXPOSE')) throw Error('Private field leaked');`,
  );
  await browser("eval", `document.querySelector('${panel}').scrollIntoView()`);
  await browser("screenshot", "/tmp/admin-order-payments.png");
  await browser("set", "viewport", "390", "844");
  await browser("eval", `document.querySelector('${panel}').scrollIntoView()`);
  await browser("screenshot", "/tmp/admin-order-activity-mobile.png");
  await browser(
    "eval",
    `(() => { const table = document.querySelector('${panel} .table-wrap'); table.scrollLeft = 330; if (!table.scrollLeft || document.documentElement.scrollWidth > innerWidth) throw Error('Mobile scroll containment failed'); })()`,
  );
  await browser("screenshot", "/tmp/admin-order-activity-mobile-amount.png");
  await browser("eval", "window.failActivity = true");
  await click("Refresh activity");
  await browser("wait", `${panel} [role=alert]`);
  await browser("eval", `document.querySelector('${panel}').scrollIntoView()`);
  await browser("screenshot", "/tmp/admin-order-activity-error.png");
  await browser(
    "eval",
    `if(document.querySelector('${panel} .empty')) throw Error('Read failure reported as empty'); window.failActivity = false;`,
  );
  await click("Retry activity read");
  await browser("wait", "--text", "1234567890.12345678 EUR");
  console.log(
    "Order activity browser passed: real login/order/events read; mocked exact cursor, literal event text, filters, category reset, exact non-USD amount, redaction, error/retry, desktop/mobile.",
  );
} finally {
  try {
    await browser("close");
  } finally {
    if (user) await api(`/auth/v1/admin/users/${user}`, "DELETE");
  }
}
