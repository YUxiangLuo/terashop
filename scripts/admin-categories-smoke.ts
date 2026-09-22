// Run against the local admin dev server: bun scripts/admin-categories-smoke.ts
// Requires agent-browser. Creates and removes only this run's disposable fixtures.
import { localSupabase } from "./lib/local-supabase";
const config = localSupabase();
const origin = new URL(process.env.ADMIN_URL ?? "http://127.0.0.1:5174");
if (!["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))
  throw Error("Local admin URL required");
const suffix = crypto.randomUUID();
const parent = crypto.randomUUID(),
  child = crypto.randomUUID();
const session = `categories-${suffix}`;
let user = "";
const password = crypto.randomUUID() + "Aa1!";
const email = `categories-${suffix}@example.test`;
const prefix = `smoke-${suffix}`;
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
  return stdout.trim();
}
const click = (name: string) =>
  browser("find", "role", "button", "click", "--name", name, "--exact");
const wait = (text: string) => browser("wait", "--text", text);
const read = () =>
  api("/rest/v1/rpc/get_admin_category", "POST", { category_id: child });
try {
  user = (
    await api("/auth/v1/admin/users", "POST", {
      email,
      password,
      email_confirm: true,
    })
  ).id;
  await api(`/rest/v1/profiles?id=eq.${user}`, "PATCH", { role: "admin" });
  await api("/rest/v1/rpc/create_category", "POST", {
    category_id: parent,
    changes: {
      name: "Smoke parent",
      slug: `${prefix}-parent`,
      is_active: false,
    },
  });
  await browser(
    "open",
    `${origin.origin}/categories/${child}?new=1&search=${prefix}`,
  );
  await browser("wait", "input[type=email]");
  await browser("fill", "input[type=email]", email);
  await browser("fill", "input[type=password]", password);
  await click("Sign in");
  await browser("wait", "#category-form");
  await browser(
    "fill",
    "#category-form section:first-child > label:first-of-type input",
    "Smoke child",
  );
  await browser("fill", "input[pattern]", `${prefix}-child`);
  await browser("fill", "input[type=number]", "-5");
  await browser("check", "#category-form input[type=checkbox]");
  await browser(
    "fill",
    "#category-form input[type=search]",
    `${prefix}-parent`,
  );
  await click("Search parents");
  await browser("wait", "input[type=radio]");
  await browser("check", "input[type=radio]");
  await click("Save category");
  await browser("dialog", "accept");
  await wait("Category saved.");
  const created = await read();
  if (
    created.parent_id !== parent ||
    !created.is_active ||
    created.position !== -5
  )
    throw Error("Create did not preserve parent/status/position");
  await browser("set", "viewport", "1440", "1000");
  await browser("screenshot", "/tmp/admin-category-editor.png");
  await browser("set", "viewport", "390", "844");
  await browser("screenshot", "/tmp/admin-category-mobile.png");
  await browser("set", "viewport", "1440", "1000");
  await browser("open", `${origin.origin}/categories`);
  await browser("wait", ".category-node");
  while (
    (await browser(
      "eval",
      `!!document.querySelector('a[href="/categories/${parent}"]')`,
    )) !== "true"
  ) {
    await click("Load more categories");
    await browser(
      "wait",
      "--fn",
      '!document.body.innerText.includes("Loading categories…")',
    );
  }
  await click("Show children of Smoke parent");
  await wait("Smoke child");
  await browser("screenshot", "/tmp/admin-category-tree.png");
  await browser(
    "open",
    `${origin.origin}/categories/${child}?search=${prefix}`,
  );
  await browser("wait", "#category-form");
  // Search must find an active child of an inactive parent and preserve the URL on return.
  await browser("click", 'a[href^="/categories?"]');
  await wait("Smoke child");
  await browser("select", "select", "yes");
  await click("Apply filters");
  await browser(
    "wait",
    "--fn",
    'location.search.includes("active=yes") && document.body.innerText.includes("Smoke child") && !document.body.innerText.includes("Smoke parent")',
  );
  await browser("screenshot", "/tmp/admin-category-filter.png");
  await browser("click", `a[href^="/categories/${child}"]`);
  await browser("wait", "#category-form");
  // Concurrent writer must not be overwritten by the stale form.
  await api("/rest/v1/rpc/update_category", "POST", {
    category_id: child,
    expected_updated_at: created.updated_at,
    changes: { description: "Concurrent edit" },
  });
  await browser("fill", "textarea", "Stale edit");
  await click("Save category");
  await browser("wait", "[role=alert]");
  await browser(
    "eval",
    'if (!document.querySelector("#category-form fieldset").disabled) throw Error("Stale editor not locked")',
  );
  if ((await read()).description !== "Concurrent edit")
    throw Error("Concurrent edit overwritten");
  await click("Reload category");
  await browser("dialog", "accept");
  await browser(
    "wait",
    "--fn",
    'document.querySelector("textarea")?.value === "Concurrent edit" && !document.querySelector("#category-form fieldset").disabled',
  );
  await click("Move to root");
  await click("Save category");
  await browser("dialog", "accept");
  await wait("Category saved.");
  if ((await read()).parent_id !== null) throw Error("Move to root failed");
  // A new, unsaved product can discover and select the newly created category.
  await browser(
    "open",
    `${origin.origin}/products/${crypto.randomUUID()}?new=1`,
  );
  await browser("wait", 'section[aria-label="Product categories"]');
  await browser(
    "fill",
    'section[aria-label="Product categories"] input[type=search]',
    `${prefix}-child`,
  );
  await click("Search categories");
  await browser(
    "wait",
    'section[aria-label="Product categories"] input[type=checkbox]',
  );
  await browser(
    "check",
    'section[aria-label="Product categories"] input[type=checkbox]',
  );
  await browser("wait", 'button[aria-label="Unassign Smoke child"]');
  await browser(
    "fill",
    'section[aria-label="Product categories"] input[type=search]',
    `${prefix}-parent`,
  );
  await click("Search categories");
  await wait("Smoke parent · Inactive");
  await browser("wait", 'button[aria-label="Unassign Smoke child"]');
  console.log(
    "Category browser smoke passed: create, parent/status/position, tree expansion, URL filters, stale-write lock, explicit reload, root move, product picker selection retention.",
  );
} finally {
  const failures: unknown[] = [];
  for (const cleanup of [
    () => browser("close"),
    () => api(`/rest/v1/categories?id=eq.${child}`, "DELETE"),
    () => api(`/rest/v1/categories?id=eq.${parent}`, "DELETE"),
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
