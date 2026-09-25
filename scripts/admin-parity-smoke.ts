// Real browser + local RPC coverage for the remaining Admin/MCP business surfaces.
// PayPal dispatch is intercepted in-browser: never contact a payment provider.
import assert from "node:assert/strict";
import { SQL } from "bun";
import { localSupabase } from "./lib/local-supabase";
const config = localSupabase();
Object.assign(process.env, config);
const { signup, makeAdmin, rpc, checked, api } =
  await import("../tests/helpers");
const { stockedProduct } = await import("../tests/support/catalog");
const { fixtureOrder } = await import("../tests/payment-fixtures");
const { Cleanup } = await import("../tests/support/cleanup");
const cleanup = new Cleanup();
const db = new SQL(config.DB_URL, { max: 1 });
const run = crypto.randomUUID(),
  session = `parity-${run}`;
const origin = new URL(process.env.ADMIN_URL ?? "http://127.0.0.1:5174");
if (!["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))
  throw Error("Local Admin origin required");
async function browser(...args: string[]) {
  // The installed CLI uses CSS selectors, not Playwright's >> nth syntax.
  const indexed = args[1]?.match(/^(.*) >> nth=(\d+)$/);
  if (indexed) {
    if (args[0] === "select") {
      await browser(
        "eval",
        `document.querySelectorAll('[data-smoke-select]').forEach(x=>x.removeAttribute('data-smoke-select'));document.querySelectorAll(${JSON.stringify(indexed[1])})[${indexed[2]}].setAttribute('data-smoke-select','true')`,
      );
      args[1] = "[data-smoke-select]";
    } else
      args = ["find", "nth", indexed[2], indexed[1], args[0], ...args.slice(2)];
  }
  const p = Bun.spawn(["agent-browser", "--session", session, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code) throw Error(`Browser ${args[0]} failed: ${err || out}`);
  return out.trim();
}
const click = (name: string) =>
  browser("find", "role", "button", "click", "--name", name, "--exact");
const fill = (label: string, value: string) =>
  browser("find", "label", label, "fill", value, "--exact");
const wait = (text: string) => browser("wait", "--text", text);
const open = async (path: string) => {
  await browser("open", `${origin.origin}${path}`);
  await browser("wait", "#main h1, input[type=email]");
};
const navigate = async (path: string) => {
  await browser(
    "eval",
    `(() => {const link=document.createElement('a');link.id='smoke-route';link.href=${JSON.stringify(path)};link.textContent='Open fixture';document.querySelector('#main').append(link)})()`,
  );
  await browser("click", "#smoke-route");
  await browser("wait", "--url", `${origin.origin}${path}`);
  await browser("eval", "document.querySelector('#smoke-route')?.remove()");
};
const approve = async (button: string) => {
  await click(button);
  await browser("dialog", "accept");
};
const evalBrowser = (code: string) => browser("eval", code);
const capture = (name: string) =>
  browser("screenshot", `/tmp/admin-parity-${name}.png`, "--full");
try {
  const admin = await signup(`parity-admin-${run}@example.test`);
  await makeAdmin(admin.userId);
  const buyer = await signup(`parity-buyer-${run}@example.test`);
  const target = await signup(`parity-target-${run}@example.test`);
  for (const u of [admin, buyer, target])
    cleanup.defer(() =>
      checked(
        api(`/auth/v1/admin/users/${u.userId}`, {
          service: true,
          method: "DELETE",
        }),
      ),
    );
  const product = await stockedProduct(admin, {
    price: 17,
    onHand: 20,
    cleanup,
  });
  const zeroProduct = await stockedProduct(admin, {
    price: 0,
    onHand: 10,
    cleanup,
  });
  const unpaid = await fixtureOrder(product, buyer),
    cancel = await fixtureOrder(product, buyer),
    zero = await fixtureOrder(zeroProduct, buyer, 2);
  const call = <T = any>(name: string, args: unknown) =>
    checked<T>(rpc(name, args, admin.token));
  const settings = await call("get_admin_shop_settings", {});
  cleanup.defer(async () => {
    const current = await call("get_admin_shop_settings", {});
    await call("update_shop_settings", {
      expected_revision: current.revision,
      changes: { name: settings.name, timezone: settings.timezone },
    });
  });
  const categoryId = crypto.randomUUID();
  await call("create_category", {
    category_id: categoryId,
    changes: { name: "Parity category", slug: `parity-${run}` },
  });
  const reviewId = crypto.randomUUID();
  await checked(
    api("/rest/v1/product_reviews", {
      service: true,
      method: "POST",
      body: {
        id: reviewId,
        product_id: product.productId,
        customer_id: buyer.customerId,
        rating: 4,
        title: "Parity review",
        body: "<img src=x onerror=alert(1)> Plain text only",
        status: "pending",
      },
    }),
  );
  cleanup.defer(async () => {
    const r = await call("get_admin_review", { review_id: reviewId });
    if (r)
      await call("delete_review", {
        review_id: reviewId,
        expected_revision: r.revision,
      });
  });

  await open("/settings");
  await browser("wait", "input[type=email]");
  await browser("fill", "input[type=email]", admin.email);
  await browser("fill", "input[type=password]", "password123");
  await click("Sign in");
  await wait("Shop settings");
  await fill("Shop name", `Parity ${run}`);
  await fill("Presentation timezone", "Asia/Shanghai");
  await click("Save settings");
  await wait("Shop settings saved.");
  assert.equal(
    (await call("get_admin_shop_settings", {})).timezone,
    "Asia/Shanghai",
  );
  await capture("settings-desktop");
  const currentSettings = await call("get_admin_shop_settings", {});
  await call("update_shop_settings", {
    expected_revision: currentSettings.revision,
    changes: { name: "Concurrent settings winner" },
  });
  await fill("Shop name", "Stale settings draft");
  await click("Save settings");
  await wait("Reload before another write.");
  await evalBrowser(
    `if(document.querySelector('input').value!=='Stale settings draft'||!document.querySelector('fieldset').disabled)throw Error('Settings conflict lost draft or unlocked write')`,
  );
  assert.equal(
    (await call("get_admin_shop_settings", {})).name,
    "Concurrent settings winner",
  );
  await approve("Reload settings");
  await browser(
    "wait",
    "--fn",
    "document.querySelector('input')?.value==='Concurrent settings winner' && !document.querySelector('fieldset').disabled",
  );

  await open(`/orders/${unpaid.id}/actions`);
  await wait("Current facts");
  await evalBrowser(
    `(() => { const original=window.fetch.bind(window);window.parityBodies=[];window.fetch=async(...args)=>{const response=await original(...args);if(String(args[0]?.url??args[0]).includes('/rpc/mark_order_paid')){window.parityBodies.push(JSON.parse(args[1].body));if(window.parityBodies.length===1&&response.ok)throw Error('Lost payment receipt');}return response;};})()`,
  );
  await browser("check", "input[type=checkbox] >> nth=2");
  await approve("Mark order paid");
  await wait("Unresolved mark-paid");
  await approve("Retry retained request");
  await browser(
    "wait",
    "--fn",
    "!document.body.innerText.includes('Unresolved mark-paid')",
  );
  await evalBrowser(
    `if(JSON.stringify(window.parityBodies[0])!==JSON.stringify(window.parityBodies[1]))throw Error('Retry changed payment arguments')`,
  );
  assert.equal(
    (
      await call("get_order_ledger", { order_id: unpaid.id })
    ).transactions.filter((x: any) => x.kind === "capture").length,
    1,
  );
  await capture("order-actions-desktop");
  await fill("Customer-visible reason", "Cannot cancel a paid order");
  await browser("check", "input[type=checkbox] >> nth=0");
  await approve("Cancel eligible order");
  await wait("The first request was rejected before committing.");
  await evalBrowser(
    `if(document.body.innerText.includes('Unresolved cancel-order'))throw Error('Deterministic rejection trapped order')`,
  );
  // Verify exact PayPal request construction and unknown-result retry, without provider traffic.
  await evalBrowser(
    `(() => {const original=window.fetch.bind(window);window.paypalBodies=[];window.fetch=async(...args)=>{if(String(args[0]?.url??args[0]).includes('/functions/v1/paypal-create-refund')){window.paypalBodies.push(JSON.parse(args[1].body));throw Error('Provider fixture unavailable');}return original(...args);};})()`,
  );
  await fill("USD amount", "3.25");
  await browser("check", "input[type=checkbox] >> nth=3");
  await approve("Issue PayPal refund");
  await wait("Unresolved paypal-refund");
  await approve("Retry retained request");
  await evalBrowser(
    `if(window.paypalBodies.length!==2||JSON.stringify(window.paypalBodies[0])!==JSON.stringify(window.paypalBodies[1])||window.paypalBodies[0].amount!=='3.25')throw Error('PayPal scope/retry mismatch')`,
  );
  await browser("set", "viewport", "390", "844");
  await browser("find", "text", "Retained exact request", "click", "--exact");
  await evalBrowser(
    `if(document.documentElement.scrollWidth>innerWidth)throw Error('Retained request overflows mobile viewport')`,
  );
  await capture("order-unknown-mobile");
  await open(`/orders/${cancel.id}/actions`);
  await wait("Current facts");
  await fill("Customer-visible reason", "Fixture cancellation");
  await browser("check", "input[type=checkbox] >> nth=0");
  await approve("Cancel eligible order");
  await wait("Action confirmed");
  assert.equal(
    (await call("get_admin_order", { order_id: cancel.id })).status,
    "cancelled",
  );
  await open(`/orders/${zero.id}/actions`);
  await wait("Current facts");
  await browser(
    "select",
    "fieldset section:nth-of-type(2) select",
    zero.itemId,
  );
  await fill("Quantity", "1");
  await fill("Reason", "Zero consideration cancellation");
  await browser("check", "input[type=checkbox] >> nth=1");
  await approve("Cancel zero-value units");
  await wait("Action confirmed");
  assert.equal(
    (await call("get_order_fulfillment_balance", { order_id: zero.id }))
      .lines[0].cancelled_quantity,
    1,
  );

  await open("/users");
  await fill("Email contains", target.email);
  await click("Apply filters");
  await wait(target.email);
  await capture("users-mobile");
  await open(`/users/${target.userId}`);
  await wait("Current profile");
  await browser("select", "select", "admin");
  await browser(
    "fill",
    "section.card input >> nth=0",
    `${target.userId} admin`,
  );
  await click("Set exact role");
  await wait("Role changed.");
  assert.equal(
    (await call("get_admin_user", { user_id: target.userId })).role,
    "admin",
  );
  await click("Reload original user");
  await browser("wait", "--fn", "!document.querySelector('select').disabled");
  await browser("select", "select", "customer");
  await browser(
    "fill",
    "section.card input >> nth=0",
    `${target.userId} customer`,
  );
  await click("Set exact role");
  await wait("Role changed.");
  await click("Reload original user");
  await browser("wait", "--fn", "!document.querySelector('select').disabled");
  await browser(
    "fill",
    "section.card input >> nth=1",
    `ANONYMIZE ${target.userId}`,
  );
  await approve("Anonymize user");
  await wait("Anonymization submitted.");
  assert.ok(
    (await call("get_admin_user", { user_id: target.userId }))
      .customer_anonymized_at,
  );
  await open(`/reviews/${reviewId}`);
  await wait("Review moderation");
  await browser("select", "select", "approved");
  await browser("fill", "section.card input >> nth=0", `${reviewId} approved`);
  await approve("Set exact status");
  await wait("Moderation submitted.");
  assert.equal(
    (await call("get_admin_review", { review_id: reviewId })).status,
    "approved",
  );
  await browser("set", "viewport", "1280", "900");
  await capture("review-desktop");
  await evalBrowser(
    `if(document.querySelector('article img'))throw Error('Review HTML executed')`,
  );
  await click("Reload original review");
  await browser("wait", "--fn", "!document.querySelector('select').disabled");
  await browser("fill", "section.card input >> nth=1", `DELETE ${reviewId}`);
  await click(
    `Delete exact revision ${(await call("get_admin_review", { review_id: reviewId })).revision}`,
  );
  await browser("dialog", "accept");
  await wait("Review deleted.");
  assert.equal(await call("get_admin_review", { review_id: reviewId }), null);

  const definitionId = crypto.randomUUID(),
    fieldId = crypto.randomUUID();
  await open(`/metadata/metafields/${definitionId}?new=1`);
  await wait("New definition");
  await browser("select", "select >> nth=0", "category");
  await fill("Key", `parity_${run.replaceAll("-", "_")}`);
  await fill("Name", "Parity definition");
  await approve("Save definition");
  await wait("Definition saved.");
  await fill("Name", "Parity definition updated");
  await approve("Save definition");
  await wait("Definition saved.");
  assert.equal(
    (
      await call("get_admin_metafield_definition", {
        definition_id: definitionId,
      })
    ).name,
    "Parity definition updated",
  );
  await open(
    `/metadata/values/${fieldId}?new=1&owner_type=category&owner_id=${categoryId}`,
  );
  await wait("Metafield");
  await fill("Key", `parity_${run.replaceAll("-", "_")}`);
  await fill("JSON value", '"First value"');
  await approve("Save field");
  await wait("Metafield saved.");
  await fill("JSON value", '"Updated value"');
  await approve("Save field");
  await wait("Metafield saved.");
  assert.equal(
    (
      await call("list_admin_metafields", {
        owner_type_filter: "category",
        owner_id_filter: categoryId,
      })
    ).items[0].value,
    "Updated value",
  );
  await approve("Delete field");
  await wait("Metafield deleted.");
  for (const owner of ["product", "variant"]) {
    const ownerId = owner === "product" ? product.productId : product.variantId;
    await open(
      `/metadata/values/${crypto.randomUUID()}?new=1&owner_type=${owner}&owner_id=${ownerId}&product=${product.productId}`,
    );
    await wait("Metafield");
    await fill("Key", `parity_${owner}`);
    await fill("JSON value", JSON.stringify(`value-${owner}`));
    if (owner === "variant")
      await evalBrowser(
        `(() => {const original=window.fetch.bind(window);window.fetch=async(...args)=>{const r=await original(...args);if(String(args[0]?.url??args[0]).includes('/rpc/update_product')&&r.ok)throw Error('Lost aggregate receipt');return r;};})()`,
      );
    await approve("Save field");
    if (owner === "variant") {
      await wait("Reload before another write.");
      await browser("reload");
      await browser(
        "wait",
        "--fn",
        "document.querySelector('textarea')?.value.includes('value-variant')",
      );
      await evalBrowser(
        `if(document.querySelector('fieldset').disabled)throw Error('Original aggregate field did not recover')`,
      );
    } else await wait("Metafield saved.");
    const p = await call("get_admin_product", {
      product_id: product.productId,
    });
    const fields =
      owner === "product"
        ? p.metafields
        : p.variants.find((x: any) => x.id === product.variantId).metafields;
    assert.equal(
      fields.find((x: any) => x.key === `parity_${owner}`).value,
      `value-${owner}`,
    );
    await browser("reload");
    await browser(
      "wait",
      "--fn",
      "document.querySelector('textarea')?.value.includes('value-')",
    );
    await approve("Delete field");
    await wait("Metafield deleted.");
  }
  await open(
    `/metadata/values/${crypto.randomUUID()}?new=1&owner_type=product&owner_id=${product.productId}&namespace=custom&key=still_pending`,
  );
  await wait("The original field is not yet visible.");
  await evalBrowser(
    `if(!document.querySelector('fieldset').disabled)throw Error('Missing aggregate write unlocked replacement identity')`,
  );
  const objectDef = crypto.randomUUID(),
    objectId = crypto.randomUUID();
  await open(`/metadata/metaobjects/${objectDef}?new=1`);
  await wait("New definition");
  await fill("Type", `parity_${run.replaceAll("-", "_")}`);
  await fill("Name", "Parity content");
  await fill(
    "Complete field schema JSON",
    '[{"key":"heading","type":"text","required":true}]',
  );
  await approve("Save definition");
  await wait("Definition saved.");
  await open(`/metadata/metaobjects/${objectDef}/entries/${objectId}?new=1`);
  await wait("Definition: Parity content");
  await fill("Handle", "test-entry");
  await fill("Complete values JSON", '{"heading":"Draft heading"}');
  await approve("Save entry");
  await wait("Entry saved.");
  await fill("Complete values JSON", '{"heading":"Revised heading"}');
  await approve("Save entry");
  await wait("Entry saved.");
  assert.equal(
    (await call("get_admin_metaobject", { metaobject_id: objectId })).values
      .heading,
    "Revised heading",
  );
  await browser("find", "text", "Field schema", "click", "--exact");
  await capture("metadata-desktop");
  const otherEntry = crypto.randomUUID();
  await call("create_metaobject", {
    metaobject_id: otherEntry,
    changes: {
      definition_id: objectDef,
      handle: "other-entry",
      status: "draft",
      values: { heading: "Different identity" },
    },
  });
  await navigate(`/metadata/metaobjects/${objectDef}/entries/${otherEntry}`);
  await browser(
    "wait",
    "--fn",
    "document.querySelector('textarea')?.value.includes('Different identity')",
  );
  await fill("Complete values JSON", '{"heading":"Only second entry changed"}');
  await approve("Save entry");
  await wait("Entry saved.");
  assert.equal(
    (await call("get_admin_metaobject", { metaobject_id: objectId })).values
      .heading,
    "Revised heading",
  );
  assert.equal(
    (await call("get_admin_metaobject", { metaobject_id: otherEntry })).values
      .heading,
    "Only second entry changed",
  );
  await approve("Delete entry");
  await wait("Entry deleted.");
  await navigate(`/metadata/metaobjects/${objectDef}/entries/${objectId}`);
  await browser(
    "wait",
    "--fn",
    "document.querySelector('textarea')?.value.includes('Revised heading')",
  );
  await approve("Delete entry");
  await wait("Entry deleted.");
  await open(`/metadata/metaobjects/${objectDef}`);
  await wait("Parity content");
  await approve("Delete definition");
  await wait("Definition deleted.");

  await open(`/products/${product.productId}`);
  await wait("Options & variants");
  await fill("Variant 1 position", "-7");
  await click("Save product");
  await wait("Product saved");
  assert.equal(
    (
      await call("get_admin_product", { product_id: product.productId })
    ).variants.find((x: any) => x.id === product.variantId).position,
    -7,
  );
  await open("/reports");
  await click("Run report");
  await wait("Report result");
  await capture("reports-desktop");
  for (const mode of ["payments", "operations", "export"]) {
    await browser("select", "select >> nth=0", mode);
    await click("Run report");
    await wait(mode === "export" ? "Loaded order export" : "Report result");
  }
  await browser("set", "viewport", "390", "844");
  await capture("reports-mobile");
  await open(`/media/public?product=${product.productId}`);
  await wait("Public product media");
  await evalBrowser(
    `(() => {const bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+X9kAAAAASUVORK5CYII='),c=>c.charCodeAt(0));const input=document.querySelector('input[type=file]');const files=new DataTransfer();files.items.add(new File([bytes],'fixture.png',{type:'image/png'}));input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}));const original=window.fetch.bind(window);window.fetch=async(...args)=>{const r=await original(...args);if(String(args[0]?.url??args[0]).includes('/storage/v1/object/catalog-media/')&&args[1]?.method==='POST'&&r.ok)throw Error('Lost public upload receipt');return r;};})()`,
  );
  await approve("Publish immutable public bytes");
  await wait("Do not allocate a replacement ID");
  await browser("reload");
  await wait("Retained upload attempt");
  await browser(
    "wait",
    "--fn",
    "document.querySelector('tbody button') && !document.querySelector('tbody button').disabled",
  );
  await browser("click", "tbody button");
  await wait("bytes");
  await browser(
    "wait",
    "--fn",
    "document.querySelector('tbody code')?.textContent===document.querySelector('section.fields p:nth-of-type(2) code')?.textContent",
  );
  await evalBrowser(
    `if(!document.querySelector('input[type=file]').disabled)throw Error('Unknown upload allocated a replacement identity')`,
  );
  await evalBrowser(
    `if(document.documentElement.scrollWidth>innerWidth)throw Error('Public media page overflows mobile viewport')`,
  );
  await capture("media-mobile");

  const from = crypto.randomUUID(),
    to = crypto.randomUUID();
  for (const location of [from, to]) {
    await call("create_location", {
      location_id: location,
      changes: {
        code: location,
        name: location === from ? "Parity source" : "Parity destination",
        is_active: true,
      },
    });
    cleanup.defer(async () => {
      const row = await call("get_admin_location", { location_id: location });
      await call("update_location", {
        location_id: location,
        expected_revision: row.revision,
        changes: { is_active: false },
      });
    });
  }
  await call("adjust_inventory", {
    variant_id: product.variantId,
    location_id: from,
    delta: 5,
    idempotency_key: crypto.randomUUID(),
    note: "Parity transfer fixture",
  });
  const transfer = await call("transfer_inventory", {
    variant_id: product.variantId,
    from_location_id: from,
    to_location_id: to,
    quantity: 3,
    idempotency_key: crypto.randomUUID(),
    note: "Historical receipt fixture",
  });
  await call("adjust_inventory", {
    variant_id: product.variantId,
    location_id: from,
    delta: 7,
    idempotency_key: crypto.randomUUID(),
    note: "Later adjustment",
  });
  await open(`/inventory/transfers?id=${transfer.id}`);
  await wait("Completed transfer");
  await wait("Balances above are historical.");
  await capture("transfer-mobile");
  assert.deepEqual(
    await call("get_inventory_transfer", { transfer_id: transfer.id }),
    transfer,
  );

  const event = crypto.randomUUID();
  await db`insert into commerce.outbox_events(event_id,aggregate_type,aggregate_id,event_type,idempotency_key,status,attempts) values (${event}::uuid,'test',${event}::uuid,'test',${event},'exhausted',25)`;
  await open(`/outbox?aggregate=${event}&status=exhausted`);
  await fill("Redrive reason", "Fixture dependency restored");
  await approve("Requeue exhausted event");
  await wait("Event requeued.");
  const outbox = await call("list_admin_outbox_events", {
    aggregate_id: event,
  });
  assert.equal(outbox.items[0].last_redrive.attempts, 25);
  assert.equal(outbox.items[0].last_redrive.worker_id, `admin:${admin.userId}`);
  await capture("outbox-mobile");
  await open(`/customers/${buyer.customerId}`);
  await wait("Customer");
  await browser(
    "fill",
    'input[autocomplete="off"]',
    `ANONYMIZE ${buyer.customerId}`,
  );
  await approve("Anonymize customer");
  await wait("Customer anonymization submitted.");
  assert.ok(
    (await call("get_admin_customer", { customer_id: buyer.customerId }))
      .anonymized_at,
  );
  console.log(
    "PASS: settings, order cancellation/payment/zero-value units, exact PayPal boundary retry, users/roles/privacy, review moderation/deletion, metadata CRUD and aggregate ownership, reports, variant position, public media recovery/hash inspection, historical transfer lookup and outbox redrive.",
  );
} catch (cause) {
  console.error(await browser("snapshot"));
  throw cause;
} finally {
  try {
    await browser("close");
  } finally {
    try {
      await cleanup.run();
    } finally {
      await db.close();
    }
  }
}
