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
const extras = Array.from({ length: 21 }, () => crypto.randomUUID()).sort();
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
  await wait("Live category updates connected.");
  // A visible expanded branch must discover new rows without a page remount.
  await api(
    "/rest/v1/categories",
    "POST",
    extras.map((id, i) => ({
      id,
      parent_id: parent,
      name: `Live child ${i}`,
      slug: `${prefix}-${i}`,
      is_active: false,
    })),
  );
  await wait("Live child 0");
  const parentRow = `document.querySelector('a[href="/categories/${parent}"]').closest('li')`;
  await browser(
    "wait",
    "--fn",
    `![...${parentRow}.querySelectorAll('p')].some(p=>p.textContent.includes('Loading categories'))`,
  );
  await browser(
    "eval",
    `[...${parentRow}.querySelectorAll('button')].find(b=>b.textContent.includes('Load more categories')).click()`,
  );
  await wait("Live child 20");
  await browser(
    "wait",
    "--fn",
    `!document.body.innerText.includes('Loading categories…')`,
  );
  // Fail page two: page one's new values must not replace the old complete result.
  await browser(
    "eval",
    `(() => {
    const send=window.fetch; let fail=true;
    window.fetch=async (...args)=>{
      const body=typeof args[1]?.body==='string' ? JSON.parse(args[1].body) : {};
      if(String(args[0]).includes('/list_admin_categories') && body.parent_id===${JSON.stringify(parent)} && body.after_id && fail){
        fail=false; return new Response('{}',{status:503});
      }
      return send(...args);
    };
  })()`,
  );
  await api(`/rest/v1/categories?id=in.(${extras[0]},${extras[20]})`, "PATCH", {
    name: "Live renamed child",
  });
  await wait("Displayed categories may be stale.");
  await browser(
    "eval",
    `(() => {
    const row=${parentRow};
    if(!row.textContent.includes('Live child 0') || !row.textContent.includes('Live child 20') || row.textContent.includes('Live renamed child') || !row.querySelector('[aria-expanded=true]'))throw Error('Refresh discarded pages or expansion');
  })()`,
  );
  await browser("screenshot", "/tmp/admin-category-live-error.png", "--full");
  await click("Retry categories");
  await browser(
    "wait",
    "--fn",
    `[...${parentRow}.querySelectorAll('a.record-link')].filter(a=>a.textContent==='Live renamed child').length===2 && !document.body.innerText.includes('Loading categories…')`,
  );
  await browser("set", "viewport", "390", "844");
  await browser(
    "eval",
    `if(document.documentElement.scrollWidth>innerWidth)throw Error('Live tree overflow')`,
  );
  await browser("screenshot", "/tmp/admin-category-live-mobile.png", "--full");
  await browser("set", "viewport", "1440", "1000");
  // Moving a row out must remove it from the expanded branch on the next reread.
  await api(`/rest/v1/categories?id=eq.${extras[20]}`, "PATCH", {
    parent_id: null,
  });
  await browser(
    "wait",
    "--fn",
    `!${parentRow}.querySelector('a[href="/categories/${extras[20]}"]')`,
  );
  await api(`/rest/v1/categories?id=in.(${extras.join(",")})`, "DELETE");
  await browser(
    "wait",
    "--fn",
    `!document.body.innerText.includes('Live child') && !document.body.innerText.includes('Live renamed child') && !document.body.innerText.includes('Loading categories…')`,
  );
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
  // Live results use applied URL filters, without discarding an unsubmitted search.
  await wait("Live category updates connected.");
  await browser("fill", "input[type=search]", "Unsubmitted search");
  await api(`/rest/v1/categories?id=eq.${parent}`, "PATCH", {
    is_active: true,
  });
  await wait("Smoke parent");
  await browser(
    "eval",
    `if(document.querySelector('input[type=search]').value!=='Unsubmitted search' || !location.search.includes('active=yes'))throw Error('Live refresh replaced filter draft or URL')`,
  );
  await api(`/rest/v1/categories?id=eq.${parent}`, "PATCH", {
    is_active: false,
  });
  await browser(
    "wait",
    "--fn",
    `!document.body.innerText.includes('Smoke parent') && document.body.innerText.includes('Smoke child')`,
  );
  await browser("click", `a[href^="/categories/${child}"]`);
  await browser("wait", "#category-form");
  // Concurrent writer must not be overwritten by the stale form.
  await browser("fill", "textarea", "Stale edit");
  await api("/rest/v1/rpc/update_category", "POST", {
    category_id: child,
    expected_updated_at: created.updated_at,
    changes: { description: "Concurrent edit" },
  });
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
    "Category browser smoke passed: live expanded tree, multi-page atomic refresh/retry, live move/removal, filter draft retention, create, parent/status/position, stale-write lock, explicit reload, root move, product picker selection retention.",
  );
} finally {
  const failures: unknown[] = [];
  for (const cleanup of [
    () => browser("close"),
    () => api(`/rest/v1/categories?id=in.(${extras.join(",")})`, "DELETE"),
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
