import { expect, spyOn, test } from 'bun:test';
import { KeycloakGrantAuthorizer, type AuthorizationConfig } from '../../mcp/src/authorization';
import { createCredentialCipher } from '../../mcp/src/credentials';

async function fixture() {
  const config: AuthorizationConfig = {
    issuer: 'https://auth.example/realm',
    introspectionEndpoint: 'https://auth.example/introspect',
    introspectionClientId: 'host',
    introspectionClientSecret: 'upstream-secret',
    resource: 'https://shop.example/mcp',
    project: 'project-a',
    supabaseUrl: 'https://db.example',
    serviceRoleKey: 'service-secret',
    scopes: ['store:read'],
  };
  const grant = {
    id: crypto.randomUUID(),
    user_id: crypto.randomUUID(),
    state: 'active',
    version: 1,
    scopes: ['store:read'],
  };
  const claims = {
    active: true,
    typ: 'Bearer',
    iss: config.issuer,
    aud: config.resource,
    sub: 'person-a',
    client_id: 'agent',
    sid: 'session',
    exp: Math.floor(Date.now() / 1000) + 300,
    scope: 'store:read',
  };
  const state = {
    stored: { revision: 0, envelope: null as unknown },
    userId: grant.user_id,
    loseAck: false,
    corruptAck: false,
  };
  const calls: { url: string; init: RequestInit }[] = [];
  const request = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url === config.introspectionEndpoint) return Response.json(claims);
    if (url.endsWith('/mcp_grant_command')) return Response.json(grant);
    if (url.endsWith('/auth/v1/user'))
      return Response.json({ id: state.userId, role: 'authenticated', is_anonymous: false });
    if (url.endsWith('/is_admin')) return Response.json(true);
    if (!url.endsWith('/mcp_credential_command')) throw new Error('Unexpected request');
    const body = JSON.parse(init.body as string);
    expect(body.p_binding).toEqual({
      issuer: config.issuer,
      subject: 'person-a',
      client_id: 'agent',
      resource: config.resource,
      project: config.project,
      session_id: 'session',
    });
    expect(body.p_grant_id).toBe(grant.id);
    expect(body.p_user_id).toBe(grant.user_id);
    if (body.p_action === 'write') {
      if (body.p_expected_revision !== state.stored.revision)
        return Response.json({ code: 'PT409' }, { status: 409 });
      state.stored = { revision: state.stored.revision + 1, envelope: body.p_envelope };
      if (state.loseAck) throw new Error('Network failure with secret detail');
      if (state.corruptAck) return Response.json({ revision: state.stored.revision, envelope: {} });
    }
    return Response.json(state.stored);
  };
  const cipher = await createCredentialCipher(
    new Map([['test', crypto.getRandomValues(new Uint8Array(32))]]),
    'test',
  );
  const input = {
    expectedRevision: 0,
    anonKey: 'anon-key',
    credentials: {
      accessToken: 'downstream-access',
      refreshToken: 'downstream-refresh',
      expiresAt: 1700000000,
    },
  };
  return {
    config,
    grant,
    claims,
    state,
    calls,
    request,
    cipher,
    input,
    host: new KeycloakGrantAuthorizer(config, request),
  };
}

test('host persists only ciphertext and authenticates downstream user before writing', async () => {
  const f = await fixture();
  expect(await f.host.readCredentials('inbound', f.cipher)).toEqual({
    grantId: f.grant.id,
    expectedUserId: f.grant.user_id,
    revision: 0,
    credentials: null,
  });
  expect(await f.host.writeCredentials('inbound', f.cipher, f.input)).toEqual({ revision: 1 });
  const restarted = new KeycloakGrantAuthorizer(f.config, f.request);
  expect((await restarted.readCredentials('inbound', f.cipher)).credentials).toEqual(f.input.credentials);
  const writes = f.calls.filter(
    ({ url, init }) =>
      url.endsWith('/mcp_credential_command') && JSON.parse(init.body as string).p_action === 'write',
  );
  expect(writes).toHaveLength(1);
  expect(writes[0].init.body).not.toContain('downstream-');
  expect(writes[0].init.body).not.toContain('inbound');
  const auth = f.calls.find(({ url }) => url.endsWith('/auth/v1/user'))!;
  expect(new Headers(auth.init.headers).get('Authorization')).toBe('Bearer downstream-access');
  expect(new Headers(auth.init.headers).get('apikey')).toBe('anon-key');
  expect(f.calls.indexOf(auth)).toBeLessThan(f.calls.indexOf(writes[0]));
  expect(writes[0].init.redirect).toBe('error');
  expect(writes[0].init.cache).toBe('no-store');
});

test('wrong downstream admin, revoked grant and inactive upstream stop before credential storage', async () => {
  for (const fault of ['user', 'grant', 'upstream']) {
    const f = await fixture();
    if (fault === 'user') f.state.userId = crypto.randomUUID();
    if (fault === 'grant') f.grant.state = 'revoked';
    if (fault === 'upstream') f.claims.active = false;
    await expect(f.host.writeCredentials('inbound', f.cipher, f.input)).rejects.toThrow(
      /^CREDENTIAL_WRITE_UNCONFIRMED$/,
    );
    expect(f.calls.some(({ url }) => url.endsWith('/mcp_credential_command'))).toBe(false);
  }
});

test('unknown write outcome and CAS conflicts never retry; reread recovers committed revision', async () => {
  for (const fault of ['loseAck', 'corruptAck'] as const) {
    const f = await fixture();
    f.state[fault] = true;
    await expect(f.host.writeCredentials('inbound', f.cipher, f.input)).rejects.toThrow(
      /^CREDENTIAL_WRITE_UNCONFIRMED$/,
    );
    expect(f.calls.filter(({ url }) => url.endsWith('/mcp_credential_command'))).toHaveLength(1);
    const recovered = await f.host.readCredentials('inbound', f.cipher);
    expect(recovered.revision).toBe(1);
    expect(recovered.credentials).toEqual(f.input.credentials);
    await expect(f.host.writeCredentials('inbound', f.cipher, f.input)).rejects.toThrow(
      /^CREDENTIAL_WRITE_UNCONFIRMED$/,
    );
    expect(f.state.stored.revision).toBe(1);
  }
});

test('invalid responses and stale ciphertext revisions never disclose credentials', async () => {
  const f = await fixture();
  await f.host.writeCredentials('inbound', f.cipher, f.input);
  const envelope = f.state.stored.envelope;
  for (const stored of [
    { revision: 2, envelope },
    { revision: 0, envelope },
    { revision: 1, envelope: null },
    { revision: -1, envelope },
    { revision: 1, envelope: { secret: 'leak' } },
  ]) {
    f.state.stored = stored;
    await expect(f.host.readCredentials('inbound', f.cipher)).rejects.toThrow(/^CREDENTIAL_READ_FAILED$/);
  }
});

test('upstream expiration during storage access prevents returning plaintext', async () => {
  const clock = spyOn(Date, 'now').mockReturnValue(2_000_000_000_000);
  try {
    const f = await fixture();
    await f.host.writeCredentials('inbound', f.cipher, f.input);
    const host = new KeycloakGrantAuthorizer(f.config, async (url, init) => {
      const response = await f.request(url, init);
      if (url.endsWith('/mcp_credential_command')) clock.mockReturnValue((f.claims.exp + 1) * 1000);
      return response;
    });
    await expect(host.readCredentials('inbound', f.cipher)).rejects.toThrow(/^CREDENTIAL_READ_FAILED$/);
  } finally {
    clock.mockRestore();
  }
});
