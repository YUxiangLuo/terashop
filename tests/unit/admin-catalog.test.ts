import { expect, test } from 'bun:test';
import {
  missingVariants,
  optionChanges,
  parseProductTags,
  validateVariants,
  variantLabel,
  type ProductOption,
  type ProductVariant,
} from '../../admin/src/lib/catalog';

const options: ProductOption[] = [
  {
    id: 'color',
    name: 'Color',
    position: 3,
    values: [
      { id: 'sage', value: 'Sage', position: 2 },
      { id: 'ink', value: 'Ink', position: 7 },
    ],
  },
  {
    id: 'size',
    name: 'Size',
    position: 8,
    values: [
      { id: 's', value: 'S', position: 1 },
      { id: 'm', value: 'M', position: 4 },
      { id: 'l', value: 'L', position: 9 },
    ],
  },
];
const existing: ProductVariant = {
  id: 'keep-id',
  sku: 'KEEP-SKU',
  barcode: '012345',
  price: 37.25,
  compare_at_price: 40,
  cost: 12.5,
  is_active: false,
  track_inventory: false,
  option_value_ids: ['m', 'sage'],
};

test('tag editing parses once without mutating untouched metadata', () => {
  const original = ['linen, blend', '  intentionally spaced  '];
  expect(parseProductTags('summer, linen , dresses')).toEqual(['summer', 'linen', 'dresses']);
  expect(original).toEqual(['linen, blend', '  intentionally spaced  ']);
});

test('generate only missing asymmetric combinations, preserving inactive identities and input order', () => {
  const before = structuredClone(existing);
  const added = missingVariants(options, [existing], 49.75);
  expect(added.map((v) => v.option_value_ids)).toEqual([
    ['sage', 's'],
    ['sage', 'l'],
    ['ink', 's'],
    ['ink', 'm'],
    ['ink', 'l'],
  ]);
  expect(new Set(added.map((v) => v.id)).size).toBe(5);
  expect(
    added.every(
      (v) =>
        v.price === 49.75 &&
        v.sku === null &&
        v.barcode === null &&
        v.compare_at_price === null &&
        v.cost === null &&
        v.is_active &&
        v.track_inventory,
    ),
  ).toBe(true);
  expect(existing).toEqual(before);
  expect(missingVariants(options, [existing, ...added], 17)).toEqual([]);
  expect(variantLabel(existing, options)).toBe('Sage / M');
});

test('standard variants and incomplete existing variants are not repurposed', () => {
  expect(missingVariants([], [], 0)[0].option_value_ids).toEqual([]);
  expect(missingVariants([], [{ ...existing, option_value_ids: [] }], 1)).toEqual([]);
  expect(missingVariants(options, [{ ...existing, option_value_ids: ['sage'] }], 2)).toHaveLength(6);
});

test('bound Cartesian expansion before allocation and count retained variants', () => {
  const many = (count: number): ProductOption[] => [
    {
      id: 'n',
      name: 'Number',
      position: 0,
      values: Array.from({ length: count }, (_, i) => ({
        id: String(i),
        value: String(i),
        position: i,
      })),
    },
  ];
  expect(missingVariants(many(500), [], 1)).toHaveLength(500);
  expect(() => missingVariants(many(501), [], 1)).toThrow('500');
  expect(() => missingVariants(many(500), [existing], 1)).toThrow('500');
  expect(() => missingVariants([{ ...options[0], values: [] }], [], 1)).toThrow('at least one');
  expect(() => missingVariants(options, [], NaN)).toThrow('price');
});

test('published combinations require completeness and uniqueness, drafts may be incomplete', () => {
  const active = { ...existing, is_active: true };
  expect(() => validateVariants(options, [active], true)).not.toThrow();
  expect(() =>
    validateVariants(
      options,
      [active, { ...active, id: 'duplicate', option_value_ids: ['sage', 'm'] }],
      true,
    ),
  ).toThrow('unique');
  expect(() => validateVariants(options, [active, existing], true)).not.toThrow();
  expect(() => validateVariants(options, [{ ...active, option_value_ids: ['sage'] }], true)).toThrow(
    'each option',
  );
  expect(() => validateVariants(options, [{ ...active, option_value_ids: ['sage'] }], false)).not.toThrow();
  expect(() => validateVariants([], [], true)).toThrow('Add a variant');
});

test('PATCH explicitly deletes values but not twice after deleting their parent; positions survive', () => {
  const current = [
    {
      ...options[1],
      values: [options[1].values[1], { id: 'xl', value: 'XL', position: 12 }],
    },
  ];
  expect(optionChanges(current, options)).toEqual({
    options: [
      { id: 'color', delete: true },
      { id: 'size', name: 'Size', position: 8 },
    ],
    option_values: [
      { id: 's', delete: true },
      { id: 'l', delete: true },
      { id: 'm', value: 'M', position: 4, option_id: 'size' },
      { id: 'xl', value: 'XL', position: 12, option_id: 'size' },
    ],
  });
  expect(optionChanges([], options)).toEqual({
    options: [
      { id: 'color', delete: true },
      { id: 'size', delete: true },
    ],
    option_values: [],
  });
});
