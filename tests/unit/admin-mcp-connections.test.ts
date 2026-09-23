import { expect, test } from 'bun:test';
import {
  confirmsRevocation,
  connectionPage,
} from '../../admin/src/lib/mcp-connections';

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
});
