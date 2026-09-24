import { describe, expect, test } from 'bun:test';
import { customerReceipt } from '../../admin/src/lib/write-receipts';
import { customerCreateArguments } from '../../admin/src/lib/customer-draft';

const id = '11111111-1111-4111-8111-111111111111';
const addressId = '22222222-2222-4222-8222-222222222222';
const customer = {
  id,
  email: null,
  full_name: 'Offline customer',
  phone: null,
  has_account: false,
  anonymized_at: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00.123456Z',
  addresses: [
    {
      id: addressId,
      label: 'Home',
      recipient_name: 'Recipient',
      phone: null,
      country: 'US',
      region: null,
      city: null,
      line1: '1 Main St',
      line2: null,
      postal_code: null,
      is_default: false,
      updated_at: '2026-01-02T00:00:00.654321Z',
    },
  ],
};

describe('admin customer command receipts', () => {
  test('freezes the first normalized create arguments independently of the editable draft', () => {
    const draft = { full_name: 'Original', email: ' first@example.test ', phone: ' 123 ' };
    const submitted = customerCreateArguments(draft);
    draft.full_name = 'Changed after an unknown result';
    expect(submitted).toEqual({ full_name: 'Original', email: 'first@example.test', phone: '123' });
    expect(Object.isFrozen(submitted)).toBe(true);
  });

  test('accepts complete customer/address command results and nullable PII', () => {
    expect(customerReceipt(customer, id, customer.updated_at)).toBe(customer);
  });

  test('rejects malformed address results before replacing editor state', () => {
    const malformed = structuredClone(customer);
    delete (malformed.addresses[0] as Partial<(typeof customer.addresses)[0]>).updated_at;
    expect(() => customerReceipt(malformed, id, null)).toThrow('Invalid customer');
  });

  test('preserves exact microsecond optimistic-lock tokens', () => {
    expect(customerReceipt(customer, id, '2026-01-02T00:00:00.123456+00:00').updated_at).toBe(
      '2026-01-02T00:00:00.123456Z',
    );
  });
});
