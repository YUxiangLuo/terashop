import { afterAll, beforeAll, expect, test } from 'bun:test';
import { AdminBackend } from '../mcp/src/backend';
import { API, ANON_KEY, api, checked, command, rpc, signup, makeAdmin, type TestUser } from './helpers';
import { mcpSession, toolData } from './support/mcp';
import { Cleanup } from './support/cleanup';

interface Category {
  id: string;
  slug: string;
  name: string;
  parent_id: string | null;
  image_url: string | null;
  description: string;
  position: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}
interface Page {
  items: Category[];
  next_cursor: string | null;
}
const cleanup = new Cleanup();
let admin: TestUser, customer: TestUser, session: Awaited<ReturnType<typeof mcpSession>>;
beforeAll(async () => {
  admin = await signup();
  customer = await signup();
  await makeAdmin(admin.userId);
  session = await mcpSession(
    new AdminBackend({ url: API, anonKey: ANON_KEY, accessToken: admin.token }),
    true,
  );
});
afterAll(async () => {
  try {
    await cleanup.run();
  } finally {
    await session?.close();
  }
});

async function create(changes: Record<string, unknown> = {}): Promise<Category> {
  const id = crypto.randomUUID();
  const category = await toolData<Category>(session.client, 'create_category', {
    category_id: id,
    changes: { slug: `category-${id}`, name: 'Test category', ...changes },
  });
  cleanup.defer(() => checked(api(`/rest/v1/categories?id=eq.${id}`, { method: 'DELETE', service: true })));
  return category;
}

test('分类 MCP 创建、移动、清空图片和停用；读令牌可用且冲突不覆盖', async () => {
  const root = await create();
  const child = await create({
    parent_id: root.id,
    position: -7,
    image_url: 'https://example.test/category.png',
  });
  expect(child).toMatchObject({ parent_id: root.id, position: -7, is_active: true });
  const unchanged = await toolData<Category>(session.client, 'update_category', {
    category_id: child.id,
    expected_updated_at: child.updated_at,
    changes: {},
  });
  expect(unchanged.updated_at).toBe(child.updated_at);
  const updated = await toolData<Category>(session.client, 'update_category', {
    category_id: child.id,
    expected_updated_at: child.updated_at,
    changes: { parent_id: null, image_url: null, is_active: false, name: 'Moved root' },
  });
  expect(updated).toMatchObject({
    parent_id: null,
    image_url: null,
    is_active: false,
    name: 'Moved root',
    position: -7,
  });
  expect(updated.updated_at).not.toBe(child.updated_at);
  expect(
    (
      await rpc(
        'update_category',
        { category_id: child.id, expected_updated_at: child.updated_at, changes: { name: 'stale' } },
        admin.token,
      )
    ).data,
  ).toMatchObject({ code: 'PT409' });
  expect(await toolData(session.client, 'get_admin_category', { category_id: child.id })).toMatchObject({
    name: 'Moved root',
    updated_at: updated.updated_at,
  });
  expect(
    await toolData(session.client, 'get_admin_category', { category_id: crypto.randomUUID() }),
  ).toBeNull();
});

test('分类分页不丢行，父分类/根/启用状态过滤及字面搜索互相独立', async () => {
  const marker = crypto.randomUUID();
  const root = await create({ name: `${marker} root`, is_active: false });
  const first = await create({ name: `${marker} 50%_off`, parent_id: root.id });
  const second = await create({ name: `${marker} other`, parent_id: root.id });
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const page: Page = await toolData(session.client, 'list_admin_categories', {
      search: marker,
      page_size: 1,
      ...(cursor ? { after_id: cursor } : {}),
    });
    seen.push(...page.items.map((row) => row.id));
    cursor = page.next_cursor;
    expect(seen.length).toBeLessThanOrEqual(3);
  } while (cursor);
  expect(seen).toEqual([root.id, first.id, second.id].sort());
  const children = await toolData<Page>(session.client, 'list_admin_categories', { parent_id: root.id });
  expect(children.items.map((row) => row.id)).toEqual([first.id, second.id].sort());
  const roots = await toolData<Page>(session.client, 'list_admin_categories', {
    search: marker,
    root_only: true,
    active: false,
  });
  expect(roots.items.map((row) => row.id)).toEqual([root.id]);
  const literal = await toolData<Page>(session.client, 'list_admin_categories', {
    parent_id: root.id,
    search: '%_',
  });
  expect(literal.items.map((row) => row.id)).toEqual([first.id]);
  // Deactivating a parent does not silently deactivate or hide its direct children.
  expect(children.items.every((row) => row.is_active)).toBe(true);
  expect(
    (await rpc('list_admin_categories', { root_only: true, parent_id: root.id }, admin.token)).data,
  ).toMatchObject({ code: '22023' });
});

test('分类环和悬空父节点原子回滚，重复 UUID 不覆盖', async () => {
  const root = await create();
  const child = await create({ parent_id: root.id });
  for (const parent of [root.id, child.id, crypto.randomUUID()]) {
    const result = await rpc(
      'update_category',
      {
        category_id: root.id,
        expected_updated_at: root.updated_at,
        changes: { parent_id: parent, name: 'Must rollback' },
      },
      admin.token,
    );
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(await toolData(session.client, 'get_admin_category', { category_id: root.id })).toMatchObject({
      parent_id: null,
      name: root.name,
      updated_at: root.updated_at,
    });
  }
  expect(
    (
      await command(
        'create_category',
        { category_id: root.id, changes: { slug: root.slug, name: 'Overwrite' } },
        admin.token,
      )
    ).data,
  ).toMatchObject({ code: '23505' });
});

test('分类 RPC 自身校验权限与 PATCH 白名单，失败创建不残留', async () => {
  const category = await create();
  for (const token of [undefined, customer.token]) {
    for (const [name, body] of [
      ['get_admin_category', { category_id: category.id }],
      ['list_admin_categories', {}],
      [
        'create_category',
        { category_id: crypto.randomUUID(), changes: { slug: crypto.randomUUID(), name: 'denied' } },
      ],
      [
        'update_category',
        { category_id: category.id, expected_updated_at: category.updated_at, changes: { name: 'denied' } },
      ],
    ] as const)
      expect((await rpc(name, body, token)).status).toBeGreaterThanOrEqual(400);
  }
  for (const changes of [
    { id: crypto.randomUUID() },
    { updated_at: category.updated_at },
    { is_active: 'false' },
    { name: null },
    { position: 1.5 },
    { position: 2147483648 },
  ]) {
    expect(
      (
        await rpc(
          'update_category',
          { category_id: category.id, expected_updated_at: category.updated_at, changes },
          admin.token,
        )
      ).status,
    ).toBeGreaterThanOrEqual(400);
  }
  const failedId = crypto.randomUUID();
  expect(
    (
      await rpc(
        'create_category',
        {
          category_id: failedId,
          changes: { slug: `invalid-${failedId}`, name: 'Invalid', unsupported: true },
        },
        admin.token,
      )
    ).data,
  ).toMatchObject({ code: '22023' });
  expect(await toolData(session.client, 'get_admin_category', { category_id: failedId })).toBeNull();
  expect(await toolData(session.client, 'get_admin_category', { category_id: category.id })).toMatchObject({
    name: category.name,
    updated_at: category.updated_at,
  });
});

test('两个使用相同分类令牌的并发编辑只允许一个成功', async () => {
  const category = await create();
  const results = await Promise.all(
    ['first', 'second'].map((name) =>
      command(
        'update_category',
        {
          category_id: category.id,
          expected_updated_at: category.updated_at,
          changes: { name },
        },
        admin.token,
      ),
    ),
  );
  expect(results.filter((result) => result.status === 200)).toHaveLength(1);
  const loser = results.find((result) => result.status !== 200)!;
  expect(['PT409', '55P03']).toContain((loser.data as { code: string }).code);
  const winner = results.findIndex((result) => result.status === 200);
  expect(await toolData(session.client, 'get_admin_category', { category_id: category.id })).toMatchObject({
    name: ['first', 'second'][winner],
  });
});
