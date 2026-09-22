// Local browser regression. Only this run's temporary method and account are written.
import { localSupabase } from "./lib/local-supabase";
const config = localSupabase();
const origin = new URL(process.env.ADMIN_URL ?? "http://127.0.0.1:5174");
if (!["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))
  throw Error("Local admin URL required");
const id = crypto.randomUUID(),
  session = `shipping-${id}`;
const name = `Smoke shipping ${id.slice(0, 8)}`;
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
  if (code !== 0)
    throw Error(
      `Browser ${args[0]}${args[0] === "wait" ? ` ${args.slice(1).join(" ")}` : ""} failed: ${stderr || stdout}`,
    );
}
const click = (name: string) =>
  browser("find", "role", "button", "click", "--name", name, "--exact");
const fill = (label: string, value: string) =>
  browser("find", "label", label, "fill", value, "--exact");
const wait = (text: string) => browser("wait", "--text", text);
const read = () =>
  api("/rest/v1/rpc/get_admin_shipping_method", "POST", {
    shipping_method_id: id,
  });
const ready = () =>
  browser(
    "wait",
    "--fn",
    '!!document.querySelector("#shipping-form fieldset") && !document.querySelector("#shipping-form fieldset").disabled',
  );
async function save(confirm = false) {
  await click("Save shipping method");
  if (confirm) await browser("dialog", "accept");
  await wait("Shipping method saved.");
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
    `${origin.origin}/shipping/${id}?new=1&search=${encodeURIComponent(name)}`,
  );
  await browser("wait", "input[type=email]");
  await browser("fill", "input[type=email]", email);
  await browser("fill", "input[type=password]", password);
  await click("Sign in");
  await ready();
  await fill("Name", name);
  await fill("Shipping price (USD)", "1.005");
  await click("Save shipping method");
  await wait("at most two decimal places");
  if (await read()) throw Error("Invalid price created method");
  await fill("Shipping price (USD)", "4.99");
  await fill("Free shipping threshold (USD)", "0");
  await fill("Country codes", "us, ca");
  await fill("Display position", "-7");
  await fill("Estimated delivery", "3–5 business days");
  await save();
  let saved = await read();
  if (
    saved.price !== 4.99 ||
    saved.free_above !== 0 ||
    saved.is_active ||
    saved.position !== -7 ||
    !saved.countries.includes("US") ||
    !saved.countries.includes("CA")
  )
    throw Error("Create values incorrect");
  // Reopening the original new=1 URL must recover the saved record, not create again.
  await browser("reload");
  await ready();
  await browser(
    "wait",
    "--fn",
    `document.querySelector('input[placeholder="No threshold"]').value === "0.00"`,
  );
  await browser("click", 'a[href^="/shipping?"]');
  await wait(name);
  await fill("Destination country", "DE");
  await click("Apply filters");
  await wait("No shipping methods found.");
  await fill("Destination country", "us");
  await click("Apply filters");
  await wait(name);
  await browser("click", `a[href^="/shipping/${id}"]`);
  await ready();
  await fill("Country codes", "");
  await fill("Free shipping threshold (USD)", "19.49");
  await browser("check", "input[type=checkbox]");
  await save(true);
  saved = await read();
  if (!saved.is_active || saved.countries.length || saved.free_above !== 19.49)
    throw Error("Worldwide activation/threshold failed");
  await browser("set", "viewport", "1440", "1000");
  await browser("screenshot", "/tmp/admin-shipping-editor.png");
  await browser("set", "viewport", "390", "844");
  await browser("screenshot", "/tmp/admin-shipping-mobile.png");
  await browser(
    "eval",
    'document.querySelectorAll("#shipping-form section")[1].scrollIntoView()',
  );
  await browser("screenshot", "/tmp/admin-shipping-pricing-mobile.png");
  await browser("set", "viewport", "1440", "1000");
  await browser("eval", "window.scrollTo(0, 0)");
  await api("/rest/v1/rpc/update_shipping_method", "POST", {
    shipping_method_id: id,
    expected_revision: saved.revision,
    changes: { price: 9.87 },
  });
  await fill("Description", "Stale description");
  await click("Save shipping method");
  await browser("dialog", "accept");
  await browser("wait", "[role=alert]");
  await browser(
    "eval",
    'if (!document.querySelector("#shipping-form input").matches(":disabled") || !document.querySelector("button[form=shipping-form]").disabled) throw Error("Conflict not locked")',
  );
  if (
    (await read()).price !== 9.87 ||
    (await read()).description === "Stale description"
  )
    throw Error("Concurrent write overwritten");
  await browser("screenshot", "/tmp/admin-shipping-conflict.png");
  await click("Reload shipping method");
  await browser("dialog", "accept");
  await ready();
  await fill("Free shipping threshold (USD)", "");
  await browser("uncheck", "input[type=checkbox]");
  await save(true);
  saved = await read();
  if (saved.free_above !== null || saved.is_active || saved.price !== 9.87)
    throw Error("Clear/deactivation lost current price");
  await browser("click", 'a[href^="/shipping?"]');
  await wait(name);
  await fill("Destination country", "DE");
  await browser("select", "select", "no");
  await click("Apply filters");
  await browser(
    "wait",
    "--fn",
    `location.search.includes("country=DE") && location.search.includes("active=no") && document.body.innerText.includes(${JSON.stringify(name)})`,
  );
  await browser("screenshot", "/tmp/admin-shipping-list.png");
  console.log(
    "Shipping smoke passed: amount rejection, create/reload identity, zero/null threshold, country filtering and worldwide scope, activation, stale-write lock/reload, deactivation, URL filters.",
  );
} catch (cause) {
  await browser("screenshot", "/tmp/admin-shipping-failure.png");
  throw cause;
} finally {
  const failures: unknown[] = [];
  for (const cleanup of [
    () => browser("close"),
    () => api(`/rest/v1/shipping_methods?id=eq.${id}`, "DELETE"),
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
