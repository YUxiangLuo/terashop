import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TLSSocket } from 'node:tls';
import type Provider from 'oidc-provider';

// Host-only provider JSON. Semantic validation remains in createOidcProvider.
// Require a private regular file; never accept a secret in argv or an HTTP body.
export async function readOidcProviderConfiguration(path: string): Promise<unknown> {
  const bytes = Buffer.alloc(65537);
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (!isAbsolute(path)) throw new Error('Expected absolute path');
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size < 1 || stat.size > 65536)
      throw new Error('Unsafe configuration file');
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > 65536) throw new Error('Configuration too large');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
  } catch {
    throw new Error('OIDC_CONFIGURATION_READ_FAILED');
  } finally {
    bytes.fill(0);
    await file?.close();
  }
}

// Must wrap BOTH custom interaction routes and provider.callback(). The provider
// derives endpoint URLs from the request, even when issuer is fixed in its config.
// Direct TLS only: proxy support needs a separately reviewed trusted-peer boundary.
export function createOidcTlsHandler(
  provider: Provider,
  interaction: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>,
) {
  const origin = new URL(provider.issuer);
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || provider.proxy)
    throw new Error('INVALID_OIDC_HOST_CONFIGURATION');
  const callback = provider.callback();
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const reject = (status: number) => {
      res.statusCode = status;
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: status === 403 ? 'OIDC_REQUEST_REJECTED' : 'OIDC_REQUEST_FAILED' }));
    };
    const raw = req.url ?? '';
    if (
      provider.proxy ||
      !(req.socket as TLSSocket).encrypted ||
      req.headers.host !== origin.host ||
      !raw.startsWith('/') ||
      raw.startsWith('//') ||
      raw.includes('\\') ||
      raw.includes('#') ||
      Object.keys(req.headers).some((name) => name === 'forwarded' || name.startsWith('x-forwarded-')) ||
      req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === 'host')
        .length !== 1
    ) {
      reject(403);
      return;
    }
    try {
      if (!(await interaction(req, res))) await callback(req, res);
    } catch {
      // Do not send underlying provider/database errors or write after headers.
      if (res.headersSent) res.destroy();
      else reject(500);
    }
  };
}
