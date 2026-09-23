import { expect, test } from 'bun:test';
import { cleanupOidcConnections } from '../../mcp/src/oidc-connection-cleanup';

const config = {
  issuer: 'https://auth.example',
  resource: 'https://shop.example/mcp',
  project: 'test',
  supabaseUrl: 'https://db.example',
  serviceRoleKey: 'secret-canary',
};
const id = crypto.randomUUID();
test('cleanup never acknowledges failed destruction, and repeats destruction after a lost acknowledgement', async () => {
  let acknowledged = false,
    fail = true,
    destroyed = 0;
  const request = async (_: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    expect(body.p_issuer).toBe(config.issuer);
    expect(body.p_resource).toBe(config.resource);
    expect(body.p_project).toBe(config.project);
    if (body.p_action === 'list')
      return Response.json(
        acknowledged ? [] : [{ id, upstream_grant_id: 'grant-one' }],
      );
    expect(destroyed).toBeGreaterThan(0);
    if (fail) throw Error('secret-canary');
    acknowledged = true;
    return Response.json({ id, cleanup: 'completed' });
  };
  await expect(
    cleanupOidcConnections(
      config,
      async () => {
        throw Error('db-secret');
      },
      request,
    ),
  ).rejects.toThrow(/^OIDC_CONNECTION_CLEANUP_UNCONFIRMED$/);
  expect(acknowledged).toBe(false);
  const revoke = async (value: string) => {
    expect(value).toBe('grant-one');
    destroyed++;
  };
  await expect(cleanupOidcConnections(config, revoke, request)).rejects.toThrow(
    'OIDC_CONNECTION_CLEANUP_UNCONFIRMED',
  );
  fail = false;
  expect(await cleanupOidcConnections(config, revoke, request)).toBe(1);
  expect(destroyed).toBe(2);
  expect(await cleanupOidcConnections(config, revoke, request)).toBe(0);
});
test('cleanup rejects oversized batches and mismatched receipts; shutdown prevents acknowledgement', async () => {
  let calls = 0,
    active = true;
  const request = async (_: string, init: RequestInit) => {
    calls++;
    return Response.json(
      JSON.parse(String(init.body)).p_action === 'list'
        ? [{ id, upstream_grant_id: 'upstream' }]
        : { id: crypto.randomUUID(), cleanup: 'completed' },
    );
  };
  await expect(
    cleanupOidcConnections(config, async () => {}, request),
  ).rejects.toThrow('OIDC_CONNECTION_CLEANUP_UNCONFIRMED');
  calls = 0;
  await expect(
    cleanupOidcConnections(
      config,
      async () => {
        active = false;
      },
      request,
      () => active,
    ),
  ).rejects.toThrow('OIDC_CONNECTION_CLEANUP_UNCONFIRMED');
  expect(calls).toBe(1);
  await expect(
    cleanupOidcConnections(
      config,
      async () => {
        throw Error('must not execute');
      },
      async () =>
        Response.json(Array(21).fill({ id, upstream_grant_id: 'upstream' })),
    ),
  ).rejects.toThrow('OIDC_CONNECTION_CLEANUP_UNCONFIRMED');
});
