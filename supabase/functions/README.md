# Payment Edge Functions

## Stripe

- `stripe-create-payment-intent`: authenticated Storefront endpoint. The Edge gateway verifies the JWT and the handler revalidates it with Auth before checking order ownership in PostgreSQL.
- `stripe-webhook`: public endpoint with `verify_jwt = false`; verifies the unchanged raw body with `Stripe-Signature`, then writes the service-only Provider Inbox. Once the inbox row is durable, processing failures are acknowledged and owned by the retry worker.
- `stripe-create-refund`: authenticated admin endpoint with the same gateway/handler defense in depth. It reserves the refund first, then submits it to Stripe.
- `stripe-reconcile-payment-intents`: service-role-only scheduled worker. It leases expired/canceled-order intents, cancels still-active Stripe objects with a stable idempotency key, and ingests a raced `succeeded` state instead of discarding it.

Prefer a restricted live key with only the PaymentIntent and Refund read/write permissions required by these functions. Never use a publishable key server-side.

```bash
supabase secrets set \
  STRIPE_SECRET_KEY=rk_live_REPLACE_ME \
  STRIPE_WEBHOOK_SECRET=whsec_REPLACE_ME \
  STRIPE_LIVEMODE=true \
  STRIPE_API_VERSION=2026-02-25.clover \
  STRIPE_ALLOW_REDIRECTS=never \
  STRIPE_HTTP_TIMEOUT_MS=10000 \
  STRIPE_WEBHOOK_TOLERANCE_SECONDS=300 \
  PAYMENT_ALLOWED_ORIGINS=https://shop.example.com,https://admin.example.com
```

Optional Stripe settings:

- `STRIPE_WEBHOOK_SECRETS`: comma-separated old secrets during endpoint-secret rotation; the primary `STRIPE_WEBHOOK_SECRET` remains required.
- `STRIPE_WEBHOOK_TOLERANCE_SECONDS`: 30–900, default 300.
- `STRIPE_API_VERSION`: pinned by default to `2026-02-25.clover`; configure the webhook destination to the same snapshot API version.
- `STRIPE_HTTP_TIMEOUT_MS`: 1000–20000, default 10000. Safe network/409/429 retries reuse the exact same Stripe idempotency key; a received POST 5xx is left for the caller to retry through the local idempotent command.
- `STRIPE_ALLOW_REDIRECTS`: `never` by default because the current inventory hold is short-lived. Set `always` only after defining a compatible asynchronous inventory/cancellation policy.
- `STRIPE_API_BASE`: only an official host or a test-mode local mock is accepted. Leave it unset in production; live mode rejects local overrides.

Use a snapshot-event webhook destination (not a thin-event destination), scoped to the platform account rather than Connect/organization context, and subscribe to:

- `payment_intent.processing`
- `payment_intent.requires_action`
- `payment_intent.payment_failed`
- `payment_intent.succeeded`
- `payment_intent.canceled`
- `refund.created`
- `refund.updated`
- `refund.failed`

The normalized inbox stores only allowlisted money/correlation fields. A provider reference bound by the trusted API path is authoritative; metadata alone never binds an early event. Refund correlation additionally requires the captured PaymentIntent or Charge. `client_secret` is returned only to the authenticated caller and is never persisted.

Official references: [PaymentIntents](https://docs.stripe.com/api/payment_intents),
[webhook signatures](https://docs.stripe.com/webhooks/signature),
[event delivery and ordering](https://docs.stripe.com/webhooks),
[idempotent requests](https://docs.stripe.com/api/idempotent_requests),
[PaymentIntent cancellation](https://docs.stripe.com/api/payment_intents/cancel),
[currency minor units](https://docs.stripe.com/currencies), and
[refund events](https://docs.stripe.com/api/events/types).

Stripe disputes/chargebacks and payout-to-bank balance reconciliation are not automated in this phase. Monitor them in Stripe and route them through the manual reconciliation process; do not subscribe dispute events to this endpoint until their ledger model is implemented.

## PayPal Orders v2 / Payments v2

- `paypal-create-order`: authenticated Storefront endpoint. Creates an idempotent `CAPTURE` Order and returns only its trusted approval URL.
- `paypal-capture-order`: authenticated Storefront endpoint called after buyer approval. Captures with the local intent UUID as `PayPal-Request-Id` and reconciles the returned Capture.
- `paypal-webhook`: public endpoint with `verify_jwt = false`; validates transmission headers by calling PayPal's `verify-webhook-signature` endpoint before accepting the event.
- `paypal-create-refund`: authenticated admin endpoint. Reserves the refundable amount/lines and submits an idempotent Payments v2 refund.
- `paypal-reconcile-refunds`: service-role-only polling worker for pending refunds. This is required because PayPal documents pending/failed refund events and an aggregate `PAYMENT.CAPTURE.REFUNDED` signal, not a per-refund completed event.

```bash
supabase secrets set \
  PAYPAL_CLIENT_ID=REPLACE_ME \
  PAYPAL_CLIENT_SECRET=REPLACE_ME \
  PAYPAL_WEBHOOK_ID=REPLACE_ME \
  PAYPAL_LIVEMODE=true \
  PAYPAL_RETURN_URL=https://shop.example.com/checkout/paypal/return \
  PAYPAL_CANCEL_URL=https://shop.example.com/checkout/paypal/cancel \
  PAYPAL_BRAND_NAME='Example Store' \
  PAYMENT_ALLOWED_ORIGINS=https://shop.example.com,https://admin.example.com
```

`PAYPAL_API_BASE` is only for local mocks. Leave it unset so `PAYPAL_LIVEMODE` selects PayPal's official sandbox/live host. The PayPal merchant account must be able to receive CNY.

Subscribe the PayPal Webhook ID to:

- `PAYMENT.CAPTURE.COMPLETED`
- `PAYMENT.CAPTURE.PENDING`
- `PAYMENT.CAPTURE.DECLINED`
- `PAYMENT.CAPTURE.REFUNDED`
- `PAYMENT.CAPTURE.REVERSED`
- `PAYMENT.REFUND.PENDING`
- `PAYMENT.REFUND.FAILED`

Use a real sandbox transaction for verification tests: PayPal's webhook simulator cannot be verified through the postback endpoint.
Official references: [Orders v2](https://developer.paypal.com/docs/api/orders/v2/),
[Payments v2](https://developer.paypal.com/docs/api/payments/v2/),
[webhook event names](https://developer.paypal.com/api/rest/webhooks/event-names/), and
[signature postback](https://developer.paypal.com/api/webhooks/v1/verify-webhook-signature-post/).
Customer disputes are not automated in this phase; monitor PayPal and route them through the reconciliation process.

## Workers and deployment

Deploy all functions with the repository's `supabase/config.toml`. Schedule:

- `expire_checkout_quotes`, then `stripe-reconcile-payment-intents` every minute with `Authorization: Bearer <service-role-key>` and body `{"max_intents":5}`
- `retry_payment_provider_events`
- `paypal-reconcile-refunds` every minute with `Authorization: Bearer <service-role-key>` and body `{"max_events":20}` (each request is polled at most once per five minutes)
- the Outbox consumer, including `payment.reconciliation_required`, `stripe.payment_intent_cancel_failed`, and `paypal.refund_reconciliation_requested`

Never expose `SUPABASE_SERVICE_ROLE_KEY`, Stripe secrets, `PAYPAL_CLIENT_SECRET`, or webhook credentials to browsers.
