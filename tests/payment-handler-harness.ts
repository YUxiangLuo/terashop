import { API, ANON_KEY, SERVICE_KEY } from './helpers';

type ProviderMock = (request: Request) => Response | Promise<Response>;

// Exercise the production handler with real Auth/PostgREST and mocked provider
// HTTP only. Restore globals even after an assertion fails; never reach a real
// payment endpoint from this harness.
export async function withPaymentProviderMock<T>(
  providerMock: ProviderMock,
  run: () => Promise<T>,
  overrides: Record<string, string> = {},
  observeDatabase?: (request: Request) => void | Promise<void>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  const originalDeno = Object.getOwnPropertyDescriptor(globalThis, 'Deno');
  const env: Record<string, string> = {
    SUPABASE_URL: API,
    SUPABASE_ANON_KEY: ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
    STRIPE_SECRET_KEY: 'sk_test_workflow_placeholder',
    STRIPE_LIVEMODE: 'false',
    PAYPAL_CLIENT_ID: 'workflow-client',
    PAYPAL_CLIENT_SECRET: 'workflow-placeholder',
    PAYPAL_LIVEMODE: 'false',
    ...overrides,
  };
  Object.defineProperty(globalThis, 'Deno', {
    configurable: true,
    value: { env: { get: (name: string) => env[name] } },
  });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin === new URL(API).origin) {
      if (observeDatabase) await observeDatabase(request.clone());
      return originalFetch(request);
    }
    return providerMock(request);
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDeno) Object.defineProperty(globalThis, 'Deno', originalDeno);
    else Reflect.deleteProperty(globalThis, 'Deno');
  }
}

export function paymentRequest(body: unknown, token: string): Request {
  return new Request('http://payment-handler.test', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
