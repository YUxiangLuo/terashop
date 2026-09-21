import { test } from 'bun:test';
import { verifyOAuthProvider } from '../support/oauth-provider-compat';

// Fast protocol regression only. Bun is not the provider's supported deployment runtime.
for (const format of ['jwt', 'opaque'] as const) {
  test(
    `oidc-provider: ${format} resource, PKCE, introspection, rotation and revocation`,
    () => verifyOAuthProvider(format),
    15_000,
  );
}
