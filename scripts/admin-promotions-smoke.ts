// Local browser regression; writes only disposable rules/categories/account.
import { localSupabase } from "./lib/local-supabase";
const config = localSupabase();
const origin = new URL(process.env.ADMIN_URL ?? "http://127.0.0.1:5174");
if (!["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))
  throw Error("Local admin URL required");
const id = crypto.randomUUID(),
  session = `promotion-${id}`;
const name = `Smoke promotion ${id.slice(0, 8)}`;
const email = `${session}@example.test`,
  password = crypto.randomUUID() + "Aa1!";
const ids = [id],
  categories = Array.from({ length: 21 }, () => crypto.randomUUID());
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
const fill = (label: string, value: string) =>
  browser("find", "label", label, "fill", value, "--exact");
const select = async (label: string, value: string) => {
  const selector = {
    "Rule type": "#promotion-type, #promotion-type-filter",
    "Record type": "#promotion-record-kind",
    "Target role": "#promotion-target-role",
    Enabled: "#promotion-active-filter",
    "Entry mode": "#promotion-code-filter",
  }[label];
  if (!selector) throw Error(`Unknown select ${label}`);
  await browser("select", selector, value);
  await browser(
    "eval",
    `if (document.querySelector(${JSON.stringify(selector)}).value !== ${JSON.stringify(value)}) throw Error('Selection did not persist')`,
  );
};
const wait = (text: string) => browser("wait", "--text", text);
const read = (promotion_id = id) =>
  api("/rest/v1/rpc/get_admin_promotion", "POST", { promotion_id });
const targetRead = () =>
  api("/rest/v1/rpc/list_admin_promotion_targets", "POST", {
    promotion_id: id,
    page_size: 100,
  });
const ready = () =>
  browser(
    "wait",
    "--fn",
    '!!document.querySelector("#promotion-form fieldset") && !document.querySelector("#promotion-form fieldset").disabled',
  );
async function save(confirm = false) {
  await click("Save promotion");
  if (confirm) await browser("dialog", "accept");
  await wait("Promotion saved.");
}
try {
  user = (
    await api("/auth/v1/admin/users", "POST", {
      email,
      password,
      email_confirm: true,
    })
  ).id;
  await api(`/rest/v1/profiles?id=eq.${user}`, "PATCH", { role: "admin" });
  await browser(
    "open",
    `${origin.origin}/promotions/${id}?new=1&search=${encodeURIComponent(name)}`,
  );
  await browser("wait", "input[type=email]");
  await browser("fill", "input[type=email]", email);
  await browser("fill", "input[type=password]", password);
  await click("Sign in");
  await ready();
  await fill("Name", name);
  await fill("Discount (%)", "11");
  await browser("focus", "#promotion-type");
  await browser("press", "End");
  await browser("press", "Tab");
  await browser(
    "wait",
    "--fn",
    "document.querySelector('#promotion-type').value === 'free_shipping'",
  );
  await select("Rule type", "item_percentage");
  await fill("Discount (%)", "100.01");
  await click("Save promotion");
  await wait("cannot exceed 100");
  if (await read()) throw Error("Invalid percentage created promotion");
  await fill("Discount (%)", "17.5");
  await fill("Minimum matching quantity", "3");
  await fill("Discount code", `smoke-${id}`);
  await fill("Starts at", "2099-10-01T09:00:00.123456+08:00");
  await fill("Ends at", "2099-10-31T23:59:59+08:00");
  await fill("Total usage limit", "9");
  await fill("Per-customer code limit", "2");
  await browser(
    "eval",
    `(() => { const original = window.fetch; window.fetch = async (...args) => {
    const response = await original(...args);
    if (String(args[0]).includes('/rpc/create_promotion') && response.ok) {
      window.fetch = original; await response.text(); throw new TypeError('Simulated lost acknowledgement');
    } return response;
  }; })()`,
  );
  await click("Save promotion");
  await wait("Reload the promotion and review");
  await browser(
    "eval",
    'if (!document.querySelector("#promotion-form fieldset").disabled || !document.querySelector("button[form=promotion-form]").disabled) throw Error("Unknown result not locked")',
  );
  let saved = await read();
  if (
    saved.params.percent !== 17.5 ||
    saved.params.min_quantity !== 3 ||
    saved.is_active ||
    saved.code !== `SMOKE-${id.toUpperCase()}` ||
    !saved.starts_at.includes(".123456")
  )
    throw Error("Created values incorrect");
  await browser("reload");
  await ready();
  if ((await read()).revision !== saved.revision)
    throw Error("Reload wrote promotion again");
  // Install >1 page of targets, then prove a UI edit never replaces even unseen rows.
  await api(
    "/rest/v1/categories",
    "POST",
    categories.map((category, index) => ({
      id: category,
      name: `${name} ${index}`,
      slug: `${session}-${index}`,
      is_active: false,
    })),
  );
  saved = await api("/rest/v1/rpc/update_promotion", "POST", {
    promotion_id: id,
    expected_revision: saved.revision,
    changes: {
      params: { ...saved.params, retained: { note: "keep" } },
      targets: categories.map((category_id) => ({
        role: "apply",
        category_id,
      })),
    },
  });
  const targets = await targetRead();
  await click("Reload promotion");
  await ready();
  await browser(
    "wait",
    "--fn",
    "document.querySelectorAll('tbody tr').length === 20",
  );
  await fill("Discount (%)", "23.75");
  await save();
  const changed = await read();
  if (
    changed.params.percent !== 23.75 ||
    changed.params.retained?.note !== "keep" ||
    changed.starts_at !== saved.starts_at ||
    changed.apply_scope !== "selected"
  )
    throw Error("Edit lost preserved data");
  if (JSON.stringify(await targetRead()) !== JSON.stringify(targets))
    throw Error("Targets were replaced or truncated");
  await browser(
    "wait",
    "--fn",
    "document.querySelectorAll('tbody tr').length === 20",
  );
  await click("More records");
  await browser(
    "wait",
    "--fn",
    "document.querySelectorAll('tbody tr').length === 21",
  );
  await select("Target role", "get");
  await wait("No targets found.");
  await fill("Name", `${name} edited`);
  await select("Record type", "redemptions");
  await wait("No redemptions found.");
  await browser(
    "eval",
    `if (document.querySelector('#promotion-form input').value !== ${JSON.stringify(`${name} edited`)}) throw Error('Record switch discarded edits')`,
  );
  await select("Record type", "targets");
  await select("Target role", "apply");
  await browser(
    "wait",
    "--fn",
    "document.querySelectorAll('tbody tr').length === 20",
  );
  saved = await read();
  await api("/rest/v1/rpc/update_promotion", "POST", {
    promotion_id: id,
    expected_revision: saved.revision,
    changes: { priority: -19 },
  });
  await click("Save promotion");
  await wait("Reload the promotion and review");
  await browser(
    "eval",
    'if (!document.querySelector("#promotion-form fieldset").disabled) throw Error("Conflict not locked")',
  );
  if ((await read()).name !== name || (await read()).priority !== -19)
    throw Error("Stale overwrite");
  await browser("set", "viewport", "1440", "1100");
  await browser("eval", "window.scrollTo(0,0)");
  await browser("screenshot", "/tmp/admin-promotion-conflict.png");
  await click("Reload promotion");
  await browser("dialog", "accept");
  await ready();
  await browser(
    "find",
    "role",
    "checkbox",
    "check",
    "--name",
    "Enabled",
    "--exact",
  );
  await save(true);
  if (!(await read()).is_active) throw Error("Activation failed");
  await browser("screenshot", "/tmp/admin-promotion-editor.png");
  await browser(
    "eval",
    `[...document.querySelectorAll('h2')].find(el => el.textContent.includes('Target scope')).scrollIntoView()`,
  );
  await browser("screenshot", "/tmp/admin-promotion-targets.png");
  await browser("set", "viewport", "390", "844");
  await browser(
    "eval",
    'document.querySelector("#promotion-form").scrollIntoView()',
  );
  await browser(
    "eval",
    'if (document.documentElement.scrollWidth > innerWidth) throw Error("Mobile overflow")',
  );
  await browser("screenshot", "/tmp/admin-promotion-mobile.png");
  await browser(
    "eval",
    'document.querySelectorAll("#promotion-form section")[1].scrollIntoView()',
  );
  await browser("screenshot", "/tmp/admin-promotion-limits-mobile.png");
  await browser("set", "viewport", "1440", "1100");
  await browser(
    "find",
    "role",
    "checkbox",
    "click",
    "--name",
    "Enabled",
    "--exact",
  );
  await fill("Discount code", "");
  await fill("Starts at", "");
  await fill("Ends at", "");
  await fill("Total usage limit", "");
  await fill("Minimum matching quantity", "");
  await save(true);
  saved = await read();
  if (
    saved.is_active ||
    saved.code !== null ||
    saved.starts_at !== null ||
    saved.ends_at !== null ||
    saved.usage_limit !== null ||
    "min_quantity" in saved.params
  )
    throw Error("Clear/deactivate failed");
  // Exercise the other four forms, checking independently specified API values.
  for (const [type, entries, expected] of [
    [
      "order_percentage",
      [
        ["Discount (%)", "12.5"],
        ["Minimum merchandise subtotal (USD)", "42.75"],
      ],
      { percent: 12.5, threshold: 42.75 },
    ],
    ["order_fixed", [["Discount amount (USD)", "3.49"]], { amount: 3.49 }],
    [
      "buy_x_get_y",
      [
        ["Buy quantity", "3"],
        ["Get quantity", "2"],
        ["Gift discount (%)", "25"],
      ],
      { buy: 3, get: 2, get_percent: 25 },
    ],
    ["free_shipping", [], {}],
  ] as [string, string[][], Record<string, number>][]) {
    const other = crypto.randomUUID();
    ids.push(other);
    await browser(
      "open",
      `${origin.origin}/promotions/${other}?new=1&search=${encodeURIComponent(name)}`,
    );
    await ready();
    await fill("Name", `${name} ${type}`);
    await select("Rule type", type);
    for (const [label, value] of entries) await fill(label!, value!);
    await save();
    const result = await read(other);
    if (
      result.type !== type ||
      result.is_active ||
      Object.keys(result.params).length !== Object.keys(expected).length ||
      Object.entries(expected).some(
        ([key, value]) => result.params[key] !== value,
      )
    )
      throw Error(`Wrong ${type} params`);
    await browser("screenshot", `/tmp/admin-promotion-${type}.png`);
  }
  await browser("click", 'a[href^="/promotions?"]');
  await browser(
    "wait",
    "--fn",
    "document.querySelectorAll('tbody tr').length === 5",
  );
  await select("Rule type", "item_percentage");
  await select("Enabled", "no");
  await select("Entry mode", "no");
  await click("Apply filters");
  await browser(
    "wait",
    "--fn",
    "location.search.includes('type=item_percentage') && location.search.includes('active=no') && location.search.includes('code=no') && document.querySelectorAll('tbody tr').length === 1",
  );
  await browser("screenshot", "/tmp/admin-promotion-list.png");
  console.log(
    "Promotion smoke passed: five rule types, invalid input, lost-create recovery, exact dates/unknown params preserved, 21 targets untouched, pagination/role switch, stale-write lock, enable/disable/null clearing, filters, desktop/mobile.",
  );
} catch (cause) {
  await browser("screenshot", "/tmp/admin-promotion-failure.png");
  throw cause;
} finally {
  const failures: unknown[] = [];
  for (const cleanup of [
    () => browser("close"),
    () => api(`/rest/v1/promotions?id=in.(${ids.join(",")})`, "DELETE"),
    () => api(`/rest/v1/categories?id=in.(${categories.join(",")})`, "DELETE"),
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
    throw new AggregateError(failures, "Smoke cleanup failed");
}
