// Local regression: only this run's rules/account are written and then deleted.
import { localSupabase } from "./lib/local-supabase";
const config = localSupabase();
const origin = new URL(process.env.ADMIN_URL ?? "http://127.0.0.1:5174");
if (!["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))
  throw Error("Local admin URL required");
const id = crypto.randomUUID(),
  fallback = crypto.randomUUID();
const session = `tax-${id}`,
  name = `Smoke tax ${id.slice(0, 8)}`;
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
const fill = (label: string, value: string) =>
  browser("find", "label", label, "fill", value, "--exact");
const wait = (text: string) => browser("wait", "--text", text);
const read = () =>
  api("/rest/v1/rpc/get_admin_tax_rate", "POST", { tax_rate_id: id });
const ready = () =>
  browser(
    "wait",
    "--fn",
    '!!document.querySelector("#tax-form fieldset") && !document.querySelector("#tax-form fieldset").disabled',
  );
const locked = () =>
  browser(
    "eval",
    'if (!document.querySelector("#tax-form fieldset").disabled || !document.querySelector("button[form=tax-form]").disabled) throw Error("Write not locked")',
  );
async function save(confirm = false) {
  await click("Save tax rate");
  if (confirm) await browser("dialog", "accept");
  await wait("Tax rate saved.");
}
try {
  // Pick an unused fictional code without changing any existing active rule.
  const active = (await api(
    "/rest/v1/tax_rates?is_active=eq.true&select=country",
    "GET",
  )) as { country: string }[];
  const country = ["ZZ", "ZY", "ZX", "ZW", "ZV"].find(
    (code) => !active.some((rule) => rule.country === code),
  );
  if (!country) throw Error("No unused smoke country");
  user = (
    await api("/auth/v1/admin/users", "POST", {
      email,
      password,
      email_confirm: true,
    })
  ).id;
  await api(`/rest/v1/profiles?id=eq.${user}`, "PATCH", { role: "admin" });
  await api("/rest/v1/rpc/create_tax_rate", "POST", {
    tax_rate_id: fallback,
    changes: { name: `${name} fallback`, country: "*", rate: 0.0875 },
  });
  await browser(
    "open",
    `${origin.origin}/taxes/${id}?new=1&search=${encodeURIComponent(name)}`,
  );
  await browser("wait", "input[type=email]");
  await browser("fill", "input[type=email]", email);
  await browser("fill", "input[type=password]", password);
  await click("Sign in");
  await ready();
  await fill("Name", name);
  await fill("Country code", country.toLowerCase());
  await fill("Tax rate (%)", "13.001");
  await click("Save tax rate");
  await wait("at most two decimal places");
  if (await read()) throw Error("Invalid percentage created rule");
  await fill("Tax rate (%)", "7.25");
  // Lose the acknowledgement after the actual create commits.
  await browser(
    "eval",
    `(() => { const original = window.fetch; window.fetch = async (...args) => {
    const response = await original(...args);
    if (String(args[0]).includes('/rpc/create_tax_rate') && response.ok) {
      window.fetch = original; await response.text(); throw new TypeError('Simulated lost acknowledgement');
    } return response;
  }; })()`,
  );
  await click("Save tax rate");
  await wait("Reload the tax rate before another save");
  await locked();
  let saved = await read();
  if (
    saved.rate !== 0.0725 ||
    saved.is_active ||
    saved.include_shipping ||
    saved.country !== country
  )
    throw Error("Create values incorrect");
  await browser("reload");
  await ready();
  await browser(
    "wait",
    "--fn",
    `document.querySelector('input[placeholder="13.00"]').value === '7.25'`,
  );
  if ((await read()).revision !== saved.revision)
    throw Error("Reload recreated or edited rule");
  await browser(
    "find",
    "role",
    "checkbox",
    "check",
    "--name",
    "Tax net shipping charges",
    "--exact",
  );
  await browser(
    "find",
    "role",
    "checkbox",
    "check",
    "--name",
    "Active rule",
    "--exact",
  );
  await save(true);
  saved = await read();
  if (!saved.is_active || !saved.include_shipping || saved.rate !== 0.0725)
    throw Error("Activation incorrect");
  await browser("set", "viewport", "1440", "1000");
  await browser("screenshot", "/tmp/admin-tax-editor.png");
  await browser("set", "viewport", "390", "844");
  await browser("eval", 'document.querySelector("#tax-form").scrollIntoView()');
  await browser(
    "eval",
    'if (document.documentElement.scrollWidth > innerWidth) throw Error("Mobile overflow")',
  );
  await browser("screenshot", "/tmp/admin-tax-mobile.png");
  await browser("set", "viewport", "1440", "1000");
  await browser("eval", "window.scrollTo(0,0)");
  await api("/rest/v1/rpc/update_tax_rate", "POST", {
    tax_rate_id: id,
    expected_revision: saved.revision,
    changes: { rate: 0.0935 },
  });
  await fill("Name", `${name} stale`);
  await click("Save tax rate");
  await browser("dialog", "accept");
  await wait("Reload the tax rate before another save");
  await locked();
  if ((await read()).rate !== 0.0935 || (await read()).name !== name)
    throw Error("Concurrent edit overwritten");
  await browser("screenshot", "/tmp/admin-tax-conflict.png");
  await click("Reload tax rate");
  await browser("dialog", "accept");
  await ready();
  await fill("Tax rate (%)", "0");
  await save(true);
  if ((await read()).rate !== 0 || !(await read()).is_active)
    throw Error("Explicit active zero lost");
  await browser(
    "find",
    "role",
    "checkbox",
    "click",
    "--name",
    "Active rule",
    "--exact",
  );
  await save(true);
  if ((await read()).is_active) throw Error("Deactivation failed");
  await browser("click", 'a[href^="/taxes?"]');
  await wait(`${name} fallback`);
  await fill("Country code", country);
  await click("Apply filters");
  await browser(
    "wait",
    "--fn",
    `document.querySelectorAll('tbody tr').length === 1 && document.querySelector('tbody').innerText.includes(${JSON.stringify(name)}) && !document.querySelector('tbody').innerText.includes('fallback')`,
  );
  await fill("Country code", "*");
  await browser("select", "select", "no");
  await click("Apply filters");
  await browser(
    "wait",
    "--fn",
    `location.search.includes('country=*') && location.search.includes('active=no') && document.querySelectorAll('tbody tr').length === 1 && document.querySelector('tbody').innerText.includes('fallback')`,
  );
  await browser("screenshot", "/tmp/admin-tax-list.png");
  console.log(
    "Tax smoke passed: exact percentage conversion, lost-create recovery, activation, shipping tax, stale-write lock/reload, active zero, deactivation, exact country/fallback and URL filters, mobile layout.",
  );
} catch (cause) {
  await browser("screenshot", "/tmp/admin-tax-failure.png");
  throw cause;
} finally {
  const failures: unknown[] = [];
  for (const cleanup of [
    () => browser("close"),
    () => api(`/rest/v1/tax_rates?id=in.(${id},${fallback})`, "DELETE"),
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
