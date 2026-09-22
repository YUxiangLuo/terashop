import { expect, test } from 'bun:test';
import Provider from 'oidc-provider';
import { generateKeyPairSync } from 'node:crypto';
import { createOidcApproval } from '../../mcp/src/oidc-approval';
import { createCredentialCipher, type CredentialEnvelope } from '../../mcp/src/credentials';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
async function fixture(
  fail?:
    | 'identity'
    | 'session'
    | 'create'
    | 'write'
    | 'revoke'
    | 'resolve'
    | 'scope'
    | 'binding'
    | 'envelope'
    | 'revoke-receipt',
) {
  const provider = new Provider('https://auth.example', {
    jwks: { keys: [{ ...privateKey.export({ format: 'jwk' }), kid: 'test', alg: 'ES256', use: 'sig' }] },
    clients: [
      {
        client_id: 'agent',
        token_endpoint_auth_method: 'none',
        id_token_signed_response_alg: 'ES256',
        redirect_uris: ['https://client.example/cb'],
      },
    ],
  });
  const cipher = await createCredentialCipher(
    new Map([['test', crypto.getRandomValues(new Uint8Array(32))]]),
    'test',
  );
  const identity = {
    userId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    credentials: {
      accessToken: 'downstream-access',
      refreshToken: 'downstream-refresh',
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    },
  };
  const config = {
    resource: 'https://shop.example/mcp',
    project: 'project',
    clientId: 'agent',
    scopes: ['store:read'] as const,
    supabaseUrl: 'https://db.example',
    anonKey: 'public-key',
    serviceRoleKey: 'service-secret',
  };
  const id = crypto.randomUUID();
  let binding: Record<string, string> | undefined, stored: CredentialEnvelope | undefined;
  let revoked = false;
  const calls: string[] = [];
  const request = async (url: string, init: RequestInit) => {
    const name = new URL(url).pathname.split('/').at(-1)!;
    const body = init.body ? JSON.parse(init.body as string) : {};
    calls.push(`${name}:${body.p_action ?? ''}`);
    const service = name.startsWith('mcp_');
    expect(new Headers(init.headers).get('Authorization')).toBe(
      service ? 'Bearer service-secret' : 'Bearer downstream-access',
    );
    if (name === 'user')
      return Response.json({
        id: fail === 'identity' ? crypto.randomUUID() : identity.userId,
        role: 'authenticated',
        is_anonymous: false,
      });
    if (name === 'is_admin') return Response.json(true);
    if (name === 'get_mcp_downstream_session')
      return Response.json({
        user_id: identity.userId,
        session_id: fail === 'session' ? crypto.randomUUID() : identity.sessionId,
      });
    if (name === 'mcp_grant_command') {
      if (body.p_action === 'create') {
        binding = body.p_binding;
        if (fail === 'create') throw new Error('lost secret creation response');
      }
      if (body.p_action === 'revoke') {
        if (fail === 'revoke') throw new Error('lost secret revoke response');
        revoked = true;
        stored = undefined;
        if (fail === 'revoke-receipt') return Response.json({ id, state: 'active', version: 1 });
      }
      if (body.p_action === 'resolve' && fail === 'resolve') return new Response(null, { status: 403 });
      return Response.json({
        id,
        user_id: identity.userId,
        scopes: fail === 'scope' && body.p_action === 'create' ? ['store:write'] : ['store:read'],
        state: revoked ? 'revoked' : 'active',
        version: revoked ? 2 : 1,
      });
    }
    if (name === 'mcp_bind_downstream_session')
      return Response.json({
        grant_id: id,
        session_id: fail === 'binding' ? crypto.randomUUID() : identity.sessionId,
      });
    if (name === 'mcp_credential_command') {
      expect(body.p_expected_revision).toBe(0);
      expect(JSON.stringify(body)).not.toContain('downstream-');
      stored = body.p_envelope;
      if (fail === 'write' || fail === 'revoke' || fail === 'revoke-receipt')
        throw new Error('lost secret write response');
      if (fail === 'envelope') return Response.json({ revision: 1, envelope: { ...stored, keyId: 'other' } });
      return Response.json({ revision: 1, envelope: stored });
    }
    throw new Error('Unexpected request');
  };
  return {
    provider,
    cipher,
    identity,
    config,
    calls,
    id,
    approval: createOidcApproval(provider, config, cipher, request),
    state: () => ({ binding, stored, revoked }),
  };
}

test('initial approval pins UUID/session/scopes and persists encrypted credentials before returning grant IDs', async () => {
  const f = await fixture();
  const result = await f.approval.approve(f.identity);
  expect(result.grantId).toBe(f.id);
  expect(Object.keys(result).sort()).toEqual(['grantId', 'providerGrantId']);
  expect(f.state().binding).toEqual({
    issuer: 'https://auth.example',
    subject: f.identity.userId,
    client_id: 'agent',
    resource: f.config.resource,
    project: 'project',
    session_id: result.providerGrantId,
  });
  const grant = await f.provider.Grant.find(result.providerGrantId);
  expect(grant?.accountId).toBe(f.identity.userId);
  expect(grant?.getResourceScope(f.config.resource)).toBe('store:read');
  expect(
    await f.cipher.open(
      { project: 'project', grantId: f.id, userId: f.identity.userId, revision: 1 },
      f.state().stored!,
    ),
  ).toEqual(f.identity.credentials);
  await expect(f.approval.approve(f.identity)).rejects.toThrow('APPROVAL_ALREADY_ATTEMPTED');
});

test('changed admin or same-user different session is rejected before any grant creation', async () => {
  for (const fail of ['identity', 'session'] as const) {
    const f = await fixture(fail);
    await expect(f.approval.approve(f.identity)).rejects.toThrow(/^APPROVAL_UNCONFIRMED$/);
    expect(f.calls.some((x) => x.startsWith('mcp_'))).toBe(false);
  }
});

test('lost receipts never retry; known grants are revoked and unknown cleanup is explicit', async () => {
  for (const fail of ['create', 'write', 'revoke', 'resolve'] as const) {
    const f = await fixture(fail);
    await expect(f.approval.approve(f.identity)).rejects.toThrow(
      fail === 'create' || fail === 'revoke' ? /^APPROVAL_CLEANUP_UNCONFIRMED$/ : /^APPROVAL_UNCONFIRMED$/,
    );
    expect(await f.provider.Grant.find(f.state().binding!.session_id)).toBeUndefined();
    expect(f.calls.filter((x) => x === 'mcp_grant_command:create')).toHaveLength(1);
    expect(f.calls.filter((x) => x === 'mcp_credential_command:write').length).toBe(
      fail === 'create' ? 0 : 1,
    );
    if (fail === 'write' || fail === 'resolve')
      expect(f.state()).toMatchObject({ revoked: true, stored: undefined });
    await expect(f.approval.approve(f.identity)).rejects.toThrow('APPROVAL_ALREADY_ATTEMPTED');
  }
});

test('simultaneous approvals admit only one attempt and expired login cannot create a grant', async () => {
  const f = await fixture();
  const results = await Promise.allSettled([f.approval.approve(f.identity), f.approval.approve(f.identity)]);
  expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
  expect(f.calls.filter((x) => x === 'mcp_grant_command:create')).toHaveLength(1);
  const expired = await fixture();
  expired.identity.credentials.expiresAt = Math.floor(Date.now() / 1000);
  await expect(expired.approval.approve(expired.identity)).rejects.toThrow(/^APPROVAL_UNCONFIRMED$/);
  expect(expired.calls).toHaveLength(0);
});

test('mismatched persistence receipts cannot complete approval or falsely confirm cleanup', async () => {
  for (const fail of ['scope', 'binding', 'envelope', 'revoke-receipt'] as const) {
    const f = await fixture(fail);
    await expect(f.approval.approve(f.identity)).rejects.toThrow(
      fail === 'revoke-receipt' ? /^APPROVAL_CLEANUP_UNCONFIRMED$/ : /^APPROVAL_UNCONFIRMED$/,
    );
    expect(await f.provider.Grant.find(f.state().binding!.session_id)).toBeUndefined();
    expect(f.state().revoked).toBe(true);
    if (fail === 'scope' || fail === 'binding')
      expect(f.calls.filter((x) => x === 'mcp_credential_command:write')).toHaveLength(0);
  }
});
