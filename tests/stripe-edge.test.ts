import { describe, expect, test } from 'bun:test';
import {
  assertStripeKeyMode,
  decimalToMinorUnits,
  minorUnitsToDecimal,
  normalizeStripeEvent,
  parseStripeAllowRedirects,
  parseStripeLivemode,
  parseStripeWebhookSecrets,
  stripeApiBase,
  stripeRequest,
  stripeSignatureForTest,
  verifyStripeSignature,
} from '../supabase/functions/_shared/stripe';

describe('Stripe Edge 安全边界', () => {
  test('签名必须匹配原始 body，并校验 5 分钟时间窗和轮换 secret', async () => {
    const payload = JSON.stringify({ id: 'evt_test', type: 'payment_intent.succeeded' });
    const timestamp = 1_800_000_000;
    const signature = await stripeSignatureForTest(payload, 'whsec_current', timestamp);
    const verified = await verifyStripeSignature(
      payload,
      `t=${timestamp},v1=${'0'.repeat(64)},v1=${signature}`,
      ['whsec_previous', 'whsec_current'],
      { nowSeconds: timestamp + 299, toleranceSeconds: 300 },
    );
    expect(verified.timestamp).toBe(timestamp);

    await expect(verifyStripeSignature(
      `${payload} `,
      `t=${timestamp},v1=${signature}`,
      ['whsec_current'],
      { nowSeconds: timestamp },
    )).rejects.toThrow('Invalid Stripe webhook signature');
    await expect(verifyStripeSignature(
      payload,
      `t=${timestamp},v1=${signature}`,
      ['whsec_current'],
      { nowSeconds: timestamp + 301, toleranceSeconds: 300 },
    )).rejects.toThrow('outside tolerance');
    await expect(verifyStripeSignature(
      payload,
      `t=${timestamp},t=${timestamp},v1=${signature}`,
      ['whsec_current'],
      { nowSeconds: timestamp },
    )).rejects.toThrow('Malformed');
    expect(parseStripeWebhookSecrets('whsec_current', 'whsec_previous,whsec_current'))
      .toEqual(['whsec_current', 'whsec_previous']);
  });

  test('CNY 元与最小货币单位转换不经过浮点运算', () => {
    expect(decimalToMinorUnits('0.01', 'CNY')).toBe('1');
    expect(decimalToMinorUnits('12345678.90', 'cny')).toBe('1234567890');
    expect(minorUnitsToDecimal('1234567890', 'CNY')).toBe('12345678.90');
    expect(() => decimalToMinorUnits('1.001', 'CNY')).toThrow('at most two places');
    expect(() => decimalToMinorUnits('10', 'USD')).toThrow('outside the current CNY capability');
    expect(() => assertStripeKeyMode('sk_test_local', false)).not.toThrow();
    expect(() => assertStripeKeyMode('sk_test_local', true)).toThrow('does not match STRIPE_LIVEMODE');
    expect(parseStripeLivemode('false')).toBeFalse();
    expect(() => parseStripeLivemode('False')).toThrow('must be true or false');
    expect(parseStripeAllowRedirects('never')).toBe('never');
    expect(stripeApiBase(false, 'http://127.0.0.1:12111')).toBe('http://127.0.0.1:12111');
    expect(() => stripeApiBase(true, 'http://127.0.0.1:12111')).toThrow('forbidden in live mode');
    expect(() => stripeApiBase(false, 'https://stripe.invalid')).toThrow('untrusted');
  });

  test('Webhook 归一化只保留资金字段和内部关联 metadata，不保留客户/card PII', () => {
    const event = normalizeStripeEvent({
      id: 'evt_123',
      object: 'event',
      type: 'payment_intent.succeeded',
      created: 1_800_000_000,
      livemode: false,
      data: {
        object: {
          id: 'pi_123',
          object: 'payment_intent',
          status: 'succeeded',
          amount: 1000,
          amount_received: 1000,
          currency: 'cny',
          customer: 'cus_secret',
          receipt_email: 'pii@example.com',
          payment_method: { card: { last4: '4242' } },
          last_payment_error: {
            code: 'card_declined',
            message: 'Declined for pii@example.com',
          },
          metadata: {
            tera_payment_intent_id: '11111111-1111-4111-8111-111111111111',
            tera_order_id: '22222222-2222-4222-8222-222222222222',
            private_note: 'must not persist',
            tera_refund_request_id: 'not-a-uuid',
          },
        },
      },
    });
    expect(event).toMatchObject({
      providerEventId: 'evt_123',
      eventType: 'payment_intent.succeeded',
      objectReference: 'pi_123',
      data: {
        amount_minor: '1000',
        currency: 'cny',
        failure_code: 'card_declined',
        failure_message: null,
        metadata: {
          tera_payment_intent_id: '11111111-1111-4111-8111-111111111111',
          tera_order_id: '22222222-2222-4222-8222-222222222222',
        },
      },
    });
    const persisted = JSON.stringify(event.data);
    expect(persisted).not.toContain('pii@example.com');
    expect(persisted).not.toContain('4242');
    expect(persisted).not.toContain('private_note');
    expect(persisted).not.toContain('Declined for');
    expect(persisted).not.toContain('not-a-uuid');

    expect(() => normalizeStripeEvent({
      id: 'evt_inconsistent',
      object: 'event',
      type: 'payment_intent.succeeded',
      created: 1_800_000_000,
      livemode: false,
      data: { object: {
        id: 'pi_inconsistent', object: 'payment_intent', status: 'processing',
        amount: 1000, amount_received: 0, currency: 'cny',
      } },
    })).toThrow('status is inconsistent');

    expect(() => normalizeStripeEvent({
      id: 'evt_connect',
      object: 'event',
      type: 'payment_intent.succeeded',
      created: 1_800_000_000,
      livemode: false,
      account: 'acct_connected',
      data: { object: {} },
    })).toThrow('Connect events');
  });

  test('Stripe POST 使用 form body、版本和幂等 header，错误响应不回传渠道原文', async () => {
    let request: Request | undefined;
    const result = await stripeRequest<{ id: string }>('/v1/payment_intents', {
      secretKey: 'sk_test_fake',
      apiBase: 'https://api.stripe.com',
      apiVersion: '2026-02-25.clover',
      idempotencyKey: 'local-command-id',
      form: { amount: '1000', currency: 'cny' },
      fetcher: async (input, init) => {
        request = new Request(input, init);
        return new Response(JSON.stringify({ id: 'pi_test' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    expect(result.id).toBe('pi_test');
    expect(request?.headers.get('Idempotency-Key')).toBe('local-command-id');
    expect(request?.headers.get('Stripe-Version')).toBe('2026-02-25.clover');
    expect(await request?.text()).toBe('amount=1000&currency=cny');

    await expect(stripeRequest('/v1/refunds', {
      secretKey: 'sk_test_fake',
      fetcher: async () => new Response(JSON.stringify({
        error: { code: 'card_declined', message: 'Sensitive processor detail' },
      }), { status: 402 }),
    })).rejects.toMatchObject({ code: 'card_declined', message: 'Stripe rejected the request' });
  });

  test('可安全重试的请求复用相同幂等键，并服从 Stripe-Should-Retry', async () => {
    let attempts = 0;
    const keys: Array<string | null> = [];
    const result = await stripeRequest<{ id: string }>('/v1/refunds', {
      secretKey: 'sk_test_fake',
      idempotencyKey: 'same-command',
      retryDelayMs: 0,
      fetcher: async (input, init) => {
        attempts += 1;
        const request = new Request(input, init);
        keys.push(request.headers.get('Idempotency-Key'));
        if (attempts === 1) return new Response('{}', { status: 409 });
        return new Response(JSON.stringify({ id: 're_retry' }), { status: 200 });
      },
    });
    expect(result.id).toBe('re_retry');
    expect(keys).toEqual(['same-command', 'same-command']);

    attempts = 0;
    await expect(stripeRequest('/v1/refunds', {
      secretKey: 'sk_test_fake',
      idempotencyKey: 'do-not-retry',
      retryDelayMs: 0,
      fetcher: async () => {
        attempts += 1;
        return new Response('{}', {
          status: 429,
          headers: { 'Stripe-Should-Retry': 'false' },
        });
      },
    })).rejects.toMatchObject({ status: 503 });
    expect(attempts).toBe(1);
  });
});
