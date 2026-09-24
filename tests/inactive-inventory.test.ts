import { afterAll, expect, test } from 'bun:test';
import { checked, rpc, signup, makeAdmin } from './helpers';
import { heldTransactionRace, testDatabase } from './database-concurrency';

const db = testDatabase();
const product = crypto.randomUUID(),
  variant = crypto.randomUUID(),
  location = crypto.randomUUID();
afterAll(async () => {
  // Immutable movement/idempotency history survives fixtures just as it does operational cleanup.
  await db`update public.products set status='archived' where id=${product}::uuid`;
  await db`update public.locations set is_active=false where id=${location}::uuid`;
  await db.close();
});
test('inactive warehouse rejects new commands but preserves exact replay and read history', async () => {
  const user = await signup();
  await makeAdmin(user.userId);
  await db`insert into public.products(id,name,slug) values(${product}::uuid,'History fixture',${product})`;
  await db`insert into public.product_variants(id,product_id,price) values(${variant}::uuid,${product}::uuid,19.37)`;
  await db`insert into public.locations(id,name,code) values(${location}::uuid,'History fixture',${location})`;
  const args = { variant_id: variant, location_id: location, delta: 7, idempotency_key: crypto.randomUUID() };
  expect(await checked(rpc('adjust_inventory', args, user.token))).toMatchObject({ on_hand: 7 });
  await db`update public.locations set is_active=false where id=${location}::uuid`;
  expect(await checked(rpc('adjust_inventory', args, user.token))).toMatchObject({ on_hand: 7 });
  expect(
    (await rpc('adjust_inventory', { ...args, idempotency_key: crypto.randomUUID() }, user.token)).status,
  ).toBe(409);
  expect((await rpc('adjust_inventory', { ...args, delta: 9 }, user.token)).status).toBe(409);
  const [count] =
    await db`select count(*)::int as count from public.inventory_movements where variant_id=${variant}::uuid`;
  expect(count.count).toBe(1);
  await db`update public.locations set is_active=true where id=${location}::uuid`;
  const raced = await heldTransactionRace(
    db,
    (tx) => tx`select id from public.locations where id=${location}::uuid for update`,
    () => rpc('adjust_inventory', { ...args, idempotency_key: crypto.randomUUID() }, user.token),
    (tx) => tx`update public.locations set is_active=false where id=${location}::uuid`,
  );
  expect(raced.status).toBe(409);
}, 30000);
