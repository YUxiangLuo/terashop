import { afterAll, expect, test } from 'bun:test';
import { API, ANON_KEY, signup, makeAdmin, rpc, checked } from './helpers';
import { AdminBackend } from '../mcp/src/backend';
import { mcpSession, toolData } from './support/mcp';
import { testDatabase } from './database-concurrency';

const db = testDatabase();
const categories: string[] = [],
  locations: string[] = [];
afterAll(async () => {
  try {
    for (const id of categories) await db`delete from public.categories where id=${id}::uuid`;
    for (const id of locations) await db`delete from public.locations where id=${id}::uuid`;
  } finally {
    await db.close();
  }
});

test('explicit creation activation survives MCP dispatch; subsequent partial updates preserve it', async () => {
  const admin = await signup();
  await makeAdmin(admin.userId);
  const session = await mcpSession(
    new AdminBackend({ url: API, anonKey: ANON_KEY, accessToken: admin.token }),
    true,
  );
  try {
    for (const is_active of [false, true]) {
      for (const entity of ['category', 'location']) {
        const id = crypto.randomUUID();
        (entity === 'category' ? categories : locations).push(id);
        const identity = { [`${entity}_id`]: id };
        const fields =
          entity === 'category'
            ? { slug: `align-${id}`, name: 'Category' }
            : { code: `align-${id}`, name: 'Warehouse' };
        const missing = await session.client.callTool({
          name: `create_${entity}`,
          arguments: { ...identity, changes: fields },
        });
        expect(missing.isError).toBe(true);
        expect(await checked<unknown>(rpc(`get_admin_${entity}`, identity, admin.token))).toBeNull();
        const created = await toolData<{ is_active: boolean; updated_at: string; revision: number }>(
          session.client,
          `create_${entity}`,
          { ...identity, changes: { ...fields, is_active } },
        );
        expect(created.is_active).toBe(is_active);
        const token =
          entity === 'category'
            ? { expected_updated_at: created.updated_at }
            : { expected_revision: created.revision };
        await toolData(session.client, `update_${entity}`, {
          ...identity,
          ...token,
          changes: { name: 'Renamed' },
        });
        const stored = await checked<{ is_active: boolean; name: string }>(
          rpc(`get_admin_${entity}`, identity, admin.token),
        );
        expect(stored).toMatchObject({ is_active, name: 'Renamed' });
      }
    }
  } finally {
    await session.close();
  }
});
