import { afterAll, expect, test } from 'bun:test';
import { api, checked, rpc, signup, makeAdmin } from './helpers';
import { testDatabase } from './database-concurrency';
import type { McpToolCall, ToolCallCursor } from '../admin/src/lib/mcp-connections';

const db = testDatabase();
const project = `audit-list-${crypto.randomUUID()}`;
afterAll(async () => {
  await db`delete from private.mcp_tool_audit where project=${project}`;
  await db.close();
});
type Page = { items: McpToolCall[]; next_cursor: ToolCallCursor | null };
test('personal audit pages isolate users, retain removed grants, and paginate exact timestamp/UUID ties after demotion', async () => {
  const owner = await signup(),
    other = await signup();
  await makeAdmin(owner.userId);
  const ids = Array.from({ length: 3 }, () => crypto.randomUUID()).sort();
  // No grant FK: records must remain readable even when their grant no longer exists.
  const grant = crypto.randomUUID();
  for (const [index, id] of ids.entries()) {
    const time = index === 0 ? '2026-09-23T00:00:00.123455Z' : '2026-09-23T00:00:00.123456Z';
    await db`insert into private.mcp_tool_audit(id,user_id,grant_id,client_id,issuer,resource,project,tool_name,mutation,admitted_at)
      values(${id}::uuid,${owner.userId}::uuid,${grant}::uuid,'own-agent','https://auth.example','https://shop.example/mcp',${project},'get_admin_product',false,${time}::timestamptz)`;
  }
  await db`insert into private.mcp_tool_audit(id,user_id,grant_id,client_id,issuer,resource,project,tool_name,mutation)
    values(${crypto.randomUUID()}::uuid,${other.userId}::uuid,${grant}::uuid,'other-secret-agent','https://auth.example','https://shop.example/mcp',${project},'get_admin_product',false)`;
  const list = (args = {}) => checked<Page>(rpc('list_my_mcp_tool_calls', args, owner.token));
  for (const service of [false, true])
    expect((await rpc('list_my_mcp_tool_calls', {}, undefined, service)).data).toMatchObject({
      code: '42501',
    });
  for (const args of [
    { page_size: 0 },
    { page_size: 101 },
    { page_size: null },
    { before_at: 'infinity', before_id: ids[0] },
    { before_id: ids[0] },
    { before_at: '2026-09-23T00:00:00Z' },
  ])
    expect((await rpc('list_my_mcp_tool_calls', args, owner.token)).data).toMatchObject({ code: '22023' });
  const first = await list({ page_size: 1 });
  expect(first.items.map((x) => x.id)).toEqual([ids[2]]);
  expect(first.next_cursor).toEqual({ id: ids[2], admitted_at: '2026-09-23T00:00:00.123456+00:00' });
  expect(Object.keys(first.items[0]).sort()).toEqual(
    [
      'id',
      'grant_id',
      'client_id',
      'resource',
      'tool_name',
      'mutation',
      'admitted_at',
      'finished_at',
      'outcome',
      'resource_type',
      'resource_id',
    ].sort(),
  );
  await checked(
    api(`/rest/v1/profiles?id=eq.${owner.userId}`, {
      method: 'PATCH',
      service: true,
      body: { role: 'customer' },
    }),
  );
  const second = await list({
    page_size: 1,
    before_at: first.next_cursor!.admitted_at,
    before_id: first.next_cursor!.id,
  });
  expect(second.items.map((x) => x.id)).toEqual([ids[1]]);
  const third = await list({
    page_size: 1,
    before_at: second.next_cursor!.admitted_at,
    before_id: second.next_cursor!.id,
  });
  expect(third.items.map((x) => x.id)).toEqual([ids[0]]);
  expect(third.next_cursor).toBeNull();
  expect((await list({ page_size: 3 })).next_cursor).toBeNull();
  expect(JSON.stringify(await list())).not.toContain('other-secret-agent');
  expect((await list({ before_at: third.items[0].admitted_at, before_id: ids[0] })).items).toEqual([]);
  const otherPage = await checked<Page>(rpc('list_my_mcp_tool_calls', {}, other.token));
  expect(otherPage.items.map((x) => x.client_id)).toEqual(['other-secret-agent']);
});
