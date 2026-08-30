# Payment Edge Functions

## Stripe

- `stripe-create-payment-intent`: authenticated Storefront endpoint. Creates/retrieves a Stripe PaymentIntent and binds it to the local intent.
- `stripe-webhook`: public endpoint with `verify_jwt = false`; verifies the unchanged raw body with `Stripe-Signature` before calling the service-only Provider Inbox RPC.
- `stripe-create-refund`: authenticated admin endpoint. Creates an asynchronous refund request and submits it to Stripe.

```bash
supabase secrets set \
  STRIPE_SECRET_KEY=sk_live_REPLACE_ME \
  STRIPE_WEBHOOK_SECRET=whsec_REPLACE_ME \
  STRIPE_LIVEMODE=true \
  PAYMENT_ALLOWED_ORIGINS=https://shop.example.com,https://admin.example.com
```

Optional Stripe settings:

- `STRIPE_WEBHOOK_SECRETS`: comma-separated secrets during endpoint-secret rotation.
- `STRIPE_WEBHOOK_TOLERANCE_SECONDS`: 30–900, default 300.
- `STRIPE_API_VERSION`: pinned by default to `2026-02-25.clover`.
- `STRIPE_API_BASE`: test/mock override; keep the production default `https://api.stripe.com`.

Subscribe to:

- `payment_intent.processing`
- `payment_intent.payment_failed`
- `payment_intent.succeeded`
- `payment_intent.canceled`
- `refund.created`
- `refund.updated`
- `refund.failed`

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

- `retry_payment_provider_events`
- `expire_checkout_quotes`
- `paypal-reconcile-refunds` every minute with `Authorization: Bearer <service-role-key>` and body `{"max_events":20}` (each request is polled at most once per five minutes)
- the Outbox consumer, including `payment.reconciliation_required` and `paypal.refund_reconciliation_requested`

Never expose `SUPABASE_SERVICE_ROLE_KEY`, Stripe secrets, `PAYPAL_CLIENT_SECRET`, or webhook credentials to browsers.
