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
const wait = async (text: string) => {
  try {
    await browser("wait", "--text", text);
  } catch (cause) {
    throw Error(`Waiting for ${text} failed`, { cause });
  }
};
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
  await browser("open", `${origin.origin}/payment-events?status=failed`);
  await wait("loaded · Newest created first");
  await browser(
    "eval",
    `if(document.querySelector('main [role=alert]'))throw Error('Real Inbox read failed');if(document.querySelector('#inbox-status').value!=='failed')throw Error('Inbox filter lost')`,
  );
  await browser("reload");
  await wait("loaded · Newest created first");
  await browser("select", "#inbox-status", "");
  await click("Apply filters");
  await wait("loaded · Newest created first");
  await browser(
    "eval",
    `(() => {
    const original=window.fetch;window.inboxRequests=[];window.failInbox=false;
    window.fetch=async(input,init)=>{
      if(!String(input).endsWith('/rpc/list_admin_payment_provider_events'))return original(input,init);
      const args=JSON.parse(init.body);window.inboxRequests.push(args);
      const headers={'Content-Type':'application/json'};
      if(window.failInbox)return new Response(JSON.stringify({message:'Inbox read failure'}),{status:400,headers});
      const row={id:'00000000-0000-4000-8000-000000000011',provider:'paypal',provider_event_id:'EVT-TEST',source:'webhook',event_type:'PAYMENT.<b>literal</b>',status:args.status_filter||'failed',livemode:false,resource_type:null,resource_id:null,attempts:25,automatic_retry_exhausted:true,next_attempt_at:'infinity',processed_at:null,occurred_at:'2026-09-20T12:34:56.123456Z',created_at:'2026-09-20T12:34:56.123456Z',has_error:true,last_error:'DO-NOT-EXPOSE',data:{secret:'DO-NOT-EXPOSE'},object_reference:'DO-NOT-EXPOSE'};
      const items=args.resource_id ? [] : args.after_cursor ? [{...row,id:'00000000-0000-4000-8000-000000000010',status:'processed',attempts:26,automatic_retry_exhausted:false,resource_type:'provider_money_movement',resource_id:'00000000-0000-4000-8000-000000000001'}] : [row];
      return new Response(JSON.stringify({items,next_cursor:!args.resource_id&&!args.after_cursor?{created_at:row.created_at,id:row.id}:null}),{headers});
    };
  })()`,
  );
  await click("Refresh events");
  await wait("Attempts: 25");
  await browser("eval", "window.failInbox=true");
  await click("More payment events");
  await wait("Inbox read failure");
  await browser(
    "eval",
    `if(document.querySelectorAll('tbody tr').length!==1)throw Error('Lost Inbox rows');window.failInbox=false`,
  );
  await click("Retry event read");
  await wait("2 loaded");
  await browser("click", "tbody tr:first-child summary");
  await wait("Next attempt timestamp: infinity");
  await browser(
    "eval",
    `if(window.inboxRequests.at(-1).after_cursor.created_at!=='2026-09-20T12:34:56.123456Z'||window.inboxRequests.at(-1).after_cursor.id!=='00000000-0000-4000-8000-000000000011')throw Error('Inbox cursor changed');if(document.querySelector('main b')||document.querySelector('main').textContent.includes('DO-NOT-EXPOSE'))throw Error('Unsafe Inbox fields');if(!document.querySelector('tbody tr:nth-child(2)').textContent.includes('Automatic retries exhausted: No'))throw Error('Exhaustion inferred from attempts')`,
  );
  await browser("set", "viewport", "1440", "1000");
  await browser("screenshot", "/tmp/admin-payment-events.png", "--full");
  await browser("set", "viewport", "390", "844");
  await browser(
    "eval",
    `const wrap=document.querySelector('.table-wrap');wrap.scrollLeft=200;if(!wrap.scrollLeft||document.documentElement.scrollWidth>innerWidth)throw Error('Inbox mobile overflow')`,
  );
  await browser("screenshot", "/tmp/admin-payment-events-mobile.png", "--full");
  await browser("set", "viewport", "1440", "1000");
  await browser("eval", `document.querySelector('.table-wrap').scrollLeft=0`);
  await browser(
    "click",
    'a[href="/payment-events?resource=00000000-0000-4000-8000-000000000001"]',
  );
  await wait("No payment events found");
  await browser(
    "eval",
    `const args=window.inboxRequests.at(-1);if(args.resource_id!=='00000000-0000-4000-8000-000000000001'||args.status_filter||args.after_cursor)throw Error('Resource navigation retained old filters')`,
  );
  await browser("fill", "#inbox-resource", "");
  await browser("select", "#inbox-status", "ignored");
  await click("Apply filters");
  await wait("1 loaded");
  await browser(
    "eval",
    `if(window.inboxRequests.at(-1).resource_id||window.inboxRequests.at(-1).after_cursor||window.inboxRequests.at(-1).status_filter!=='ignored')throw Error('Inbox filter reset failed')`,
  );
  await browser("open", `${origin.origin}/payment-events?resource=invalid`);
  await wait("Enter a valid resource UUID");
  await browser("open", `${origin.origin}/payment-events?status=unknown`);
  await wait("Invalid payment event status");
  await browser("open", `${origin.origin}/outbox?status=exhausted`);
  await wait("loaded · Record ID descending");
  await browser(
    "eval",
    `if(document.querySelector('main [role=alert]')||document.querySelector('#outbox-status').value!=='exhausted')throw Error('Real Outbox read or URL restoration failed')`,
  );
  await browser("reload");
  await wait("loaded · Record ID descending");
  await browser("select", "#outbox-status", "");
  await click("Apply filters");
  await wait("loaded · Record ID descending");
  await browser(
    "eval",
    `(() => {
    const original=window.fetch;window.outboxRequests=[];window.failOutbox=false;
    window.fetch=async(input,init)=>{
      if(!String(input).endsWith('/rpc/list_admin_outbox_events'))return original(input,init);
      const args=JSON.parse(init.body);window.outboxRequests.push(args);const headers={'Content-Type':'application/json'};
      if(window.failOutbox)return new Response(JSON.stringify({message:'Outbox fixture failure'}),{status:400,headers});
      const row={id:'9007199254740995',event_id:'00000000-0000-4000-8000-000000000011',aggregate_type:'order',aggregate_id:'00000000-0000-4000-8000-000000000021',event_type:'order.<b>literal</b>',status:'pending',attempts:26,retry_start:25,available_at:'infinity',lease_expires_at:null,published_at:null,created_at:'2026-09-20T12:34:56.123456Z',has_error:true,last_redrive:{attempts:25,worker_id:'admin:fixture',reason:'<img src=x onerror="window.outboxXss=true">',created_at:'2026-09-20T12:34:56.123456Z'},payload:{secret:'DO-NOT-EXPOSE'},last_error:'DO-NOT-EXPOSE',lease_token:'DO-NOT-EXPOSE',worker_id:'DO-NOT-EXPOSE'};
      const items=args.aggregate_id?[]:args.after_id?[{...row,id:'9007199254740993',status:'exhausted',attempts:50,last_redrive:null}]:[row];
      return new Response(JSON.stringify({items,next_after_id:!args.aggregate_id&&!args.after_id?row.id:null}),{headers});
    };
  })()`,
  );
  await click("Refresh Outbox");
  await wait("Record 9007199254740995");
  await browser("eval", "window.failOutbox=true");
  await click("More Outbox events");
  await wait("Outbox fixture failure");
  await browser(
    "eval",
    `if(document.querySelectorAll('tbody tr').length!==1)throw Error('Lost Outbox rows');window.failOutbox=false`,
  );
  await click("Retry Outbox read");
  await wait("Record 9007199254740993");
  await browser("click", "tbody tr:first-child summary");
  await wait("Available at: infinity");
  await browser(
    "eval",
    `if(window.outboxRequests.at(-1).after_id!=='9007199254740995')throw Error('Bigint cursor rounded');if(document.querySelectorAll('tbody tr').length!==2)throw Error('Wrong Outbox row count');if(document.querySelector('main b')||document.querySelector('main img')||window.outboxXss||document.querySelector('main').textContent.includes('DO-NOT-EXPOSE'))throw Error('Unsafe Outbox data');if(document.querySelector('tbody tr .badge').textContent!=='pending')throw Error('Status inferred from attempts')`,
  );
  await browser("screenshot", "/tmp/admin-outbox.png", "--full");
  await browser("set", "viewport", "390", "844");
  await browser(
    "eval",
    `const wrap=document.querySelector('.table-wrap');wrap.scrollLeft=200;if(!wrap.scrollLeft||document.documentElement.scrollWidth>innerWidth)throw Error('Outbox mobile overflow')`,
  );
  await browser("screenshot", "/tmp/admin-outbox-mobile.png", "--full");
  await browser("set", "viewport", "1440", "1000");
  await browser("eval", `document.querySelector('.table-wrap').scrollLeft=0`);
  await browser("click", 'tbody tr:first-child a[href^="/outbox?aggregate="]');
  await wait("No Outbox events found");
  await browser(
    "eval",
    `(() => {const args=window.outboxRequests.at(-1);if(args.aggregate_id!=='00000000-0000-4000-8000-000000000021'||args.after_id||args.status_filter)throw Error('Aggregate link did not reset filters');})()`,
  );
  await browser("fill", "#outbox-aggregate", "");
  await browser("select", "#outbox-status", "published");
  await click("Apply filters");
  await wait("1 loaded");
  await browser(
    "eval",
    `(() => {const args=window.outboxRequests.at(-1);if(args.aggregate_id||args.after_id||args.status_filter!=='published')throw Error('Outbox filters not applied');})()`,
  );
  await browser("open", `${origin.origin}/outbox?aggregate=invalid`);
  await wait("Enter a valid aggregate UUID");
  await browser("open", `${origin.origin}/outbox?status=unknown`);
  await wait("Invalid Outbox status");
  console.log(
    "Reconciliation, Inbox and Outbox smoke passed: real reads/deep refresh; fixture exact amounts/cursors/bigint IDs, retry preserving rows, safe fields, resource links, filter reset, diagnostic flags/audit, infinity, empty/error/invalid states, mobile scroll.",
  );
} finally {
  await browser("close").catch(() => {});
  if (user)
    await checked(
      api(`/auth/v1/admin/users/${user}`, { service: true, method: "DELETE" }),
    );
}
