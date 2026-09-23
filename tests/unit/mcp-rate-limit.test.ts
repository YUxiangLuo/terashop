import { expect, test } from 'bun:test';
import { createRateLimit } from '../../mcp/src/rate-limit';

test('rate budget isolates keys, refills at the boundary and bounds key churn', () => {
  const take = createRateLimit(2, 2, 2);
  expect(take('alice', 0)).toBe(0);
  expect(take('alice', 0)).toBe(0);
  expect(take('alice', 499)).toBe(1);
  expect(take('bob', 499)).toBe(0);
  expect(take('carol', 499)).toBe(1);
  expect(take('alice', 500)).toBe(0);
  expect(take('alice', 500)).toBe(1);
  expect(take('carol', 1000)).toBe(0); // Only Bob's fully refilled bucket can be evicted.
  expect(take('alice', 1000)).toBe(0);
  expect(take('alice', 1000)).toBe(1);
});
