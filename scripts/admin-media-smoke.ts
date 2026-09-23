// Real local Auth/DB/Storage; an ephemeral HTTP host runs the production Edge
// handler so browser CORS and lost receipts can be tested without changing secrets.
import assert from "node:assert/strict";
import { SQL } from "bun";
import { localSupabase } from "./lib/local-supabase";
import { handleManagedMedia } from "../supabase/functions/managed-media/handler";

const config = localSupabase();
const origin = new URL(process.env.ADMIN_URL ?? "http://127.0.0.1:5174");
if (!["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))
  throw Error("Local Admin URL required");
const env: Record<string, string> = {
  SUPABASE_URL: config.API_URL,
  SUPABASE_ANON_KEY: config.ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: config.SERVICE_ROLE_KEY,
  MEDIA_ALLOWED_ORIGINS: origin.origin,
};
Object.defineProperty(globalThis, "Deno", {
  value: { env: { get: (key: string) => env[key] } },
  configurable: true,
});
const db = new SQL(config.DB_URL, { max: 1 });
const product = crypto.randomUUID();
const session = `media-${product}`;
const email = `${session}@example.test`,
  password = crypto.randomUUID() + "Aa1!";
let user = "";
const requests = new Set<string>();
const calls: string[] = [];
const host = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.method === "POST") {
      const body = await request.clone().json();
      calls.push(body.action);
      if (body.action === "upload") requests.add(body.request_id);
    }
    return handleManagedMedia(request);
  },
});
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
async function capture(path: string, selector = ".upload") {
  await browser(
    "eval",
    `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'})`,
  );
  await browser("screenshot", path);
}
const selectFile = () =>
  browser(
    "eval",
    `(() => {
  const bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+X9kAAAAASUVORK5CYII='), c=>c.charCodeAt(0));
  const input=document.querySelector('input[type=file]');
  if(input.matches(':disabled')) throw Error('Upload disabled');
  const files=new DataTransfer();files.items.add(new File([bytes],'fixture.png',{type:'image/png'}));
  input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}));
})()`,
  );
async function route(loss: "upload" | "publish" | "none") {
  await browser(
    "eval",
    `(() => {
    const original=window.fetch.bind(window);let lost=false;
    window.fetch=async (input,init)=>{
      const request=new Request(input,init);
      if(!request.url.includes('/functions/v1/managed-media'))return original(input,init);
      const action=JSON.parse(await request.clone().text()).action;
      const response=await original(${JSON.stringify(host.url.href)}, {method:request.method,headers:request.headers,body:await request.text()});
      if(!lost && action===${JSON.stringify(loss)} && response.ok){lost=true;throw Error('Lost successful receipt');}
      return response;
    };
  })()`,
  );
}
const readProduct = () =>
  api("/rest/v1/rpc/get_admin_product", "POST", { product_id: product });
try {
  user = (
    await api("/auth/v1/admin/users", "POST", {
      email,
      password,
      email_confirm: true,
    })
  ).id;
  await api(`/rest/v1/profiles?id=eq.${user}`, "PATCH", { role: "admin" });
  await api("/rest/v1/products", "POST", {
    id: product,
    slug: session,
    name: "Managed media test product",
    status: "draft",
  });
  await browser("open", `${origin.origin}/products/${product}`);
  await browser("wait", "input[type=email]");
  await browser("fill", "input[type=email]", email);
  await browser("fill", "input[type=password]", password);
  await click("Sign in");
  await browser("wait", "input[type=file]:enabled");
  await route("upload");
  await selectFile();
  await wait("Media request failed or its response was lost");
  assert.deepEqual(calls, ["upload"]);
  const requestId = [...requests][0];
  assert.ok(requestId);
  const [staged] =
    await db`select id, state, published from private.managed_media where request_id=${requestId}::uuid`;
  assert.equal(staged.state, "staged");
  assert.equal(staged.published, false);
  assert.equal((await readProduct()).images.length, 0);
  const publicUrl = `${config.API_URL}/storage/v1/object/public/catalog-media/managed/${staged.id}.png`;
  assert.equal((await fetch(publicUrl)).ok, false);
  await capture("/tmp/admin-media-uncertain.png");
  await browser("reload");
  await wait("Media state: staged");
  assert.deepEqual(calls, ["upload"], "Reload must not repeat the upload");
  await route("publish");
  await capture("/tmp/admin-media-staged.png");
  await click("Publish image permanently");
  await browser("dialog", "dismiss");
  assert.deepEqual(calls, ["upload"], "Dismissed publication must not write");
  await click("Publish image permanently");
  await browser("dialog", "accept");
  await wait("Media request failed or its response was lost");
  assert.deepEqual(calls, ["upload", "publish"]);
  await browser("reload");
  await wait("Media state: retained · public");
  assert.deepEqual(calls, ["upload", "publish"], "Reload must not republish");
  assert.equal((await fetch(publicUrl)).ok, true);
  assert.equal(
    (await readProduct()).images.length,
    0,
    "Publication is not attachment",
  );
  await click("Add published image to form");
  await click("Add published image to form");
  await browser(
    "eval",
    `if(document.querySelectorAll('.image-row').length!==1)throw Error('Duplicate attachment'); if(!Object.keys(sessionStorage).some(k=>k.startsWith('tera-admin-media:')))throw Error('Recovery cleared before save')`,
  );
  // Lose unsaved association on navigation; the upload must still be recoverable.
  await click("Reload saved version");
  await browser("dialog", "accept");
  await wait("Media state: retained · public");
  await browser(
    "eval",
    `if(document.querySelectorAll('.image-row').length!==0)throw Error('Unsaved association persisted')`,
  );
  await click("Add published image to form");
  await browser("set", "viewport", "390", "844");
  await capture("/tmp/admin-media-published-mobile.png");
  await browser(
    "eval",
    `if(document.documentElement.scrollWidth>innerWidth)throw Error('Mobile overflow')`,
  );
  await click("Save product");
  await wait("Product saved as draft");
  await browser("wait", "input[type=file]:enabled");
  await browser(
    "eval",
    `if(Object.keys(sessionStorage).some(k=>k.startsWith('tera-admin-media:')))throw Error('Confirmed recovery record retained')`,
  );
  const saved = await readProduct();
  assert.equal(saved.images.length, 1);
  assert.equal(saved.images[0].url, publicUrl);
  assert.equal(saved.images[0].id, staged.id);
  await browser("set", "viewport", "1280", "1000");
  await capture(
    "/tmp/admin-media-saved.png",
    "#product-form .editor-main > section:last-child",
  );
  console.log(
    "PASS: private staging, CORS, lost upload/publication receipts, reload, explicit publication, attachment deduplication and save recovery",
  );
} finally {
  await browser("close").catch(() => {});
  await host.stop(true);
  await api(`/rest/v1/product_images?product_id=eq.${product}`, "DELETE");
  await api(`/rest/v1/products?id=eq.${product}`, "DELETE");
  for (const request of requests) {
    const rows =
      await db`select id from private.managed_media where request_id=${request}::uuid`;
    for (const { id } of rows) {
      for (const [bucket, path] of [
        ["media-staging", `${id}.png`],
        ["catalog-media", `managed/${id}.png`],
      ])
        await api(`/storage/v1/object/${bucket}`, "DELETE", {
          prefixes: [path],
        });
    }
    await db`delete from private.managed_media where request_id=${request}::uuid`;
  }
  if (user) await api(`/auth/v1/admin/users/${user}`, "DELETE");
  await db.close();
}
