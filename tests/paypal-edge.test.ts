import { beforeEach, describe, expect, test } from 'bun:test';
import {
  configuredRedirectUrl,
  extractPayPalCapture,
  normalizeCheckoutAmount,
  normalizePayPalEvent,
  normalizedPayPalCaptureData,
  normalizedPayPalRefundData,
  parsePayPalWebhookHeaders,
  payPalApiBase,
  payPalApprovalUrl,
  parsePayPalLivemode,
  type PayPalFetcher,
  PayPalIntegrationError,
  type PayPalOrder,
  type PayPalRefund,
  payPalRequest,
  payPalShippingUnit,
  resetPayPalTokenCacheForTest,
  validatePayPalOrder,
  validatePayPalRefund,
  verifyPayPalWebhook,
} from '../supabase/functions/_shared/paypal';

beforeEach(() => resetPayPalTokenCacheForTest());

const MOCK_ACCESS_TOKEN = ['mock', 'access', 'value'].join('-');

const config = {
  clientId: 'sandbox-client',
  clientSecret: 'sandbox-secret',
  apiBase: 'https://api-m.sandbox.paypal.com',
};

function webhookHeaders(certHost = 'api-m.sandbox.paypal.com'): Headers {
  return new Headers({
    'PayPal-Auth-Algo': 'SHA256withRSA',
    'PayPal-Cert-Url': `https://${certHost}/v1/notifications/certs/CERT-123`,
    'PayPal-Transmission-Id': 'transmission-123',
    'PayPal-Transmission-Sig': 'base64-signature',
    'PayPal-Transmission-Time': '2026-08-30T00:00:00Z',
  });
}

describe('PayPal Edge 安全边界', () => {
  test('OAuth2、Bearer、PayPal-Request-Id 和 token cache 均按协议发送', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: PayPalFetcher = async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/v1/oauth2/token')) {
        return new Response(JSON.stringify({ access_token: MOCK_ACCESS_TOKEN, expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ id: 'ORDER12345', status: 'CREATED' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const requestId = crypto.randomUUID();
    await payPalRequest('/v2/checkout/orders', {
      ...config,
      fetcher,
      idempotencyKey: requestId,
      preferRepresentation: true,
      body: { intent: 'CAPTURE' },
    });
    await payPalRequest('/v2/checkout/orders/ORDER12345', {
      ...config,
      fetcher,
      method: 'GET',
    });
    expect(calls).toHaveLength(3);
    const oauthHeaders = new Headers(calls[0].init?.headers);
    expect(oauthHeaders.get('Authorization')).toBe(
      `Basic ${btoa('sandbox-client:sandbox-secret')}`,
    );
    expect(String(calls[0].init?.body)).toBe('grant_type=client_credentials');
    const apiHeaders = new Headers(calls[1].init?.headers);
    expect(apiHeaders.get('Authorization')).toBe(`Bearer ${MOCK_ACCESS_TOKEN}`);
    expect(apiHeaders.get('PayPal-Request-Id')).toBe(requestId);
    expect(apiHeaders.get('Prefer')).toBe('return=representation');
    expect(calls[2].url).toEndWith('/v2/checkout/orders/ORDER12345');
  });

  test('Webhook 使用官方 postback 验签并限制证书域名', async () => {
    const event = {
      id: 'WH-123456789',
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      create_time: '2026-08-30T00:00:00Z',
      resource: { id: 'CAPTURE12345' },
    };
    let verificationBody: Record<string, unknown> | null = null;
    const fetcher: PayPalFetcher = async (input, init) => {
      if (String(input).endsWith('/v1/oauth2/token')) {
        return new Response(JSON.stringify({ access_token: MOCK_ACCESS_TOKEN, expires_in: 3600 }), { status: 200 });
      }
      verificationBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ verification_status: 'SUCCESS' }), { status: 200 });
    };
    const parsedHeaders = parsePayPalWebhookHeaders(webhookHeaders(), false);
    await verifyPayPalWebhook(event, parsedHeaders, 'WEBHOOK-123', { ...config, fetcher });
    expect(verificationBody).toMatchObject({
      webhook_id: 'WEBHOOK-123',
      transmission_id: 'transmission-123',
      webhook_event: event,
    });
    expect(() => parsePayPalWebhookHeaders(webhookHeaders('attacker.example'), false))
      .toThrow('Untrusted PayPal certificate URL');
  });

  test('Webhook 归一化不保留 payer/payee/email 等 PII', () => {
    const normalized = normalizePayPalEvent({
      id: 'WH-CAPTURE-12345',
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      create_time: '2026-08-30T00:00:00Z',
      resource_type: 'capture',
      resource: {
        id: 'CAPTURE12345',
        status: 'COMPLETED',
        amount: { value: '10.00', currency_code: 'USD' },
        custom_id: 'f39c37ad-e437-4bdf-a990-d474bcd9430a',
        payee: { email_address: 'merchant@example.com' },
        payer: { email_address: 'buyer@example.com' },
        supplementary_data: { related_ids: { order_id: 'ORDER12345' } },
      },
    });
    expect(normalized).toMatchObject({
      providerEventId: 'WH-CAPTURE-12345',
      objectReference: 'CAPTURE12345',
      data: {
        status: 'completed',
        amount: '10.00',
        currency: 'USD',
        order_reference: 'ORDER12345',
      },
    });
    const serialized = JSON.stringify(normalized);
    expect(serialized).not.toContain('merchant@example.com');
    expect(serialized).not.toContain('buyer@example.com');
    expect(serialized).not.toContain('payee');
    expect(serialized).not.toContain('payer');

    const foreign = normalizePayPalEvent({
      id: 'WH-EUR-12345',
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      create_time: '2026-08-30T00:00:00Z',
      resource: {
        id: 'CAPTURE-EUR-12345', status: 'COMPLETED',
        amount: { value: '12.34', currency_code: 'EUR' },
      },
    });
    expect(foreign.data.amount).toBe('12.34');
    expect(foreign.data.currency).toBe('EUR');
  });

  test('订单、Capture、退款、地址和跳转 URL 做严格关联校验', () => {
    const local = {
      id: 'f39c37ad-e437-4bdf-a990-d474bcd9430a',
      order_id: '4478f0ea-3229-4195-981c-38d0f3393266',
      order_number: 1001,
      provider: 'paypal',
      status: 'requires_action',
      amount: '10.00',
      currency: 'USD',
      provider_reference: null,
      expires_at: null,
      shipping_address: {},
    };
    const order: PayPalOrder = {
      id: 'ORDER12345',
      intent: 'CAPTURE',
      status: 'COMPLETED',
      purchase_units: [{
        reference_id: local.order_id,
        custom_id: local.id,
        amount: { value: '10.00', currency_code: 'USD' },
        payments: { captures: [{
          id: 'CAPTURE12345',
          status: 'COMPLETED',
          amount: { value: '10.00', currency_code: 'USD' },
          final_capture: true,
          create_time: '2026-08-30T00:00:00Z',
        }] },
      }],
      links: [{
        rel: 'approve',
        href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER12345',
      }],
    };
    expect(() => validatePayPalOrder(order, local)).not.toThrow();
    expect(extractPayPalCapture(order, local)?.id).toBe('CAPTURE12345');
    const mismatched = structuredClone(order);
    const mismatchUnit = mismatched.purchase_units[0] as any;
    mismatchUnit.amount = { value: '11.00', currency_code: 'EUR' };
    mismatchUnit.payments.captures[0].amount = { value: '11.00', currency_code: 'EUR' };
    expect(() => validatePayPalOrder(mismatched, local)).toThrow('outside the current USD capability');
    expect(() => validatePayPalOrder(mismatched, local, false)).not.toThrow();
    const mismatchedCapture = extractPayPalCapture(mismatched, local, false)!;
    expect(normalizedPayPalCaptureData(mismatchedCapture, local, mismatched.id)).toMatchObject({
      amount: '11.00', currency: 'EUR',
    });
    expect(payPalApprovalUrl(order, false)).toContain('sandbox.paypal.com');
    expect(() => payPalApprovalUrl({
      ...order,
      links: [{ rel: 'approve', href: 'https://attacker.example/pay' }],
    }, false)).toThrow('untrusted');

    expect(payPalShippingUnit({
      recipient_name: 'Alex Morgan', country: 'US', region: 'NY', city: 'New York',
      line1: '123 Example Street', line2: 'Apt 4B', postal_code: '10001',
    })).toEqual({
      name: { full_name: 'Alex Morgan' },
      address: {
        address_line_1: '123 Example Street', address_line_2: 'Apt 4B',
        admin_area_2: 'New York', admin_area_1: 'NY', postal_code: '10001', country_code: 'US',
      },
    });
    expect(payPalShippingUnit({
      recipient_name: '陳曉', country: 'HK', line1: '12 Example Road',
    })).toEqual({
      name: { full_name: '陳曉' },
      address: { address_line_1: '12 Example Road', country_code: 'HK' },
    });
    expect(() => payPalShippingUnit({ recipient_name: 'Alex', line1: 'Example Street' }))
      .toThrow('country is required');
    expect(configuredRedirectUrl('https://shop.example/paypal/return', 'return')).toBe(
      'https://shop.example/paypal/return',
    );
    expect(() => configuredRedirectUrl('http://shop.example/return', 'return'))
      .toThrow('must use HTTPS');

    const refund: PayPalRefund = {
      id: 'REFUND12345',
      status: 'COMPLETED',
      amount: { value: '5.00', currency_code: 'USD' },
      custom_id: 'eaa59125-66e9-4b8e-a080-f63f19181461',
      create_time: '2026-08-30T00:00:00Z',
      links: [{
        rel: 'up', href: 'https://api-m.sandbox.paypal.com/v2/payments/captures/CAPTURE12345',
      }],
    };
    const localRefund = {
      id: refund.custom_id!, order_id: local.order_id, amount: '5.00', currency: 'USD',
      parent_provider_reference: 'CAPTURE12345',
    };
    expect(() => validatePayPalRefund(refund, localRefund)).not.toThrow();
    expect(normalizedPayPalRefundData(refund, localRefund)).toMatchObject({
      amount: '5.00', capture_reference: 'CAPTURE12345',
    });
  });

  test('USD decimal 不使用浮点换算，渠道错误不回传原始消息', async () => {
    expect(normalizeCheckoutAmount('0.01', 'USD')).toBe('0.01');
    expect(normalizeCheckoutAmount('9999999999.99', 'usd')).toBe('9999999999.99');
    expect(() => normalizeCheckoutAmount('10.001', 'USD')).toThrow('at most two places');
    expect(() => normalizeCheckoutAmount('10', 'EUR')).toThrow('outside the current USD capability');
    expect(payPalApiBase(false)).toBe('https://api-m.sandbox.paypal.com');
    expect(payPalApiBase(true)).toBe('https://api-m.paypal.com');
    expect(() => payPalApiBase(false, 'https://attacker.example')).toThrow('untrusted');
    expect(() => payPalApiBase(true, 'https://api-m.sandbox.paypal.com'))
      .toThrow('does not match');
    expect(() => payPalApiBase(true, 'http://host.docker.internal:43123'))
      .toThrow('does not match');
    expect(parsePayPalLivemode('false')).toBe(false);
    expect(() => parsePayPalLivemode('yes')).toThrow('must be true or false');

    const fetcher: PayPalFetcher = async (input) => {
      if (String(input).endsWith('/v1/oauth2/token')) {
        return new Response(JSON.stringify({ access_token: MOCK_ACCESS_TOKEN, expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({
        name: 'UNPROCESSABLE_ENTITY',
        message: 'buyer-secret@example.com was rejected',
        details: [{ issue: 'INSTRUMENT_DECLINED' }],
      }), { status: 422 });
    };
    try {
      await payPalRequest('/v2/checkout/orders', { ...config, fetcher, body: {} });
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(PayPalIntegrationError);
      expect((error as PayPalIntegrationError).code).toBe('instrument_declined');
      expect((error as Error).message).toBe('PayPal rejected the request');
      expect((error as Error).message).not.toContain('buyer-secret@example.com');
    }
  });
});
