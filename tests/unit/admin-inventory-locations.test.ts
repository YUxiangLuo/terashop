import { expect, test } from 'bun:test';
import {
  allowsNewInventoryOperation,
  inventoryLocationSelection,
} from '../../admin/src/lib/inventory-locations';

const location = (id: string, is_active: boolean, is_default = false) => ({
  id,
  name: id,
  code: id,
  is_active,
  is_default,
  revision: 1,
  address: {},
  created_at: '2026-01-01T00:00:00Z',
});

test('historical inactive warehouse selection is retained but cannot start a write', () => {
  const locations = [location('old', false), location('current', true, true)];
  expect(inventoryLocationSelection(locations, 'old')).toBe('old');
  expect(allowsNewInventoryOperation(locations, 'old')).toBe(false);
  expect(allowsNewInventoryOperation(locations, 'current')).toBe(true);
});

test('unknown selections never become eligible and initial selection prefers active default', () => {
  const locations = [location('history', false), location('active', true), location('default', true, true)];
  expect(inventoryLocationSelection(locations, 'removed')).toBe('default');
  expect(allowsNewInventoryOperation(locations, 'removed')).toBe(false);
  expect(inventoryLocationSelection([location('history', false)], null)).toBe('history');
});
