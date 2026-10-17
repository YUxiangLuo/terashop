import { expect, test } from 'bun:test';
import { AdminBackend } from '../../mcp/src/backend';
import { createToolAudit } from '../../mcp/src/tool-audit';
import { mcpSession } from '../support/mcp';
import { auditResourceRef } from '../../mcp/src/audit-resource-ref';

const config = {
  issuer: 'https://auth.example',
  resource: 'https://shop.example/mcp',
  project: 'test',
  supabaseUrl: 'https://db.example/',
  serviceRoleKey: 'SERVICE-SECRET',
  introspectionEndpoint: 'https://auth.example/introspect',
  introspectionClientId: 'resource',
  introspectionClientSecret: 'INTROSPECTION-SECRET',
  scopes: ['store:read'] as const,
};
const identity = { grantId: crypto.randomUUID(), expectedUserId: crypto.randomUUID() };

test('resource references use only exact tool/key mappings and UUIDs', () => {
  const id = crypto.randomUUID();
  expect(auditResourceRef('get_admin_product', { product_id: id, url: 'https://secret' })).toEqual({
    resourceType: 'product',
    resourceId: id,
  });
  expect(auditResourceRef('get_admin_product', { product_id: 'bad', order_id: id })).toBeUndefined();
  expect(auditResourceRef('unknown_tool', { product_id: id })).toBeUndefined();
  expect(auditResourceRef('get_admin_customer', { user_id: id })).toBeUndefined();
});

test('audit admits only the extracted resource reference and never repeats it at finish', async () => {
  const id = crypto.randomUUID();
  const bodies: Record<string, unknown>[] = [];
  const audit = createToolAudit(config, identity, async (_url, init) => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    return Response.json({ id: body.p_id, outcome: body.p_outcome ?? 'pending' });
  });
  const finish = await audit('update_order_admin_note', true, {
    order_id: id,
    changes: { admin_note: 'DO-NOT-AUDIT' },
    supplied_url: 'https://attacker.example/private',
  });
  await finish('returned');
  expect(bodies[0]).toMatchObject({ p_resource_type: 'order', p_resource_id: id });
  expect(bodies[1].p_resource_type).toBeUndefined();
  expect(bodies[1].p_resource_id).toBeUndefined();
  expect(JSON.stringify(bodies)).not.toContain('DO-NOT-AUDIT');
  expect(JSON.stringify(bodies)).not.toContain('attacker');
});

test('audit failures block dispatch or preserve uncertainty without retries; payloads never reach the audit writer', async () => {
  for (const mode of [
    'ok',
    'admit-fail',
    'admit-mismatch',
    'finish-fail',
    'reject-finish-fail',
    'business-reject',
    'business-unknown',
    'invalid-output',
  ] as const) {
    const bodies: Record<string, unknown>[] = [];
    let dispatches = 0;
    const audit = createToolAudit(config, identity, async (url, init) => {
      expect(url).toBe('https://db.example/rest/v1/rpc/mcp_tool_audit_command');
      expect(init.redirect).toBe('error');
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer SERVICE-SECRET');
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      if (
        (mode === 'admit-fail' && body.p_action === 'begin') ||
        (['finish-fail', 'reject-finish-fail'].includes(mode) && body.p_action === 'finish')
      )
        throw Error('PRIVATE-ERROR');
      return Response.json({
        id: mode === 'admit-mismatch' ? crypto.randomUUID() : body.p_id,
        outcome: body.p_outcome ?? 'pending',
      });
    });
    const id = crypto.randomUUID();
    const backend = new AdminBackend(
      { url: 'https://db.example', anonKey: 'public', accessToken: 'USER-SECRET' },
      async (url) => {
        if (url.endsWith('/auth/v1/user'))
          return Response.json({ id: identity.expectedUserId, role: 'authenticated', is_anonymous: false });
        if (url.endsWith('/is_admin')) return Response.json(true);
        dispatches++;
        if (mode === 'business-unknown') throw Error('PRIVATE-ERROR');
        if (mode === 'business-reject' || mode === 'reject-finish-fail')
          return Response.json({ code: 'PT409', message: 'PRIVATE-ERROR' }, { status: 409 });
        return Response.json(
          mode === 'invalid-output' ? { secret: 'PRIVATE-ERROR' } : { id, admin_note: 'PAYLOAD-SECRET' },
        );
      },
    );
    const session = await mcpSession(backend, true, undefined, undefined, audit);
    try {
      const result = await session.client.callTool({
        name: 'update_order_admin_note',
        arguments: {
          order_id: id,
          changes: { expected_admin_note: null, admin_note: 'PAYLOAD-SECRET' },
        },
      });
      expect(dispatches).toBe(mode.startsWith('admit-') ? 0 : 1);
      expect(bodies).toHaveLength(mode.startsWith('admit-') ? 1 : 2);
      expect(bodies[0]).toMatchObject({
        p_grant_id: identity.grantId,
        p_user_id: identity.expectedUserId,
        p_tool_name: 'update_order_admin_note',
        p_mutation: true,
      });
      if (bodies.length === 2) {
        expect(bodies[1].p_id).toBe(bodies[0].p_id);
        expect(bodies[1].p_outcome).toBe(
          mode === 'business-reject' || mode === 'reject-finish-fail'
            ? 'rejected'
            : ['business-unknown', 'invalid-output'].includes(mode)
              ? 'unknown'
              : 'returned',
        );
      }
      expect(JSON.stringify(bodies)).not.toContain('SECRET');
      expect(bodies[0]).toMatchObject({ p_resource_type: 'order', p_resource_id: id });
      expect(JSON.stringify(result)).not.toContain('PRIVATE-ERROR');
      if (mode === 'ok') expect(result.isError).not.toBe(true);
      else {
        expect(result.isError).toBe(true);
        expect(JSON.parse((result.content as { text: string }[])[0].text)).toMatchObject({
          code: mode.startsWith('admit-')
            ? 'AUDIT_UNAVAILABLE'
            : mode.includes('finish-fail')
              ? 'AUDIT_COMPLETION_UNCONFIRMED'
              : mode === 'business-reject'
                ? 'PT409'
                : mode === 'invalid-output'
                  ? 'INVALID_BACKEND_RESPONSE'
                  : 'BACKEND_UNAVAILABLE',
          outcome_unknown:
            !mode.startsWith('admit-') && !['business-reject', 'reject-finish-fail'].includes(mode),
        });
      }
    } finally {
      await session.close();
    }
  }
});

test('invalid inputs and revoked scopes never create admitted audit rows', async () => {
  let audits = 0;
  const backend = new AdminBackend(
    { url: 'https://db.example', anonKey: 'public', accessToken: 'secret' },
    async () => {
      throw Error('Must not dispatch');
    },
  );
  const session = await mcpSession(
    backend,
    false,
    { scopes: ['store:read'], currentScopes: async () => [] },
    undefined,
    async () => {
      audits++;
      return async () => {};
    },
  );
  try {
    for (const args of [{ product_id: 'bad' }, { product_id: crypto.randomUUID() }])
      expect((await session.client.callTool({ name: 'get_admin_product', arguments: args })).isError).toBe(
        true,
      );
    expect(audits).toBe(0);
  } finally {
    await session.close();
  }
});
