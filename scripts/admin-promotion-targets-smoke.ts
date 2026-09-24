// Local-only target replacement regression. All fixtures belong to this run.
import { localSupabase } from "./lib/local-supabase";
const config = localSupabase();
const origin = new URL(process.env.ADMIN_URL ?? "http://127.0.0.1:5174");
if (!["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))
  throw Error("Local admin URL required");
const id = crypto.randomUUID(),
  oversized = crypto.randomUUID(),
  product = crypto.randomUUID(),
  variant = crypto.randomUUID();
const categories = Array.from({ length: 101 }, () => crypto.randomUUID());
const session = `targets-${id}`,
  email = `${session}@example.test`,
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
const wait = (text: string) => browser("wait", "--text", text);
const ready = () =>
  browser(
    "wait",
    "--fn",
    '!!document.querySelector("#targets-form fieldset") && !document.querySelector("#targets-form fieldset").disabled',
  );
const locked = () =>
  browser(
    "eval",
    'if (!document.querySelector("button[form=targets-form]").disabled) throw Error("Saving not locked")',
  );
const read = () =>
  api("/rest/v1/rpc/get_admin_promotion", "POST", { promotion_id: id });
const targets = () =>
  api("/rest/v1/rpc/list_admin_promotion_targets", "POST", {
    promotion_id: id,
    page_size: 100,
  });
const signatures = (rows: any[]) =>
  rows
    .map(
      (row) =>
        `${row.role}:${row.product_id ?? row.category_id ?? row.variant_id}`,
    )
    .sort();
async function save() {
  await click("Save targets");
  await browser("dialog", "accept");
  await wait("Targets saved.");
  await ready();
}
async function reload(discard = false) {
  await click("Reload all targets");
  if (discard) await browser("dialog", "accept");
  await ready();
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
  await api(
    "/rest/v1/categories",
    "POST",
    categories.map((category, index) => ({
      id: category,
      name: `Target ${index}`,
      slug: `${session}-${index}`,
      is_active: false,
    })),
  );
  await api("/rest/v1/products", "POST", {
    id: product,
    name: "Target smoke product",
    slug: session,
    status: "draft",
  });
  await api("/rest/v1/product_variants", "POST", {
    id: variant,
    product_id: product,
    sku: session,
    price: 10,
    track_inventory: false,
  });
  await api("/rest/v1/rpc/create_promotion", "POST", {
    promotion_id: id,
    changes: {
      name: "Smoke targeted buy/get",
      type: "buy_x_get_y",
      params: { buy: 3, get: 2 },
      targets: categories
        .slice(0, 21)
        .map((category_id, index) => ({
          role: index === 20 ? "get" : "apply",
          category_id,
        })),
    },
  });
  await browser("open", `${origin.origin}/promotions/${id}`);
  await browser("wait", "input[type=email]");
  await browser("fill", "input[type=email]", email);
  await browser("fill", "input[type=password]", password);
  await click("Sign in");
  await browser("wait", `a[href="/promotions/${id}/targets"]`);
  await browser("click", `a[href="/promotions/${id}/targets"]`);
  await ready();
  await browser(
    "wait",
    "--fn",
    "document.querySelectorAll('.target-row').length === 21",
  );
  const initial = await targets();
  // A failed second page cannot expose a partial editable snapshot.
  await browser(
    "eval",
    `(() => { const original = window.fetch; window.fetch = async (...args) => {
    if (String(args[0]).includes('/rpc/list_admin_promotion_targets') && JSON.parse(args[1].body).after_id) {
      window.fetch = original; return new Response(JSON.stringify({message:'Simulated page failure'}),{status:503,headers:{'Content-Type':'application/json'}});
    } return original(...args);
  }; })()`,
  );
  await click("Reload all targets");
  await wait("Simulated page failure");
  await locked();
  await reload();
  await browser("select", "#target-kind-0", "product_id");
  await fill("Reference 1", product);
  await click("Add target");
  await browser("select", "#target-role-21", initial.items[0].role);
  await fill("Reference 22", product);
  await click("Save targets");
  await wait("Duplicate target");
  if (JSON.stringify(await targets()) !== JSON.stringify(initial))
    throw Error("Validation wrote targets");
  await click("Remove target 22");
  await save();
  const replaced = await targets();
  const expected = initial.items.map((row: any, index: number) =>
    index === 0 ? { ...row, category_id: null, product_id: product } : row,
  );
  if (
    JSON.stringify(signatures(replaced.items)) !==
    JSON.stringify(signatures(expected))
  )
    throw Error("Cross-page targets lost");
  if ((await read()).is_active) throw Error("Target save activated promotion");
  // Save a new gift variant, but lose the acknowledgement after commit.
  await click("Add target");
  await browser("select", "#target-role-21", "get");
  await browser("select", "#target-kind-21", "variant_id");
  const picker = '.target-row:has(#target-kind-21) .picker';
  await browser("click", `${picker} summary`);
  await browser("fill", `${picker} input[type=search]`, session);
  await browser("click", `${picker} .fields button`);
  await browser("wait", `${picker} button.choice`);
  await browser("click", `${picker} button.choice`);
  await browser("wait", `${picker} .section-heading`);
  await browser("click", `${picker} button.choice`);
  await browser("eval", `if(document.querySelector('#target-reference-21')?.value !== ${JSON.stringify(variant)} && ![...document.querySelectorAll('.target-row:has(#target-kind-21) input')].some(input=>input.value===${JSON.stringify(variant)})) throw Error('Variant picker returned the product ID or wrong variant');`);
  await browser("screenshot", "/tmp/admin-target-picker.png");
  await browser(
    "eval",
    `(() => { const original = window.fetch; window.fetch = async (...args) => {
    const response = await original(...args);
    if (String(args[0]).includes('/rpc/update_promotion') && response.ok) { window.fetch=original; await response.text(); throw new TypeError('Simulated lost response'); }
    return response;
  }; })()`,
  );
  await click("Save targets");
  await browser("dialog", "accept");
  await wait("replacement may have succeeded");
  await locked();
  const committed = await targets();
  const committedRule = await read();
  if (
    committed.items.length !== 22 ||
    !committed.items.some(
      (row: any) => row.role === "get" && row.variant_id === variant,
    )
  )
    throw Error("Lost-response write incorrect");
  await browser("reload");
  await ready();
  if (
    (await read()).revision !== committedRule.revision ||
    JSON.stringify(await targets()) !== JSON.stringify(committed)
  )
    throw Error("Reload repeated replacement");
  // Concurrent rule edits invalidate a previously read complete target set.
  await api("/rest/v1/rpc/update_promotion", "POST", {
    promotion_id: id,
    expected_revision: committedRule.revision,
    changes: { priority: -17 },
  });
  await click("Remove target 1");
  await click("Save targets");
  await browser("dialog", "accept");
  await wait("Another edit changed");
  await locked();
  if (JSON.stringify(await targets()) !== JSON.stringify(committed))
    throw Error("Stale target replacement succeeded");
  await browser("set", "viewport", "1440", "1000");
  await browser("eval", "window.scrollTo(0,0)");
  await browser("screenshot", "/tmp/admin-targets-conflict.png");
  await reload(true);
  await click("Clear all targets");
  await browser("dialog", "accept");
  await save();
  let saved = await read();
  if (
    (await targets()).items.length ||
    saved.apply_scope !== "selected" ||
    saved.get_scope !== "selected"
  )
    throw Error("Empty selected expanded");
  await browser("screenshot", "/tmp/admin-targets-empty.png");
  await browser("select", "#apply-scope", "all");
  await browser("select", "#get-scope", "same_as_apply");
  await save();
  saved = await read();
  if (saved.apply_scope !== "all" || saved.get_scope !== "same_as_apply")
    throw Error("Explicit expansion failed");
  for (const [index, role, kind, reference] of [
    [0, "apply", "product_id", product],
    [1, "get", "variant_id", variant],
    [2, "apply", "category_id", categories[0]],
  ] as const) {
    await click("Add target");
    await browser("select", `#target-role-${index}`, role);
    await browser("select", `#target-kind-${index}`, kind);
    await fill(`Reference ${index + 1}`, reference!);
  }
  await save();
  saved = await read();
  if (
    (await targets()).items.length !== 3 ||
    saved.apply_scope !== "selected" ||
    saved.get_scope !== "selected" ||
    saved.is_active
  )
    throw Error("New selected set incorrect");
  await browser("eval", "window.scrollTo(0,0)");
  await browser("screenshot", "/tmp/admin-targets-editor.png", "--full");
  await browser("set", "viewport", "390", "844");
  await browser(
    "eval",
    'document.querySelector(".target-row").scrollIntoView()',
  );
  await browser(
    "eval",
    'if (document.documentElement.scrollWidth>innerWidth) throw Error("Mobile overflow")',
  );
  await browser("screenshot", "/tmp/admin-targets-mobile.png");
  // Legacy sets over the atomic command's limit must never be truncated.
  await api("/rest/v1/rpc/create_promotion", "POST", {
    promotion_id: oversized,
    changes: {
      name: "Oversized target fixture",
      type: "item_percentage",
      params: { percent: 10 },
    },
  });
  await api(
    "/rest/v1/promotion_targets",
    "POST",
    categories.map((category_id) => ({
      promotion_id: oversized,
      role: "apply",
      category_id,
    })),
  );
  await browser("open", `${origin.origin}/promotions/${oversized}/targets`);
  await wait("More than 100 targets");
  await locked();
  await browser("set", "viewport", "1440", "1000");
  await browser("screenshot", "/tmp/admin-targets-oversized.png");
  console.log(
    "Target smoke passed: full 21-row snapshot, failed-page lock, duplicate rejection, both-role replacement, lost-response reload, stale revision, selected-empty and explicit expansion, all reference types, 101-row refusal, mobile.",
  );
} catch (cause) {
  await browser("screenshot", "/tmp/admin-targets-failure.png");
  throw cause;
} finally {
  const failures: unknown[] = [];
  for (const cleanup of [
    () => browser("close"),
    () => api(`/rest/v1/promotions?id=in.(${id},${oversized})`, "DELETE"),
    () => api(`/rest/v1/products?id=eq.${product}`, "DELETE"),
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
    throw new AggregateError(failures, "Target smoke cleanup failed");
}
