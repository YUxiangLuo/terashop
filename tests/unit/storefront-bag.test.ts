import { expect, test } from 'bun:test';
import { parseBag } from '../../storefront/src/lib/bag';

test('bag treats stored data as untrusted and never restores stored price or HTML', () => {
  const product_id = '11111111-1111-4111-8111-111111111111';
  const variant_id = '22222222-2222-4222-8222-222222222222';
  const valid = { product_id, variant_id, quantity: 3 };
  expect(parseBag(JSON.stringify([{ ...valid, price: 0.01, name: '<script>bad</script>' }]))).toEqual([valid]);
  expect(parseBag(JSON.stringify([valid, { ...valid, quantity: 9 }]))).toEqual([valid]);
  for (const quantity of [0, -1, 11, 1.5, '2', null]) {
    expect(parseBag(JSON.stringify([{ ...valid, quantity }]))).toEqual([]);
  }
  expect(parseBag(JSON.stringify([{ ...valid, quantity: 10 }]))[0].quantity).toBe(10);
  expect(parseBag(JSON.stringify([{ ...valid, product_id: [product_id] }]))).toEqual([]);
  for (const value of [null, '{', '{}', 'null', JSON.stringify(Array(51).fill(valid))]) {
    expect(parseBag(value)).toEqual([]);
  }
});
