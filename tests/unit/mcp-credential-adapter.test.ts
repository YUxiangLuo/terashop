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
    sessionId: crypto.randomUUID(),
    boundSession: null as string | null,
    loseAck: false,
    corruptAck: false,
    refreshId: null as string | null,
    currentAccess: 'downstream-access',
    onRefresh: async () => {},
  };
  const calls: { url: string; init: RequestInit }[] = [];
  const request = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url === config.introspectionEndpoint) return Response.json(claims);
    if (url.endsWith('/mcp_grant_command')) return Response.json(grant);
    if (url.endsWith('?grant_type=refresh_token')) {
      await state.onRefresh();
      state.currentAccess = 'rotated-access';
      return Response.json({
        access_token: state.currentAccess,
        refresh_token: 'rotated-refresh',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        token_type: 'bearer',
        user: { id: state.userId, is_anonymous: false },
      });
    }
    if (url.endsWith('/auth/v1/user'))
      return Response.json({ id: state.userId, role: 'authenticated', is_anonymous: false });
    if (url.endsWith('/is_admin')) return Response.json(true);
    if (url.endsWith('/get_mcp_downstream_session')) {
      expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${state.currentAccess}`);
      return Response.json({ user_id: state.userId, session_id: state.sessionId });
    }
    if (url.endsWith('/mcp_bind_downstream_session')) {
      const body = JSON.parse(init.body as string);
      expect(body.p_grant_id).toBe(grant.id);
      expect(body.p_user_id).toBe(grant.user_id);
      expect(body.p_session_id).toBe(state.sessionId);
      if (state.boundSession !== null && state.boundSession !== body.p_session_id)
        return Response.json({ code: 'PT409' }, { status: 409 });
      state.boundSession = body.p_session_id;
      return Response.json({ grant_id: grant.id, session_id: state.boundSession });
    }
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
    if (body.p_action === 'claim_refresh') {
      if (state.refreshId || body.p_expected_revision !== state.stored.revision || !state.stored.envelope)
        return Response.json({ code: 'PT409' }, { status: 409 });
      state.refreshId = crypto.randomUUID();
      return Response.json({ ...state.stored, refresh_id: state.refreshId });
    }
    if (state.refreshId && body.p_action !== 'complete_refresh')
      return Response.json({ code: 'PT409' }, { status: 409 });
    if (body.p_action === 'complete_refresh' && (!state.refreshId || state.refreshId !== body.p_refresh_id))
      return Response.json({ code: 'PT409' }, { status: 409 });
    if (body.p_action === 'write' || body.p_action === 'complete_refresh') {
      if (body.p_expected_revision !== state.stored.revision)
        return Response.json({ code: 'PT409' }, { status: 409 });
      state.stored = { revision: state.stored.revision + 1, envelope: body.p_envelope };
      state.refreshId = null;
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

test('same user with another session and invalid binding acknowledgements cannot replace credentials', async () => {
  const f = await fixture();
  await f.host.writeCredentials('inbound', f.cipher, f.input);
  f.state.sessionId = crypto.randomUUID();
  await expect(
    f.host.writeCredentials('inbound', f.cipher, { ...f.input, expectedRevision: 1 }),
  ).rejects.toThrow(/^CREDENTIAL_WRITE_UNCONFIRMED$/);
  expect(f.state.stored.revision).toBe(1);
  for (const bad of [
    { grant_id: crypto.randomUUID(), session_id: f.state.sessionId },
    { grant_id: f.grant.id, session_id: crypto.randomUUID() },
    {},
  ]) {
    const host = new KeycloakGrantAuthorizer(f.config, async (url, init) => {
      if (url.endsWith('/mcp_bind_downstream_session')) return Response.json(bad);
      return f.request(url, init);
    });
    await expect(
      host.writeCredentials('inbound', f.cipher, { ...f.input, expectedRevision: 1 }),
    ).rejects.toThrow(/^CREDENTIAL_WRITE_UNCONFIRMED$/);
    expect(f.state.stored.revision).toBe(1);
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

test('refresh claims once, uses only the public key at Auth and commits only rotated ciphertext', async () => {
  const f = await fixture();
  await f.host.writeCredentials('inbound', f.cipher, f.input);
  expect(
    await f.host.refreshCredentials('inbound', f.cipher, { expectedRevision: 1, anonKey: 'anon-key' }),
  ).toEqual({ revision: 2 });
  const refreshed = await f.host.readCredentials('inbound', f.cipher);
  expect(refreshed.credentials).toMatchObject({
    accessToken: 'rotated-access',
    refreshToken: 'rotated-refresh',
  });
  const refresh = f.calls.find((c) => c.url.endsWith('?grant_type=refresh_token'))!;
  expect(refresh.url).toBe('https://db.example/auth/v1/token?grant_type=refresh_token');
  expect(JSON.parse(refresh.init.body as string)).toEqual({ refresh_token: 'downstream-refresh' });
  expect(new Headers(refresh.init.headers).get('Authorization')).toBeNull();
  expect(new Headers(refresh.init.headers).get('apikey')).toBe('anon-key');
  expect(refresh.init.redirect).toBe('error');
  expect(refresh.init.signal).toBeInstanceOf(AbortSignal);
  const completion = f.calls.find(
    (c) =>
      c.url.endsWith('/mcp_credential_command') &&
      JSON.parse(c.init.body as string).p_action === 'complete_refresh',
  )!;
  expect(completion.init.body).not.toContain('rotated-');
  expect(f.calls.indexOf(completion)).toBeGreaterThan(f.calls.indexOf(refresh));
});

test('concurrent refresh callers send at most one provider request for a revision', async () => {
  const f = await fixture();
  await f.host.writeCredentials('inbound', f.cipher, f.input);
  const hosts = [f.host, new KeycloakGrantAuthorizer(f.config, f.request)];
  const results = await Promise.allSettled(
    hosts.map((host) =>
      host.refreshCredentials('inbound', f.cipher, { expectedRevision: 1, anonKey: 'anon-key' }),
    ),
  );
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(f.calls.filter((c) => c.url.endsWith('?grant_type=refresh_token'))).toHaveLength(1);
  expect(f.state.stored.revision).toBe(2);
});

test('wrong refreshed user/session, revocation and lost provider result leave the durable claim blocked', async () => {
  for (const fault of ['user', 'session', 'upstream', 'grant', 'network']) {
    const f = await fixture();
    await f.host.writeCredentials('inbound', f.cipher, f.input);
    f.state.onRefresh = async () => {
      if (fault === 'user') f.state.userId = crypto.randomUUID();
      if (fault === 'session') f.state.sessionId = crypto.randomUUID();
      if (fault === 'upstream') f.claims.active = false;
      if (fault === 'grant') f.grant.state = 'revoked';
      if (fault === 'network') throw new Error('secret lost refresh response');
    };
    const refresh = () =>
      f.host.refreshCredentials('inbound', f.cipher, { expectedRevision: 1, anonKey: 'anon-key' });
    await expect(refresh()).rejects.toThrow(/^CREDENTIAL_REFRESH_UNCONFIRMED$/);
    await expect(refresh()).rejects.toThrow(/^CREDENTIAL_REFRESH_UNCONFIRMED$/);
    expect(f.state.stored.revision).toBe(1);
    expect(f.state.refreshId).not.toBeNull();
    expect(f.calls.filter((c) => c.url.endsWith('?grant_type=refresh_token'))).toHaveLength(1);
    await expect(f.host.readCredentials('inbound', f.cipher)).rejects.toThrow(/^CREDENTIAL_READ_FAILED$/);
  }
});

test('lost claim acknowledgement never calls Auth; lost completion is recoverable by authorized reread', async () => {
  for (const lost of ['claim_refresh', 'complete_refresh']) {
    const f = await fixture();
    await f.host.writeCredentials('inbound', f.cipher, f.input);
    const host = new KeycloakGrantAuthorizer(f.config, async (url, init) => {
      const response = await f.request(url, init);
      if (url.endsWith('/mcp_credential_command') && JSON.parse(init.body as string).p_action === lost)
        throw new Error('lost acknowledgement');
      return response;
    });
    await expect(
      host.refreshCredentials('inbound', f.cipher, { expectedRevision: 1, anonKey: 'anon-key' }),
    ).rejects.toThrow(/^CREDENTIAL_REFRESH_UNCONFIRMED$/);
    expect(f.calls.filter((c) => c.url.endsWith('?grant_type=refresh_token'))).toHaveLength(
      lost === 'claim_refresh' ? 0 : 1,
    );
    if (lost === 'claim_refresh') {
      await expect(f.host.readCredentials('inbound', f.cipher)).rejects.toThrow(/^CREDENTIAL_READ_FAILED$/);
    } else {
      expect((await f.host.readCredentials('inbound', f.cipher)).credentials?.refreshToken).toBe(
        'rotated-refresh',
      );
      expect(f.state.stored.revision).toBe(2);
    }
  }
});

test('revocation after admission prevents sending the refresh token to Auth', async () => {
  const f = await fixture();
  await f.host.writeCredentials('inbound', f.cipher, f.input);
  const host = new KeycloakGrantAuthorizer(f.config, async (url, init) => {
    const response = await f.request(url, init);
    if (
      url.endsWith('/mcp_credential_command') &&
      JSON.parse(init.body as string).p_action === 'claim_refresh'
    )
      f.claims.active = false;
    return response;
  });
  await expect(
    host.refreshCredentials('inbound', f.cipher, { expectedRevision: 1, anonKey: 'anon-key' }),
  ).rejects.toThrow(/^CREDENTIAL_REFRESH_UNCONFIRMED$/);
  expect(f.state.refreshId).not.toBeNull();
  expect(f.calls.some((c) => c.url.endsWith('?grant_type=refresh_token'))).toBe(false);
});

test('malformed or expired refreshed pairs cannot complete or release a claimed revision', async () => {
  for (const fault of ['expiry', 'anonymous', 'missingRefresh', 'badAccess']) {
    const f = await fixture();
    await f.host.writeCredentials('inbound', f.cipher, f.input);
    const host = new KeycloakGrantAuthorizer(f.config, async (url, init) => {
      const response = await f.request(url, init);
      if (!url.endsWith('?grant_type=refresh_token')) return response;
      const result = await response.json();
      if (fault === 'expiry') result.expires_at = Math.floor(Date.now() / 1000);
      if (fault === 'anonymous') result.user.is_anonymous = true;
      if (fault === 'missingRefresh') delete result.refresh_token;
      if (fault === 'badAccess') result.access_token = 'bad token';
      return Response.json(result);
    });
    await expect(
      host.refreshCredentials('inbound', f.cipher, { expectedRevision: 1, anonKey: 'anon-key' }),
    ).rejects.toThrow(/^CREDENTIAL_REFRESH_UNCONFIRMED$/);
    expect(f.state.stored.revision).toBe(1);
    expect(f.state.refreshId).not.toBeNull();
    expect(
      f.calls.some(
        (c) =>
          c.url.endsWith('/mcp_credential_command') &&
          JSON.parse(c.init.body as string).p_action === 'complete_refresh',
      ),
    ).toBe(false);
  }
});
