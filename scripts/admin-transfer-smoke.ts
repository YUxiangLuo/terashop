// Local-only real transfer, with a deliberately lost response after commit.
// Owned product/warehouses are archived/deactivated; immutable stock audit remains.
import { localSupabase } from "./lib/local-supabase";
const config = localSupabase();
const origin = new URL(process.env.ADMIN_URL ?? "http://127.0.0.1:5174");
if (!["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))
  throw Error("Local admin URL required");
const product = crypto.randomUUID(),
  variant = crypto.randomUUID(),
  from = crypto.randomUUID(),
  to = crypto.randomUUID();
const session = `transfer-${product}`,
  email = `${session}@example.test`,
  password = crypto.randomUUID() + "Aa1!";
let user = "",
  token = "";
async function api(
  path: string,
  method: string,
  body?: unknown,
  asAdmin = false,
) {
  const response = await fetch(`${config.API_URL}${path}`, {
    method,
    headers: {
      apikey: config.SERVICE_ROLE_KEY,
      Authorization: `Bearer ${asAdmin ? token : config.SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok)
    throw Error(`Fixture API ${path} failed (${response.status})`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
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
const ready = () =>
  browser(
    "wait",
    "--fn",
    '!!document.querySelector("#transfer-form fieldset") && !document.querySelector("#transfer-form fieldset").disabled',
  );
const levels = () =>
  api(
    `/rest/v1/inventory_levels?variant_id=eq.${variant}&select=location_id,on_hand`,
    "GET",
  );
const adjust = (delta: number) =>
  api(
    "/rest/v1/rpc/adjust_inventory",
    "POST",
    {
      variant_id: variant,
      location_id: from,
      delta,
      note: "Realtime smoke",
      idempotency_key: crypto.randomUUID(),
    },
    true,
  );
try {
  user = (
    await api("/auth/v1/admin/users", "POST", {
      email,
      password,
      email_confirm: true,
    })
  ).id;
  await api(`/rest/v1/profiles?id=eq.${user}`, "PATCH", { role: "admin" });
  token = (
    await api("/auth/v1/token?grant_type=password", "POST", { email, password })
  ).access_token;
  await api("/rest/v1/products", "POST", {
    id: product,
    slug: session,
    name: "Transfer smoke product",
    status: "draft",
  });
  await api("/rest/v1/product_variants", "POST", {
    id: variant,
    product_id: product,
    sku: session,
    price: 10,
    track_inventory: true,
  });
  for (const [id, name, stock] of [
    [from, "Smoke source", 11],
    [to, "Smoke destination", 2],
  ] as const) {
    await api("/rest/v1/rpc/create_location", "POST", {
      location_id: id,
      changes: { code: id, name, is_active: true },
    });
    await api(
      "/rest/v1/rpc/adjust_inventory",
      "POST",
      {
        variant_id: variant,
        location_id: id,
        delta: stock,
        note: "Disposable browser fixture",
        idempotency_key: crypto.randomUUID(),
      },
      true,
    );
  }
  await browser("open", `${origin.origin}/inventory?product=${product}`);
  await browser("wait", "input[type=email]");
  await browser("fill", "input[type=email]", email);
  await browser("fill", "input[type=password]", password);
  await click("Sign in");
  await browser("wait", "--text", "Live stock notifications connected.");
  await browser(
    "wait",
    "--fn",
    `!!document.querySelector('[aria-label="Inventory"] select') && !document.querySelector('[aria-label="Inventory"] fieldset').disabled`,
  );
  await browser(
    "select",
    '[aria-label="Inventory"] .fields.two label:last-child select',
    from,
  );
  await browser(
    "wait",
    "--fn",
    `document.querySelector('[aria-label="Inventory"] .metrics dd')?.textContent==='11'`,
  );
  await browser("fill", '[aria-label="Inventory"] input[type=number]', "2");
  await browser(
    "eval",
    `(() => {
    const send=window.fetch;
    window.fetch=async (...args)=>{
      const result=await send(...args);
      if(String(args[0]).endsWith('/rpc/adjust_inventory') && result.ok){await result.text(); window.fetch=send; throw Error('Lost committed adjustment');}
      return result;
    };
  })()`,
  );
  await click("Confirm stock adjustment");
  await browser("dialog", "accept");
  await browser("wait", "--text", "Unresolved stock operation");
  const stockKey = `tera-admin-command:${user}:stock:${product}`;
  await browser(
    "eval",
    `window.savedStock=sessionStorage.getItem(${JSON.stringify(stockKey)})`,
  );
  await adjust(-2);
  await browser("wait", "--text", "Inventory may have changed.");
  await click("Refresh stock");
  await browser(
    "wait",
    "--fn",
    `document.querySelector('[aria-label="Inventory"] .metrics dd')?.textContent==='11'`,
  );
  await browser(
    "eval",
    `if(sessionStorage.getItem(${JSON.stringify(stockKey)})!==window.savedStock || !document.querySelector('[aria-label="Inventory"] fieldset').disabled)throw Error('Notification resolved or changed pending adjustment')`,
  );
  await browser("screenshot", "/tmp/admin-stock-live-pending.png");
  await click("Retry saved adjustment");
  await browser("dialog", "accept");
  await browser("wait", "--text", "Stock adjustment confirmed.");
  if (
    (await levels()).find(
      (r: { location_id: string }) => r.location_id === from,
    ).on_hand !== 11
  )
    throw Error("Adjustment replay duplicated stock");
  await browser("open", `${origin.origin}/inventory/transfer/${product}`);
  await ready();
  await browser("select", "#transfer-form .two label:first-child select", from);
  await ready();
  await browser("select", "#transfer-form .two label:last-child select", from);
  await ready();
  await browser(
    "eval",
    'if (!document.querySelector("#transfer-form button").disabled) throw Error("Same warehouse allowed")',
  );
  await browser("select", "#transfer-form .two label:last-child select", to);
  await ready();
  await browser("fill", "input[type=number]", "12");
  await click("Confirm transfer");
  await browser("wait", "--text", "within source availability");
  if (
    (await levels()).find(
      (r: { location_id: string }) => r.location_id === from,
    ).on_hand !== 11
  )
    throw Error("Invalid transfer moved stock");
  await browser("fill", "input[type=number]", "4");
  await browser("fill", "textarea", "Move four units to destination");
  await browser("wait", "--text", "Live stock notifications connected.");
  await adjust(1);
  await browser("wait", "--text", "Inventory may have changed.");
  await click("Refresh balances");
  await ready();
  await browser(
    "eval",
    `if(document.querySelector('input[type=number]').value!=='4' || document.querySelector('textarea').value!=='Move four units to destination' || !document.querySelector('[data-testid="transfer-balances"]').textContent.includes('12 on hand'))throw Error('Live refresh discarded transfer draft')`,
  );
  await adjust(-1);
  await click("Refresh balances");
  await ready();
  await browser("set", "viewport", "1440", "1000");
  await browser("screenshot", "/tmp/admin-transfer-form.png");
  await browser(
    "eval",
    `(() => {
    const original = window.fetch;
    window.fetch = async (input, init) => {
      const result = await original(input, init);
      if (String(input).endsWith('/rpc/transfer_inventory') && result.ok) {
        await result.text(); window.fetch = original;
        throw Error('Simulated response loss after commit');
      }
      return result;
    };
  })()`,
  );
  await click("Confirm transfer");
  await browser("dialog", "accept");
  await browser("wait", "--text", "Result unknown");
  const moved = await levels();
  if (
    moved.find((r: { location_id: string }) => r.location_id === from)
      .on_hand !== 7 ||
    moved.find((r: { location_id: string }) => r.location_id === to).on_hand !==
      6
  )
    throw Error("Atomic transfer balances incorrect");
  const key = `tera-admin-command:${user}:transfer:${product}`;
  await browser(
    "eval",
    `(() => { const pending = JSON.parse(sessionStorage.getItem(${JSON.stringify(key)})); if (pending.quantity !== 4 || pending.from_location_id !== ${JSON.stringify(from)} || !document.querySelector('#transfer-form fieldset').disabled) throw Error('Pending command not locked'); })()`,
  );
  await browser("screenshot", "/tmp/admin-transfer-pending.png");
  await browser("wait", "--text", "Inventory may have changed.");
  await browser(
    "eval",
    `window.savedTransfer=sessionStorage.getItem(${JSON.stringify(key)})`,
  );
  await click("Refresh balances");
  await browser(
    "wait",
    "--fn",
    `![...document.querySelectorAll('button')].find(b=>b.textContent==='Refresh balances').disabled`,
  );
  await browser(
    "eval",
    `if(sessionStorage.getItem(${JSON.stringify(key)})!==window.savedTransfer || !document.querySelector('#transfer-form fieldset').disabled)throw Error('Refresh changed pending transfer')`,
  );
  // The committed request must replay even after its destination is deactivated.
  await api(`/rest/v1/locations?id=eq.${to}`, "PATCH", { is_active: false });
  await browser("reload");
  await browser(
    "wait",
    "--fn",
    '[...document.querySelectorAll("button")].some(b => b.textContent.includes("Retry saved transfer") && !b.disabled)',
  );
  await click("Retry saved transfer");
  await browser("dialog", "accept");
  await browser("wait", "--text", "Transfer confirmed");
  if (JSON.stringify(await levels()) !== JSON.stringify(moved))
    throw Error("Replay moved stock again");
  const movements = await api(
    `/rest/v1/inventory_movements?variant_id=eq.${variant}&reason=in.(transfer_out,transfer_in)&select=transfer_id,delta`,
    "GET",
  );
  if (
    movements.length !== 2 ||
    movements[0].transfer_id !== movements[1].transfer_id ||
    movements.reduce((n: number, r: { delta: number }) => n + r.delta, 0) !== 0
  )
    throw Error("Transfer movements not paired exactly once");
  await browser(
    "eval",
    `if (sessionStorage.getItem(${JSON.stringify(key)}) !== null) throw Error('Confirmed journal not cleared')`,
  );
  await browser("screenshot", "/tmp/admin-transfer-confirmed.png");
  await browser("set", "viewport", "390", "844");
  await browser("screenshot", "/tmp/admin-transfer-mobile.png");
  console.log(
    "Transfer browser passed: same-warehouse/availability rejection, real atomic movement, lost-response journal, reload, replay after deactivation, no duplicate movements, cleanup.",
  );
} finally {
  const failures: unknown[] = [];
  for (const cleanup of [
    () => browser("close"),
    () =>
      api(`/rest/v1/products?id=eq.${product}`, "PATCH", {
        status: "archived",
      }),
    () =>
      api(`/rest/v1/locations?id=in.(${from},${to})`, "PATCH", {
        is_active: false,
      }),
    async () => {
      if (user) await api(`/auth/v1/admin/users/${user}`, "DELETE");
    },
  ]) {
    try {
      await cleanup();
    } catch (cause) {
      failures.push(cause);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "Fixture cleanup failed");
}
