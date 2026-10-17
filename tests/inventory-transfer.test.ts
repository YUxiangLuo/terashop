import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { TransactionSQL } from 'bun';
import { AdminBackend } from '../mcp/src/backend';
import { API, ANON_KEY, api, checked, rpc, signup, makeAdmin, TEST_ADDRESS, type TestUser } from './helpers';
import { mcpSession, toolData } from './support/mcp';
import { Cleanup } from './support/cleanup';
import { stockedProduct } from './support/catalog';
import { heldTransactionRace, testDatabase } from './database-concurrency';
import { withRollback } from '../scripts/lib/transactions';

interface Transfer {
  id: string;
  variant_id: string;
  from_location_id: string;
  to_location_id: string;
  quantity: number;
  from_on_hand_after: number;
  to_on_hand_after: number;
  out_movement_id: string;
  in_movement_id: string;
  actor_id: string | null;
  note: string | null;
}
const db = testDatabase(),
  cleanup = new Cleanup();
let admin: TestUser, buyer: TestUser, source: string, session: Awaited<ReturnType<typeof mcpSession>>;
const claims = (user: TestUser) => JSON.stringify({ sub: user.userId, role: 'authenticated' });
beforeAll(async () => {
  admin = await signup();
  buyer = await signup();
  await makeAdmin(admin.userId);
  session = await mcpSession(
    new AdminBackend({ url: API, anonKey: ANON_KEY, accessToken: admin.token }),
    true,
  );
  source = (
    await checked<{ id: string }[]>(
      api('/rest/v1/locations?is_default=eq.true&is_active=eq.true', { service: true }),
    )
  )[0].id;
});
afterAll(async () => {
  try {
    await cleanup.run();
  } finally {
    await session?.close();
    await db.close();
  }
});
async function fixture(onHand = 11, destinationStock = 0, trackInventory = true) {
  const product = await stockedProduct(admin, { onHand, trackInventory, cleanup });
  const destination: string = crypto.randomUUID();
  await checked(
    rpc(
      'create_location',
      { location_id: destination, changes: { code: destination, name: 'Transfer destination' } },
      admin.token,
    ),
  );
  cleanup.defer(() =>
    checked(
      api(`/rest/v1/locations?id=eq.${destination}`, {
        service: true,
        method: 'PATCH',
        body: { is_active: false },
      }),
    ),
  );
  if (destinationStock)
    await checked(
      rpc(
        'adjust_inventory',
        {
          variant_id: product.variantId,
          location_id: destination,
          delta: destinationStock,
          idempotency_key: crypto.randomUUID(),
        },
        admin.token,
      ),
    );
  return {
    variant_id: product.variantId,
    from_location_id: source,
    to_location_id: destination,
    quantity: 4,
    idempotency_key: crypto.randomUUID(),
  };
}
type Args = Awaited<ReturnType<typeof fixture>>;
const transfer = (args: Args) => toolData<Transfer>(session.client, 'transfer_inventory', args);
const availability = (variant_id: string, location_id: string) =>
  toolData(session.client, 'get_inventory_availability', { variant_id, location_id });
async function sqlTransfer(sql: TransactionSQL, args: Args) {
  await sql`select set_config('request.jwt.claims',${claims(admin)},true)`;
  return (
    await sql`select public.transfer_inventory(${args.variant_id}::uuid,${args.from_location_id}::uuid,
    ${args.to_location_id}::uuid,${args.quantity}::integer,${args.idempotency_key}) dto`
  )[0].dto as Transfer;
}

test('MCP 即时调拨守恒，返回关联流水与历史余额，同键重放不重复搬库存', async () => {
  const args = { ...(await fixture(11, 2)), note: 'Move four units' };
  const result = await transfer(args);
  expect(result).toMatchObject({
    variant_id: args.variant_id,
    from_location_id: source,
    to_location_id: args.to_location_id,
    quantity: 4,
    from_on_hand_after: 7,
    to_on_hand_after: 6,
    actor_id: admin.userId,
    note: args.note,
  });
  expect(typeof result.out_movement_id).toBe('string');
  expect(typeof result.in_movement_id).toBe('string');
  const page = await toolData<{ items: Record<string, unknown>[] }>(
    session.client,
    'list_admin_inventory_movements',
    { variant_id: args.variant_id },
  );
  expect(page.items.filter((m) => m.transfer_id === result.id)).toEqual([
    expect.objectContaining({
      id: result.in_movement_id,
      reason: 'transfer_in',
      delta: 4,
      on_hand_after: 6,
      location_id: args.to_location_id,
    }),
    expect.objectContaining({
      id: result.out_movement_id,
      reason: 'transfer_out',
      delta: -4,
      on_hand_after: 7,
      location_id: source,
    }),
  ]);
  expect(
    (
      await toolData<{ items: { id: string }[] }>(session.client, 'list_admin_inventory_movements', {
        variant_id: args.variant_id,
        reason_filter: 'transfer_out',
      })
    ).items.map((m) => m.id),
  ).toEqual([result.out_movement_id]);
  await checked(
    rpc(
      'adjust_inventory',
      { variant_id: args.variant_id, location_id: source, delta: 2, idempotency_key: crypto.randomUUID() },
      admin.token,
    ),
  );
  await checked(
    api(`/rest/v1/locations?id=eq.${args.to_location_id}`, {
      service: true,
      method: 'PATCH',
      body: { is_active: false },
    }),
  );
  expect(await transfer(args)).toEqual(result);
  expect(
    await toolData<Transfer>(session.client, 'get_inventory_transfer', { transfer_id: result.id }),
  ).toEqual(result);
  expect(await availability(args.variant_id, source)).toMatchObject({ on_hand: 9 });
  expect(await availability(args.variant_id, args.to_location_id)).toMatchObject({ on_hand: 6 });
  expect((await rpc('transfer_inventory', { ...args, quantity: 3 }, admin.token)).data).toMatchObject({
    code: 'PT409',
  });
  expect(
    await toolData(session.client, 'get_inventory_transfer', { transfer_id: crypto.randomUUID() }),
  ).toBeNull();
});

test('预留 4 件时拒绝调出 7 件，允许恰好 6 件；失败不残留目标库存或占用幂等键', async () => {
  const args = { ...(await fixture(10)), quantity: 7 };
  const quote = await checked<{ id: string }>(
    rpc(
      'create_checkout_quote',
      {
        items: [{ variant_id: args.variant_id, quantity: 4 }],
        address: TEST_ADDRESS,
        idempotency_key: crypto.randomUUID(),
      },
      buyer.token,
    ),
  );
  try {
    expect((await rpc('transfer_inventory', args, admin.token)).data).toMatchObject({ code: 'PT409' });
    expect(
      await checked<unknown[]>(
        api(
          `/rest/v1/inventory_levels?variant_id=eq.${args.variant_id}&location_id=eq.${args.to_location_id}`,
          { service: true },
        ),
      ),
    ).toEqual([]);
    expect(await transfer({ ...args, quantity: 6 })).toMatchObject({
      from_on_hand_after: 4,
      to_on_hand_after: 6,
    });
    expect(await availability(args.variant_id, source)).toMatchObject({
      on_hand: 4,
      reserved: 4,
      available: 0,
    });
    expect(await availability(args.variant_id, args.to_location_id)).toMatchObject({
      on_hand: 6,
      reserved: 0,
      available: 6,
    });
  } finally {
    await checked(rpc('cancel_checkout_quote', { quote_id: quote.id }, buyer.token));
  }
});

test('受控并发：同键只执行一次；逆向调拨等待后完成；竞争剩余库存者失败', async () => {
  const args = await fixture();
  let first!: Transfer;
  const replay = await heldTransactionRace(
    db,
    async (sql) => {
      first = await sqlTransfer(sql, args);
    },
    () => transfer(args),
  );
  expect(replay).toEqual(first);
  const opposite = {
    ...args,
    from_location_id: args.to_location_id,
    to_location_id: source,
    quantity: 2,
    idempotency_key: crypto.randomUUID(),
  };
  await heldTransactionRace(
    db,
    (sql) => sqlTransfer(sql, { ...args, quantity: 3, idempotency_key: crypto.randomUUID() }),
    () => transfer(opposite),
  );
  expect(await availability(args.variant_id, source)).toMatchObject({ on_hand: 6 });
  expect(await availability(args.variant_id, args.to_location_id)).toMatchObject({ on_hand: 5 });
  const denied = await heldTransactionRace(
    db,
    (sql) => sqlTransfer(sql, { ...args, quantity: 4, idempotency_key: crypto.randomUUID() }),
    () =>
      rpc('transfer_inventory', { ...args, quantity: 3, idempotency_key: crypto.randomUUID() }, admin.token),
  );
  expect(denied.data).toMatchObject({ code: 'PT409' });
  expect(await availability(args.variant_id, source)).toMatchObject({ on_hand: 2 });
  expect(await availability(args.variant_id, args.to_location_id)).toMatchObject({ on_hand: 9 });
});

test('调拨等待正在创建的真实预留，提交后重新计算；拒绝陈旧隔离级别', async () => {
  const args = { ...(await fixture(10)), quantity: 7 };
  let quoteId!: string;
  const denied = await heldTransactionRace(
    db,
    async (sql) => {
      await sql`select set_config('request.jwt.claims',${claims(buyer)},true)`;
      quoteId = (
        await sql`select public.create_checkout_quote(
      ${JSON.stringify([{ variant_id: args.variant_id, quantity: 4 }])}::text::jsonb,${crypto.randomUUID()},${JSON.stringify(TEST_ADDRESS)}::text::jsonb) dto`
      )[0].dto.id;
    },
    () => rpc('transfer_inventory', args, admin.token),
  );
  try {
    expect(denied.data).toMatchObject({ code: 'PT409' });
    expect(await availability(args.variant_id, source)).toMatchObject({ on_hand: 10, reserved: 4 });
    for (const isolation of ['repeatable read', 'serializable'])
      await expect(
        withRollback(db, async (sql) => {
          await sql.unsafe(`set transaction isolation level ${isolation}`);
          await sqlTransfer(sql, { ...args, quantity: 1 });
        }),
      ).rejects.toThrow('inventory transfer requires READ COMMITTED');
  } finally {
    await checked(rpc('cancel_checkout_quote', { quote_id: quoteId }, buyer.token));
  }
});

test('目标整数溢出时来源扣减/流水/幂等全部回滚，修正后原键可用', async () => {
  const args = await fixture(11, 2147483647);
  expect((await rpc('transfer_inventory', args, admin.token)).data).toMatchObject({ code: '22003' });
  expect(await availability(args.variant_id, source)).toMatchObject({ on_hand: 11 });
  expect(
    (
      await toolData<{ items: unknown[] }>(session.client, 'list_admin_inventory_movements', {
        variant_id: args.variant_id,
        reason_filter: 'transfer_out',
      })
    ).items,
  ).toEqual([]);
  await checked(
    rpc(
      'adjust_inventory',
      {
        variant_id: args.variant_id,
        location_id: args.to_location_id,
        delta: -5,
        idempotency_key: crypto.randomUUID(),
      },
      admin.token,
    ),
  );
  expect(await transfer(args)).toMatchObject({ from_on_hand_after: 7, to_on_hand_after: 2147483646 });
});

test('权限与参数在数据库独立校验，不接受相同仓库、非跟踪变体或停用仓库', async () => {
  const args = await fixture();
  for (const token of [undefined, buyer.token]) {
    expect((await rpc('transfer_inventory', args, token)).data).toMatchObject({ code: '42501' });
    expect(
      (await rpc('get_inventory_transfer', { transfer_id: crypto.randomUUID() }, token)).data,
    ).toMatchObject({ code: '42501' });
  }
  expect((await rpc('transfer_inventory', args, undefined, true)).data).toMatchObject({ code: '42501' });
  for (const patch of [
    { quantity: 0 },
    { quantity: -1 },
    { quantity: null },
    { idempotency_key: ' ' },
    { idempotency_key: 'x'.repeat(201) },
    { note: 'x'.repeat(2001) },
    { to_location_id: source },
  ])
    expect((await rpc('transfer_inventory', { ...args, ...patch }, admin.token)).data).toMatchObject({
      code: '22023',
    });
  expect(
    (await rpc('transfer_inventory', { ...args, variant_id: crypto.randomUUID() }, admin.token)).data,
  ).toMatchObject({ code: 'PT404' });
  const untracked = await fixture(0, 0, false);
  expect((await rpc('transfer_inventory', untracked, admin.token)).data).toMatchObject({ code: '22023' });
  await checked(
    api(`/rest/v1/locations?id=eq.${args.to_location_id}`, {
      service: true,
      method: 'PATCH',
      body: { is_active: false },
    }),
  );
  expect((await rpc('transfer_inventory', args, admin.token)).data).toMatchObject({ code: 'PT409' });
});

test('数据库拒绝不成对和不守恒流水，匿名化 actor 后重放不恢复身份', async () => {
  const args = await fixture();
  for (const incoming of [0, 3]) {
    await expect(
      withRollback(db, async (sql) => {
        const id = crypto.randomUUID();
        await sql`insert into public.inventory_movements(variant_id,location_id,delta,on_hand_after,reason,transfer_id)
        values(${args.variant_id}::uuid,${source}::uuid,-4,7,'transfer_out',${id}::uuid)`;
        if (incoming)
          await sql`insert into public.inventory_movements(variant_id,location_id,delta,on_hand_after,reason,transfer_id)
        values(${args.variant_id}::uuid,${args.to_location_id}::uuid,${incoming},${incoming},'transfer_in',${id}::uuid)`;
        await sql`set constraints inventory_transfer_balanced immediate`;
      }),
    ).rejects.toThrow('transfer requires a balanced pair of movements');
  }
  const actor = await signup();
  await makeAdmin(actor.userId);
  const result = await checked<Transfer>(rpc('transfer_inventory', args, actor.token));
  expect(result.actor_id).toBe(actor.userId);
  await checked(api(`/auth/v1/admin/users/${actor.userId}`, { service: true, method: 'DELETE' }));
  expect(await transfer(args)).toEqual({ ...result, actor_id: null });
});
