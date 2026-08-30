# Payment Edge Functions

- `stripe-create-payment-intent`: authenticated Storefront endpoint. Creates/retrieves a Stripe PaymentIntent and binds it to the local intent.
- `stripe-webhook`: public endpoint with `verify_jwt = false`; it verifies the unchanged raw body with `Stripe-Signature` before calling the service-only provider inbox RPC.
- `stripe-create-refund`: authenticated admin endpoint. Creates an asynchronous refund request and submits it to Stripe.

Required production secrets:

```bash
supabase secrets set \
  STRIPE_SECRET_KEY=sk_live_... \
  STRIPE_WEBHOOK_SECRET=whsec_... \
  STRIPE_LIVEMODE=true \
  PAYMENT_ALLOWED_ORIGINS=https://shop.example.com,https://admin.example.com
```

Optional:

- `STRIPE_WEBHOOK_SECRETS`: comma-separated secrets during endpoint-secret rotation.
- `STRIPE_WEBHOOK_TOLERANCE_SECONDS`: 30–900, default 300.
- `STRIPE_API_VERSION`: pinned by default to `2026-02-25.clover`.
- `STRIPE_API_BASE`: test/mock override; keep the production default `https://api.stripe.com`.

Configure the Stripe endpoint to send only:

- `payment_intent.processing`
- `payment_intent.payment_failed`
- `payment_intent.succeeded`
- `payment_intent.canceled`
- `refund.created`
- `refund.updated`
- `refund.failed`

Schedule `retry_payment_provider_events` and consume `payment.reconciliation_required` Outbox events.
Never expose `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`, or webhook secrets to browsers.
