import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { HttpError } from '../../supabase/functions/_shared/http.ts';
import { ingestApiPaymentEvent, sha256Hex } from '../../supabase/functions/_shared/provider-events.ts';
import { parseRefundRequest } from '../../supabase/functions/_shared/refunds.ts';
import { PayPalIntegrationError } from '../../supabase/functions/_shared/paypal.ts';

const orderId = '11111111-1111-4111-8111-111111111111';
const itemId = '22222222-2222-4222-8222-222222222222';
const base = { order_id: orderId, idempotency_key: ' refund-command ' };
const item = { order_item_id: itemId, quantity: 1 };
const parsedItem = { ...item, restock_shipped_quantity: 0 };

describe('PayPal 退款参数', () => {
  test('保留默认值、原始金额及商品行，丢弃额外字段', () => {
    const expected = {
      order_id: orderId, idempotency_key: 'refund-command',
      items: null, amount: null, shipping_amount: null, reason: null, restock: false,
    };
    expect(parseRefundRequest(base)).toEqual(expected);
    for (const amount of [10, '10.0', '0.01']) {
      expect(parseRefundRequest({ ...base, amount }))
        .toEqual({ ...expected, amount });
    }
    expect(parseRefundRequest({
      ...base, items: [{ ...item, ignored: true }, item], restock: true, reason: '',
      actor_id: 'untrusted', provider: 'untrusted',
    })).toEqual({ ...expected, items: [parsedItem, parsedItem], restock: true, reason: '' });
    expect(parseRefundRequest({ ...base, items: [{ order_item_id: itemId, quantity: 2, restock_shipped_quantity: 2 }] }).items)
      .toEqual([{ order_item_id: itemId, quantity: 2, restock_shipped_quantity: 2 }]);
    expect(parseRefundRequest({
      ...base, items: null, amount: null, reason: null,
    })).toEqual(expected);
    expect(parseRefundRequest({
      ...base, items: Array(100).fill(item), reason: 'x'.repeat(1000),
    }).items).toHaveLength(100);
  });

  test('保留请求边界校验与错误信息', () => {
    const invalid: Array<[Record<string, unknown>, string]> = [
      [{ order_id: 'bad' }, 'order_id must be a UUID'],
      [{ idempotency_key: '' }, 'idempotency_key is required'],
      [{ items: [] }, 'at most 100 lines'],
      [{ items: Array(101).fill(item) }, 'at most 100 lines'],
      [{ items: {} }, 'at most 100 lines'],
      [{ items: [null] }, 'Invalid refund item'],
      [{ items: [[]] }, 'Invalid refund item'],
      [{ items: [{ ...item, order_item_id: 'bad' }] }, 'order_item_id must be a UUID'],
      ...[0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1].map(quantity => [
        { items: [{ ...item, quantity }] }, 'Refund quantity must be a positive integer',
      ] as [Record<string, unknown>, string]),
      ...[-1, 1.5, '1', 2].map(restock_shipped_quantity => [
        { items: [{ ...item, restock_shipped_quantity }] }, 'restock_shipped_quantity must be an integer between 0 and quantity',
      ] as [Record<string, unknown>, string]),
      [{ items: [item], amount: '10.00' }, 'Pass either items or amount'],
      [{ amount: {} }, 'amount must be a decimal'],
      [{ reason: 1 }, 'reason must be text'],
      [{ reason: 'x'.repeat(1001) }, 'reason must be at most 1000 characters'],
      [{ restock: null }, 'restock must be boolean'],
      [{ restock: 'true' }, 'restock must be boolean'],
    ];
    for (const [overrides, message] of invalid) {
      expect(() => parseRefundRequest({ ...base, ...overrides })).toThrow(message);
    }
  });

  test('配送净额可单独或随商品退款，与未分配金额互斥', () => {
    expect(parseRefundRequest({ ...base, shipping_amount: '4.00' })).toMatchObject({ shipping_amount: '4.00', items: null, amount: null });
    expect(parseRefundRequest({ ...base, items: [item], shipping_amount: 4 })).toMatchObject({ shipping_amount: 4, items: [item] });
    expect(() => parseRefundRequest({ ...base, shipping_amount: {}, amount: null })).toThrow('shipping_amount must be a decimal');
    expect(() => parseRefundRequest({ ...base, shipping_amount: 1, amount: 2 })).toThrow('Pass either shipping_amount or amount');
  });

  test('金额校验仍使用渠道自己的错误类型', () => {
    for (const key of ['amount', 'shipping_amount']) for (const amount of [0, -1, NaN, Infinity, '1.001', '10000000000']) {
      expect(() => parseRefundRequest({ ...base, [key]: amount })).toThrow(PayPalIntegrationError);
    }
  });
});

test('SHA-256 保留原始 UTF-8 字节与空白差异', async () => {
  for (const raw of ['', 'abc', '{"note":"支付"}', '{"note":"支付"}\n']) {
    expect(await sha256Hex(raw)).toBe(createHash('sha256').update(raw).digest('hex'));
  }
});

test('API 入箱保持既有哈希、事件 ID、时间戳、模式与错误行为', async () => {
  const originalFetch = globalThis.fetch;
  const originalDeno = Object.getOwnPropertyDescriptor(globalThis, 'Deno');
  const requests: Record<string, unknown>[] = [];
  let responseStatus = 200;
  const result = { status: 'processed', outcome: 'captured' };
  Object.defineProperty(globalThis, 'Deno', {
    configurable: true,
    value: { env: { get: (name: string) => ({
      SUPABASE_URL: 'http://supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
    } as Record<string, string>)[name] } },
  });
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    expect(request.url).toBe('http://supabase.test/rest/v1/rpc/ingest_payment_provider_event');
    expect(request.method).toBe('POST');
    expect(request.headers.get('Authorization')).toBe('Bearer test-service-key');
    requests.push(await request.json() as Record<string, unknown>);
    return new Response(JSON.stringify(responseStatus === 200 ? result : {
      code: 'event_conflict', message: 'provider event id was reused with different facts',
    }), { status: responseStatus });
  }) as typeof fetch;
  try {
    for (const [provider, resource, reference, status, eventType, livemode] of [
      ['paypal', 'capture', 'CAPTURE123', 'COMPLETED', 'paypal.capture.api_result', false],
      ['paypal', 'refund', 'REFUND123', 'PENDING', 'paypal.refund.api_result', true],
    ] as const) {
      const occurredAt = '2026-08-30T00:00:00.000Z';
      const data = { object_type: resource, status, currency: 'USD' };
      // Pin the pre-refactor serialization independently of the shared helper.
      const payloadHash = createHash('sha256')
        .update(JSON.stringify({ occurred_at: occurredAt, data })).digest('hex');
      const event = { provider, resource, reference, status, eventType, livemode, occurredAt, data };
      expect(await ingestApiPaymentEvent(event)).toEqual(result);
      expect(requests.at(-1)).toEqual({
        provider,
        provider_event_id: `api:${resource}:${reference}:${status}:${payloadHash.slice(0, 16)}`,
        source: 'api_response', event_type: eventType, object_reference: reference,
        livemode, occurred_at: occurredAt, payload_hash: payloadHash, data,
      });
      await ingestApiPaymentEvent(event);
      expect(requests.at(-1)).toEqual(requests.at(-2));
      responseStatus = 409;
      await expect(ingestApiPaymentEvent(event)).rejects.toBeInstanceOf(HttpError);
      await expect(ingestApiPaymentEvent(event)).rejects.toMatchObject({
        status: 409, code: 'event_conflict',
        message: 'provider event id was reused with different facts',
      });
      responseStatus = 200;
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDeno) Object.defineProperty(globalThis, 'Deno', originalDeno);
    else Reflect.deleteProperty(globalThis, 'Deno');
  }
});
