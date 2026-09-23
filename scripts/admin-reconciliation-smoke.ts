// Real local login/RPC read, then browser-only diagnostic fixtures. No money writes.
import { localSupabase } from "./lib/local-supabase";
Object.assign(process.env, localSupabase());
const { api, checked } = await import("../tests/helpers");
const origin = new URL(process.env.ADMIN_URL ?? "http://127.0.0.1:5174");
if (!["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))
  throw Error("Local admin URL required");
const session = `reconciliation-${crypto.randomUUID()}`,
  email = `${session}@example.test`,
  password = crypto.randomUUID() + "Aa1!";
let user = "";
async function browser(...args: string[]) {
  const proc = Bun.spawn(["agent-browser", "--session", session, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code) throw Error(`Browser ${args[0]} failed: ${err || out}`);
}
const click = (name: string) =>
  browser("find", "role", "button", "click", "--name", name, "--exact");
const wait = (text: string) => browser("wait", "--text", text);
try {
  user = (
    await checked<{ id: string }>(
      api("/auth/v1/admin/users", {
        service: true,
        method: "POST",
        body: { email, password, email_confirm: true },
      }),
    )
  ).id;
  await checked(
    api(`/rest/v1/profiles?id=eq.${user}`, {
      service: true,
      method: "PATCH",
      body: { role: "admin" },
    }),
  );
  await browser(
    "open",
    `${origin.origin}/reconciliation?status=action_required`,
  );
  await browser("wait", "input[type=email]");
  await browser("fill", "input[type=email]", email);
  await browser("fill", "input[type=password]", password);
  await click("Sign in");
  await wait("loaded · Oldest created first");
  await browser(
    "eval",
    `if(document.querySelector('main [role=alert]'))throw Error('Real RPC failed');if(document.querySelector('#reconciliation-status').value!=='action_required')throw Error('URL status lost')`,
  );
  await browser("reload");
  await wait("loaded · Oldest created first");
  // Verify exact cursor, original precision, failed pagination and safe field rendering.
  await browser(
    "eval",
    `(() => {
    const original=window.fetch;
    window.reconRequests=[];window.failRecon=false;window.emptyRecon=false;
    window.fetch=async (input,init)=>{
      if(!String(input).endsWith('/rpc/list_admin_reconciliation_issues'))return original(input,init);
      const args=JSON.parse(init.body);window.reconRequests.push(args);
      const headers={'Content-Type':'application/json'};
      if(window.failRecon)return new Response(JSON.stringify({message:'Fixture read failure'}),{status:400,headers});
      const row={id:'00000000-0000-4000-8000-000000000001',provider_event_id:'00000000-0000-4000-8000-000000000010',provider:'paypal',kind:'capture',amount:'999999999999.12345678',currency:'EUR',order_id:null,payment_intent_id:null,refund_request_id:null,reconciliation_status:args.status_filter,has_error:true,created_at:'2026-09-20T12:34:56.123456Z',last_error:'DO-NOT-EXPOSE',provider_reference:'DO-NOT-EXPOSE',payload:{secret:'DO-NOT-EXPOSE'}};
      const items=window.emptyRecon ? [] : args.after_cursor ? [{...row,id:'00000000-0000-4000-8000-000000000002',amount:'7.01',currency:'USD',order_id:'00000000-0000-4000-8000-000000000020'}] : [row];
      const next_cursor=!window.emptyRecon&&!args.after_cursor ? {created_at:row.created_at,id:row.id}:null;
      return new Response(JSON.stringify({items,next_cursor}),{headers});
    };
  })()`,
  );
  await click("Refresh issues");
  await wait("999999999999.12345678 EUR");
  await wait("No linked order");
  await browser("eval", "window.failRecon=true");
  await click("More reconciliation issues");
  await wait("Fixture read failure");
  await browser(
    "eval",
    `if(document.querySelectorAll('tbody tr').length!==1)throw Error('Lost rows');window.failRecon=false`,
  );
  await click("Retry reconciliation read");
  await wait("2 loaded");
  await browser(
    "eval",
    `if(window.reconRequests.at(-1).after_cursor.created_at!=='2026-09-20T12:34:56.123456Z'||window.reconRequests.at(-1).after_cursor.id!=='00000000-0000-4000-8000-000000000001')throw Error('Cursor changed');if(document.querySelectorAll('tbody tr').length!==2)throw Error('Duplicate rows');if(document.querySelector('main').textContent.includes('DO-NOT-EXPOSE'))throw Error('Unsafe data exposed');if(!document.querySelector('a[href="/orders/00000000-0000-4000-8000-000000000020"]'))throw Error('Missing order link')`,
  );
  await browser("click", "tbody tr:first-child summary");
  await browser("set", "viewport", "1440", "1000");
  await browser("screenshot", "/tmp/admin-reconciliation.png", "--full");
  await browser("set", "viewport", "390", "844");
  await browser(
    "eval",
    `const table=document.querySelector('.table-wrap');const amount=document.querySelector('.amount');table.scrollLeft=amount.getBoundingClientRect().left-table.getBoundingClientRect().left-8;if(!table.scrollLeft||document.documentElement.scrollWidth>innerWidth)throw Error('Scroll containment failed')`,
  );
  await browser("screenshot", "/tmp/admin-reconciliation-mobile.png", "--full");
  await browser("select", "#reconciliation-status", "unmatched");
  await click("Apply status");
  await wait("1 loaded");
  await browser(
    "eval",
    `if(window.reconRequests.at(-1).status_filter!=='unmatched'||window.reconRequests.at(-1).after_cursor||!location.search.includes('unmatched'))throw Error('Status did not reset cursor')`,
  );
  await browser("eval", "window.failRecon=true");
  await click("Refresh issues");
  await wait("Fixture read failure");
  await browser(
    "eval",
    `if(document.querySelector('main').textContent.includes('No issues found'))throw Error('Failure reported as empty');window.failRecon=false;window.emptyRecon=true`,
  );
  await click("Retry reconciliation read");
  await wait("No issues found for this status");
  await browser("open", `${origin.origin}/reconciliation?status=matched`);
  await wait("Invalid reconciliation status");
  console.log(
    "Reconciliation smoke passed: real authenticated read/deep refresh; fixture exact amounts/cursor, retry preserving rows, safe fields, order links, status reset, empty/error/invalid states, mobile scroll.",
  );
} finally {
  await browser("close").catch(() => {});
  if (user)
    await checked(
      api(`/auth/v1/admin/users/${user}`, { service: true, method: "DELETE" }),
    );
}
