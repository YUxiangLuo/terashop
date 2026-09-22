import { createServer } from 'node:https';
import { X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import postgres from 'postgres';
import * as z from 'zod/v4';
import { createOidcProvider, oidcProviderConfiguration } from './oidc-provider';
import { createOidcAdapter } from './oidc-adapter';
import { createOidcInteractionHandler } from './oidc-interaction';
import { createOidcTlsHandler, readOidcProviderConfiguration } from './oidc-host';
import { createCredentialCipher } from './credentials';
import { createOidcApprovalJournal } from './oidc-journal';
import { recoverOidcApprovals } from './oidc-recovery';

const secret = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value);
const backendUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.pathname === '/' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
    );
  });
const configuration = z.strictObject({
  provider: oidcProviderConfiguration,
  databaseUrl: z.string().url(),
  downstream: z.strictObject({
    project: secret.max(512),
    supabaseUrl: backendUrl,
    anonKey: secret,
    serviceRoleKey: secret,
    callbackUrl: z.string().url(),
  }),
  credentialKeys: z.record(z.string(), z.string()).refine((keys) => Object.keys(keys).length <= 8),
  activeCredentialKey: secret,
  tls: z.strictObject({ key: z.string().min(1), cert: z.string().min(1) }),
  listen: z.strictObject({
    host: z.enum(['127.0.0.1', '::1', '0.0.0.0']),
    port: z.number().int().min(0).max(65535),
  }),
});

// Node deployment entrypoint calls this after checking runtime support. No schema
// creation/migrations, automatic secrets, proxy trust or business-service-role RPCs.
export async function startOidcService(path: string) {
  let database: postgres.Sql | undefined;
  let ownerDatabase: postgres.Sql | undefined;
  let owner: postgres.ReservedSql | undefined;
  let ownerClosed = false;
  let releasingOwner = false;
  const ownershipLost = Promise.withResolvers<void>();
  let server: ReturnType<typeof createServer> | undefined;
  const pending = new Set<Promise<void>>();
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
      await Promise.allSettled([...pending]);
      try {
        await database?.end({ timeout: 5 });
      } finally {
        releasingOwner = true;
        owner?.release();
        await ownerDatabase?.end({ timeout: 5 });
      }
    })());
  try {
    const c = configuration.parse(await readOidcProviderConfiguration(path));
    const url = new URL(c.databaseUrl);
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.username ||
      !url.password ||
      url.search ||
      url.hash ||
      url.pathname === '/'
    )
      throw new Error('Invalid database');
    const certificate = new X509Certificate(c.tls.cert);
    const hostname = new URL(c.provider.issuer).hostname.replace(/^\[|\]$/g, '');
    if (
      !(isIP(hostname) ? certificate.checkIP(hostname) : certificate.checkHost(hostname)) ||
      Date.parse(certificate.validFrom) > Date.now() ||
      Date.parse(certificate.validTo) <= Date.now()
    )
      throw new Error('Invalid certificate');
    const material = new Map(
      Object.entries(c.credentialKeys).map(([id, encoded]) => {
        const bytes = Buffer.from(encoded, 'base64url');
        if (bytes.toString('base64url') !== encoded) throw new Error('Invalid encryption key');
        return [id, bytes] as const;
      }),
    );
    let cipher: Awaited<ReturnType<typeof createCredentialCipher>>;
    try {
      cipher = await createCredentialCipher(material, c.activeCredentialKey);
    } finally {
      for (const bytes of material.values()) bytes.fill(0);
    }
    database = postgres(c.databaseUrl, {
      max: 4,
      connect_timeout: 5,
      connection: { statement_timeout: 10000 },
      ssl: ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ? false : 'verify-full',
      onnotice: () => {},
    });
    const provider = createOidcProvider(c.provider, createOidcAdapter(database));
    provider.silent = true; // Koa must not print raw database/provider errors.
    const interaction = createOidcInteractionHandler(
      provider,
      {
        ...c.downstream,
        publicOrigin: provider.issuer,
        resource: c.provider.resource,
        scopes: c.provider.scopes,
      },
      cipher,
      fetch,
      createOidcApprovalJournal(database),
    );
    const handler = createOidcTlsHandler(provider, interaction);
    // Constructing HTTPS validates the certificate/private-key pair before any DB IO.
    server = createServer({ ...c.tls, minVersion: 'TLSv1.2', handshakeTimeout: 10_000 }, (req, res) => {
      if (closing || ownerClosed) {
        res.writeHead(503, { 'Cache-Control': 'no-store', Connection: 'close' });
        res.end();
        return;
      }
      const operation = handler(req, res).catch(() => {
        res.destroy();
      });
      pending.add(operation);
      void operation.finally(() => pending.delete(operation));
    });
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    server.setTimeout(30_000, (socket) => socket.destroy());
    const [role] = await database`select rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,
      has_schema_privilege(current_user,'oidc','CREATE') as schema_create,
      not exists(select 1 from unnest(array['SELECT','INSERT','UPDATE','DELETE']) as p(privilege)
        where not has_table_privilege(current_user,'oidc.artifacts',privilege)
          or not has_table_privilege(current_user,'oidc.revoked_grants',privilege)
          or not has_table_privilege(current_user,'oidc.approval_attempts',privilege)) as dml
      from pg_roles where rolname=current_user`;
    if (
      !role ||
      role.rolsuper ||
      role.rolcreatedb ||
      role.rolcreaterole ||
      role.rolbypassrls ||
      role.schema_create ||
      !role.dml
    )
      throw new Error('Invalid database role');
    // Verify expected columns without reading identity/token payloads.
    await database`select model,id,payload,expires_at,grant_id,uid,user_code,consumed,destroyed from oidc.artifacts limit 0`;
    await database`select id,revoked_at from oidc.revoked_grants limit 0`;
    await database`select interaction_id,binding,state,created_at from oidc.approval_attempts limit 0`;
    // One issuer per database. Never return this physical session to the pool
    // while requests may still write. It is distinct from the adapter write lock.
    ownerDatabase = postgres(c.databaseUrl, {
      max: 1,
      idle_timeout: 0,
      max_lifetime: null,
      connect_timeout: 5,
      ssl: ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ? false : 'verify-full',
      onnotice: () => {},
      onclose: () => {
        ownerClosed = true;
        if (!releasingOwner) ownershipLost.resolve();
        if (!closing) {
          void close().catch(() => {}); // CLI observes ownershipLost and exits unsuccessfully.
        }
      },
    });
    owner = await ownerDatabase.reserve();
    const [lease] = await owner`select pg_try_advisory_lock(1952805473,1869177956) as acquired`;
    if (!lease.acquired || ownerClosed || closing) throw new Error('Issuer ownership unavailable');
    // No listener until persisted pending approvals are revoked. Track recovery
    // as in-flight work so ownership loss cannot close its pool underneath it.
    const recovery = recoverOidcApprovals(
      database,
      {
        issuer: provider.issuer,
        resource: c.provider.resource,
        ...c.downstream,
      },
      async (url, init) => {
        if (ownerClosed || closing) throw new Error('Issuer ownership lost');
        return fetch(url, init);
      },
    ).then(() => {});
    pending.add(recovery);
    try {
      await recovery;
    } finally {
      pending.delete(recovery);
    }
    if (ownerClosed || closing) throw new Error('Issuer ownership lost during recovery');
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(c.listen.port, c.listen.host, () => {
        server!.off('error', reject);
        resolve();
      });
    });
    if (ownerClosed || closing) {
      // Loss while listen() was pending can precede server.listening becoming true.
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      throw new Error('Issuer ownership lost during startup');
    }
    return { address: server.address(), close, ownershipLost: ownershipLost.promise };
  } catch {
    try {
      await close();
    } catch {
      /* Startup never exposes database/configuration details. */
    }
    throw new Error('OIDC_SERVICE_START_FAILED');
  }
}
