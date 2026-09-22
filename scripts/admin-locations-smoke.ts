// Local only. Does not switch the existing default or change existing warehouses.
import { localSupabase } from "./lib/local-supabase";
const config = localSupabase();
const origin = new URL(process.env.ADMIN_URL ?? "http://127.0.0.1:5174");
if (!["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))
  throw Error("Local admin URL required");
const id = crypto.randomUUID();
const session = `locations-${id}`;
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
  if (!response.ok)
    throw Error(`Fixture API ${path} failed (${response.status})`);
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
const wait = (text: string) => browser("wait", "--text", text);
const read = () =>
  api("/rest/v1/rpc/get_admin_location", "POST", { location_id: id });
const ready = () =>
  browser(
    "wait",
    "--fn",
    '!!document.querySelector("#location-form fieldset") && !document.querySelector("#location-form fieldset").disabled',
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
  await browser("open", `${origin.origin}/locations/${id}?new=1&search=${id}`);
  await browser("wait", "input[type=email]");
  await browser("fill", "input[type=email]", email);
  await browser("fill", "input[type=password]", password);
  await click("Sign in");
  await ready();
  await browser(
    "fill",
    "#location-form label:first-of-type input",
    "Smoke warehouse",
  );
  await browser("fill", "#location-form label:nth-of-type(2) input", id);
  await browser("fill", "textarea", "{broken");
  await click("Save warehouse");
  await wait("Address must be valid JSON");
  if (await read()) throw Error("Invalid JSON created a warehouse");
  const address = {
    city: "Tokyo",
    custom: { dock: 7 },
    lines: ["North", "Level 2"],
  };
  await browser("fill", "textarea", JSON.stringify(address));
  await click("Save warehouse");
  await wait("Warehouse saved.");
  let saved = await read();
  if (saved.is_active || saved.is_default || saved.address.custom.dock !== 7)
    throw Error("Create defaults/address incorrect");
  await browser("check", "input[type=checkbox]");
  await click("Save warehouse");
  await browser("dialog", "accept");
  await wait("Warehouse saved.");
  saved = await read();
  if (!saved.is_active || saved.address.lines[1] !== "Level 2")
    throw Error("Activation lost address");
  await browser("set", "viewport", "1440", "1000");
  await browser("screenshot", "/tmp/admin-warehouse-editor.png");
  await browser("set", "viewport", "390", "844");
  await browser("screenshot", "/tmp/admin-warehouse-mobile.png");
  await browser("set", "viewport", "1440", "1000");
  // Exercise default-command revision protection without changing the real default.
  await api("/rest/v1/rpc/update_location", "POST", {
    location_id: id,
    expected_revision: saved.revision,
    changes: { name: "Concurrent warehouse" },
  });
  await click("Make default warehouse");
  await browser("dialog", "accept");
  await browser("wait", "[role=alert]");
  if ((await read()).is_default) throw Error("Stale default command succeeded");
  await browser(
    "eval",
    'if (!document.querySelector("#location-form fieldset").disabled) throw Error("Conflict not locked")',
  );
  await browser("screenshot", "/tmp/admin-warehouse-conflict.png");
  await click("Reload warehouse");
  await ready();
  await wait("Concurrent warehouse");
  saved = await read();
  await api("/rest/v1/rpc/update_location", "POST", {
    location_id: id,
    expected_revision: saved.revision,
    changes: { name: "Latest warehouse" },
  });
  await browser(
    "fill",
    "#location-form label:first-of-type input",
    "Stale warehouse",
  );
  await click("Save warehouse");
  await browser("wait", "[role=alert]");
  if ((await read()).name !== "Latest warehouse")
    throw Error("Stale edit overwrote concurrent writer");
  await click("Reload warehouse");
  await browser("dialog", "accept");
  await ready();
  await browser("uncheck", "input[type=checkbox]");
  await browser("fill", "textarea", "null");
  await click("Save warehouse");
  await browser("dialog", "accept");
  await wait("Warehouse saved.");
  saved = await read();
  if (saved.is_active || saved.address !== null)
    throw Error("Deactivation/address clear failed");
  await browser("click", 'a[href^="/locations?"]');
  await wait("Latest warehouse");
  await browser("select", "select", "no");
  await click("Apply filters");
  await browser(
    "wait",
    "--fn",
    'location.search.includes("active=no") && document.body.innerText.includes("Latest warehouse")',
  );
  await browser("screenshot", "/tmp/admin-warehouse-list.png");
  const defaults = await api(
    "/rest/v1/locations?is_active=eq.true&is_default=eq.true&select=id",
    "GET",
  );
  if (defaults.length) {
    await browser("open", `${origin.origin}/locations/${defaults[0].id}`);
    await ready();
    await wait("This is the default");
    await browser(
      "eval",
      'if (!document.querySelector("input[type=checkbox]").disabled) throw Error("Default deactivation not blocked")',
    );
    await browser("set", "viewport", "390", "844");
    await browser(
      "eval",
      'document.querySelector(".editor-grid section").scrollIntoView()',
    );
    await browser("screenshot", "/tmp/admin-warehouse-default-mobile.png");
  }
  console.log(
    "Warehouse smoke passed: create, JSON validation/preservation/clear, activation, stale default and edit rejection, explicit reload, deactivation, URL filters.",
  );
} finally {
  const failures: unknown[] = [];
  for (const cleanup of [
    () => browser("close"),
    () => api(`/rest/v1/locations?id=eq.${id}`, "DELETE"),
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
    throw new AggregateError(failures, "Smoke fixture cleanup failed");
}
