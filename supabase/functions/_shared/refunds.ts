import { HttpError, requireIdempotencyKey, requireUuid } from './http.ts';

export interface RefundRequestDto {
  id: string;
  order_id: string;
  provider: string;
  status: string;
  amount: number | string;
  currency: string;
  provider_reference: string | null;
  parent_provider_reference: string;
}

function normalizeItems(value: unknown): Array<{ order_item_id: string; quantity: number }> | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new HttpError('items must be a non-empty array with at most 100 lines');
  }
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new HttpError('Invalid refund item');
    }
    const row = item as Record<string, unknown>;
    const id = requireUuid(row.order_item_id, 'order_item_id');
    if (!Number.isSafeInteger(row.quantity) || Number(row.quantity) <= 0) {
      throw new HttpError('Refund quantity must be a positive integer');
    }
    return { order_item_id: id, quantity: Number(row.quantity) };
  });
}

export function parseRefundRequest(
  body: Record<string, unknown>,
  validateAmount: (value: string | number, currency: string) => unknown,
) {
  const order_id = requireUuid(body.order_id, 'order_id');
  const idempotency_key = requireIdempotencyKey(body.idempotency_key);
  const items = normalizeItems(body.items);
  const amount = body.amount === undefined || body.amount === null ? null : body.amount;
  if (items && amount !== null) throw new HttpError('Pass either items or amount, not both');
  if (amount !== null && typeof amount !== 'string' && typeof amount !== 'number') {
    throw new HttpError('amount must be a decimal');
  }
  // Preserve each provider's decimal validation and error contract.
  if (amount !== null) validateAmount(amount, 'USD');
  if (body.reason !== undefined && body.reason !== null && typeof body.reason !== 'string') {
    throw new HttpError('reason must be text');
  }
  const reason = typeof body.reason === 'string' ? body.reason : null;
  if (reason && reason.length > 1000) throw new HttpError('reason must be at most 1000 characters');
  if (body.restock !== undefined && typeof body.restock !== 'boolean') {
    throw new HttpError('restock must be boolean');
  }
  return { order_id, idempotency_key, items, amount, reason, restock: body.restock === true };
}
