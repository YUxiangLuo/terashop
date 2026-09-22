import { X509Certificate, createPrivateKey } from 'node:crypto';
import { isIP } from 'node:net';
import * as z from 'zod/v4';
import { readOidcProviderConfiguration } from './oidc-host';
import { createCredentialCipher } from './credentials';
import { createAdminHttpHandler } from './http';

const secret = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value);
const configuration = z.strictObject({
  authorization: z.strictObject({
    issuer: z.url(),
    resource: z.url(),
    introspectionEndpoint: z.url(),
    introspectionClientId: secret,
    introspectionClientSecret: secret,
    project: secret,
    supabaseUrl: z.url(),
    serviceRoleKey: secret,
    anonKey: secret,
    scopes: z
      .array(z.enum(['store:read', 'store:write', 'store:payments', 'store:access', 'store:privacy']))
      .min(1)
      .max(5),
    allowWrites: z.boolean(),
  }),
  credentialKeys: z.record(z.string(), z.string()).refine((keys) => Object.keys(keys).length <= 8),
  activeCredentialKey: secret,
  tls: z.strictObject({ key: z.string().min(1), cert: z.string().min(1) }),
  listen: z.strictObject({
    host: z.enum(['127.0.0.1', '::1', '0.0.0.0']),
    port: z.number().int().min(0).max(65535),
  }),
});

// Direct TLS only; never infer the public resource or authorization config from headers.
export async function startAdminHttpService(path: string) {
  try {
    const c = configuration.parse(await readOidcProviderConfiguration(path));
    const resource = new URL(c.authorization.resource);
    const hostname = resource.hostname.replace(/^\[|\]$/g, '');
    const cert = new X509Certificate(c.tls.cert);
    if (
      !(isIP(hostname) ? cert.checkIP(hostname) : cert.checkHost(hostname)) ||
      Date.parse(cert.validFrom) > Date.now() ||
      Date.parse(cert.validTo) <= Date.now() ||
      !cert.checkPrivateKey(createPrivateKey(c.tls.key))
    )
      throw new Error('Invalid TLS');
    const keys = new Map(
      Object.entries(c.credentialKeys).map(([id, encoded]) => {
        const bytes = Buffer.from(encoded, 'base64url');
        if (bytes.toString('base64url') !== encoded) throw new Error('Invalid key');
        return [id, bytes] as const;
      }),
    );
    let cipher: Awaited<ReturnType<typeof createCredentialCipher>>;
    try {
      cipher = await createCredentialCipher(keys, c.activeCredentialKey);
    } finally {
      for (const key of keys.values()) key.fill(0);
    }
    // Validate before binding a port, even if no requests ever arrive.
    createAdminHttpHandler(c.authorization, cipher);
    let closing = false;
    let stopped: Promise<void> | undefined;
    const pending = new Set<Promise<Response>>();
    const failure = (status: number, error: string) =>
      Response.json(
        { error },
        {
          status,
          headers: { 'Cache-Control': 'no-store' },
        },
      );
    const server = Bun.serve({
      development: false,
      hostname: c.listen.host,
      port: c.listen.port,
      tls: c.tls,
      maxRequestBodySize: 1024 * 1024,
      idleTimeout: 30,
      async fetch(req) {
        if (closing) return failure(503, 'service_unavailable');
        if ([...req.headers.keys()].some((name) => name === 'forwarded' || name.startsWith('x-forwarded-')))
          return failure(403, 'forbidden');
        const controller = new AbortController();
        const signal = AbortSignal.any([req.signal, controller.signal]);
        const handler = createAdminHttpHandler(c.authorization, cipher, (url, init) =>
          fetch(url, {
            ...init,
            signal: AbortSignal.any([signal, ...(init.signal ? [init.signal] : [])]),
          }),
        );
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<Response>((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve(failure(504, 'request_timeout'));
          }, 30_000);
        });
        const operation = handler(new Request(req, { signal })).catch(() =>
          failure(500, 'mcp_request_failed'),
        );
        pending.add(operation);
        void operation.finally(() => pending.delete(operation));
        try {
          return await Promise.race([operation, deadline]);
        } finally {
          clearTimeout(timer);
        }
      },
      error() {
        return failure(500, 'mcp_request_failed');
      },
    });
    return {
      port: server.port,
      close: () =>
        (stopped ??= (async () => {
          closing = true;
          await server.stop(false);
          await Promise.allSettled([...pending]);
        })()),
    };
  } catch {
    throw new Error('MCP_HTTP_START_FAILED');
  }
}
