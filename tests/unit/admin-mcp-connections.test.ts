import { expect, test } from 'bun:test';
import { mcpOnboarding } from '../../admin/src/lib/mcp-onboarding';
import {
  confirmsRevocation,
  connectionPage,
  revocationPreview,
} from '../../admin/src/lib/mcp-connections';

test('onboarding preserves exact endpoints and offers only permitted non-sensitive presets', () => {
  const config = {
    resource: 'https://shop.example/mcp',
    issuer: 'https://auth.example',
    scopes: ['store:write', 'store:read', 'store:payments'],
  };
  const parsed = mcpOnboarding(JSON.stringify(config))!;
  expect(parsed.resource).toBe(config.resource);
  expect(parsed.issuer).toBe(config.issuer);
  expect(parsed.presets.map((p) => p.scopes)).toEqual([
    ['store:read'],
    ['store:read', 'store:write'],
  ]);
  expect(
    mcpOnboarding(JSON.stringify({ ...config, scopes: ['store:read'] }))!
      .presets,
  ).toHaveLength(1);
  expect(
    mcpOnboarding(JSON.stringify({ ...config, scopes: ['store:write'] }))!
      .presets,
  ).toHaveLength(0);
  expect(mcpOnboarding(undefined)).toBeNull();
  expect(mcpOnboarding('')).toBeNull();
  for (const change of [
    { resource: 'http://shop.example/mcp' },
    { resource: 'https://shop.example/' },
    { resource: 'https://user:secret@shop.example/mcp' },
    { resource: 'https://shop.example/mcp?token=x' },
    { resource: 'https://shop.example/mcp#fragment' },
    { resource: 'https://shop.example/a/../mcp' },
    { resource: ' https://shop.example/mcp' },
    { issuer: 'javascript:alert(1)' },
    { issuer: 'https://auth.example/?secret=x' },
    { access_token: 'secret' },
    { scopes: ['store:read', 'store:read'] },
    { scopes: ['store:unknown'] },
    { scopes: [] },
  ])
    expect(() =>
      mcpOnboarding(JSON.stringify({ ...config, ...change })),
    ).toThrow('Invalid PUBLIC_MCP_CONNECTION');
  for (const raw of ['null', '[]', '{}', 'not json'])
    expect(() => mcpOnboarding(raw)).toThrow();
});

test('revocation receipt must contain the exact selected IDs, regardless of ordering', () => {
  const a = crypto.randomUUID(),
    b = crypto.randomUUID(),
    c = crypto.randomUUID();
  expect(confirmsRevocation({ ids: [b, a], state: 'revoked' }, [a, b])).toBe(
    true,
  );
  for (const ids of [[a], [a, c], [a, a], [a, b, c]]) {
    expect(confirmsRevocation({ ids, state: 'revoked' }, [a, b])).toBe(false);
  }
  expect(confirmsRevocation({ ids: [a, b], state: 'active' }, [a, b])).toBe(
    false,
  );
});
test('connection pages reject malformed identities, scopes and pagination before actions are offered', () => {
  const row = {
    id: crypto.randomUUID(),
    client_id: '<script>untrusted</script>',
    resource: 'https://shop.example/mcp',
    scopes: ['store:read'],
    state: 'active',
    created_at: new Date().toISOString(),
    revoked_at: null,
    cleanup: 'not_requested',
  };
  expect(
    connectionPage({ items: [row], next_cursor: null }).items[0].state,
  ).toBe('active');
  for (const change of [
    { id: null },
    { scopes: 'store:read' },
    { cleanup: 'healthy' },
    { state: ['active'] },
    { cleanup: ['completed'] },
  ]) {
    expect(() =>
      connectionPage({ items: [{ ...row, ...change }], next_cursor: null }),
    ).toThrow();
  }
  expect(() =>
    connectionPage({ items: [row], next_cursor: 'not-a-cursor' }),
  ).toThrow();
  expect(revocationPreview({ items: [row], next_cursor: null })).toHaveLength(
    1,
  );
  expect(revocationPreview({ items: [], next_cursor: null })).toEqual([]);
  for (const page of [
    { items: [row], next_cursor: row.id },
    { items: [row, row], next_cursor: null },
    { items: [{ ...row, cleanup: 'pending' }], next_cursor: null },
    {
      items: Array.from({ length: 101 }, () => ({
        ...row,
        id: crypto.randomUUID(),
      })),
      next_cursor: null,
    },
  ])
    expect(() => revocationPreview(page)).toThrow();
});
