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
    | 'create-missing'
    | 'create-fenced'
    | 'write'
    | 'revoke'
    | 'resolve'
    | 'scope'
    | 'binding'
    | 'envelope'
    | 'revoke-receipt'
    | 'completion-revoke',
  journal?: Parameters<typeof createOidcApproval>[4],
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
        if (fail === 'create' || fail === 'create-missing' || fail === 'create-fenced')
          throw new Error('lost secret creation response');
      }
      if (body.p_action === 'revoke_binding') {
        expect(body.p_grant_id).toBeUndefined();
        expect(body.p_binding).toEqual(binding);
        if (fail === 'create-missing') return new Response(null, { status: 404 });
        if (fail === 'create-fenced')
          return Response.json({ id: null, user_id: null, scopes: [], state: 'revoked', version: 2 });
      }
      if (body.p_action === 'revoke' || body.p_action === 'revoke_binding') {
        if (fail === 'revoke' || fail === 'completion-revoke') throw new Error('lost secret revoke response');
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
    approval: createOidcApproval(provider, config, cipher, request, journal),
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
  for (const fail of ['create', 'create-missing', 'create-fenced', 'write', 'revoke', 'resolve'] as const) {
    const f = await fixture(fail);
    await expect(f.approval.approve(f.identity)).rejects.toThrow(
      fail === 'create-missing' || fail === 'revoke'
        ? /^APPROVAL_CLEANUP_UNCONFIRMED$/
        : /^APPROVAL_UNCONFIRMED$/,
    );
    expect(await f.provider.Grant.find(f.state().binding!.session_id)).toBeUndefined();
    expect(f.calls.filter((x) => x === 'mcp_grant_command:create')).toHaveLength(1);
    expect(f.calls.filter((x) => x === 'mcp_credential_command:write').length).toBe(
      fail === 'create' || fail === 'create-missing' || fail === 'create-fenced' ? 0 : 1,
    );
    if (fail === 'create' || fail === 'write' || fail === 'resolve')
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

test('journal admission precedes provider and local writes; uncertain admission retains recovery work', async () => {
  for (const fault of ['none', 'begin', 'finish', 'cleanup'] as const) {
    let f: Awaited<ReturnType<typeof fixture>>;
    let binding: Record<string, string> | undefined;
    const endings: string[] = [];
    const journal: NonNullable<Parameters<typeof createOidcApproval>[4]> = {
      interactionId: 'interaction-test',
      store: {
        async begin(entry) {
          expect(entry.interactionId).toBe('interaction-test');
          expect(f.calls).not.toContain('mcp_grant_command:create');
          expect(entry.binding.session_id).toMatch(/^[A-Za-z0-9_-]{43}$/);
          expect(await f.provider.Grant.find(entry.binding.session_id)).toBeUndefined();
          binding = entry.binding;
          if (fault === 'begin') throw new Error('Lost journal receipt');
        },
        async finish(id, state) {
          expect(id).toBe('interaction-test');
          expect(state).toBe('revoked');
          expect(f.state().revoked).toBe(true);
          expect(await f.provider.Grant.find(binding!.session_id)).toBeUndefined();
          endings.push(state);
          if (fault === 'finish') throw new Error('Lost terminal receipt');
        },
        async pending() {
          return [];
        },
      },
    };
    f = await fixture(fault === 'cleanup' ? 'revoke' : undefined, journal);
    if (fault === 'begin' || fault === 'cleanup') {
      await expect(f.approval.approve(f.identity)).rejects.toThrow('APPROVAL_CLEANUP_UNCONFIRMED');
      expect(endings).toEqual([]);
      if (fault === 'begin') expect(f.calls).not.toContain('mcp_grant_command:create');
    } else {
      await f.approval.approve(f.identity);
      expect(endings).toEqual([]); // Only the interaction host may mark completion.
      if (fault === 'finish')
        await expect(f.approval.revoke()).rejects.toThrow('APPROVAL_CLEANUP_UNCONFIRMED');
      else await f.approval.revoke();
      expect(endings).toEqual(['revoked']);
    }
  }
});

test('provider save failure after journal admission never creates a downstream grant', async () => {
  for (const fault of ['before-save', 'lost-receipt', 'wrong-id'] as const) {
    let recorded: string | undefined;
    const endings: string[] = [];
    const f = await fixture(undefined, {
      interactionId: 'save-failure',
      store: {
        async begin(entry) {
          recorded = entry.binding.session_id;
        },
        async finish(_id, state) {
          endings.push(state);
        },
        async pending() {
          return [];
        },
      },
    });
    const save = f.provider.Grant.prototype.save;
    f.provider.Grant.prototype.save = async function () {
      expect(this.jti).toBe(recorded!);
      if (fault === 'before-save') throw new Error('save failed');
      expect(await save.call(this)).toBe(recorded!);
      if (fault === 'lost-receipt') throw new Error('save receipt lost');
      return 'wrong-id';
    };
    try {
      await expect(f.approval.approve(f.identity)).rejects.toThrow(/^APPROVAL_UNCONFIRMED$/);
      expect(recorded).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(endings).toEqual(['revoked']);
      expect(await f.provider.Grant.find(recorded!)).toBeUndefined();
      expect(f.calls).not.toContain('mcp_grant_command:create');
    } finally {
      f.provider.Grant.prototype.save = save;
    }
  }
});

test('host can revoke a completed approval; a missing cleanup receipt is never called success', async () => {
  for (const fail of [undefined, 'completion-revoke'] as const) {
    const f = await fixture(fail);
    await expect(f.approval.revoke()).rejects.toThrow('APPROVAL_NOT_COMPLETED');
    const approved = await f.approval.approve(f.identity);
    if (fail) await expect(f.approval.revoke()).rejects.toThrow('APPROVAL_CLEANUP_UNCONFIRMED');
    else {
      await f.approval.revoke();
      expect(f.state()).toMatchObject({ revoked: true, stored: undefined });
    }
    expect(await f.provider.Grant.find(approved.providerGrantId)).toBeUndefined();
    await expect(f.approval.approve(f.identity)).rejects.toThrow('APPROVAL_ALREADY_ATTEMPTED');
  }
});
