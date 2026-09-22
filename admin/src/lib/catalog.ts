export interface ProductOption {
  id: string;
  name: string;
  position: number;
  values: Array<{ id: string; value: string; position: number }>;
}
export interface ProductVariant {
  id: string;
  sku: string | null;
  price: number;
  is_active: boolean;
  track_inventory: boolean;
  option_value_ids: string[];
}

export function variantLabel(
  variant: ProductVariant,
  options: ProductOption[],
) {
  return (
    options
      .flatMap((option) =>
        option.values
          .filter((value) => variant.option_value_ids.includes(value.id))
          .map((value) => value.value),
      )
      .join(" / ") ||
    (options.length ? "Incomplete combination" : "Standard variant")
  );
}

function validateOptions(options: ProductOption[]) {
  if (
    options.some(
      (option) =>
        !option.name.trim() ||
        option.values.some((value) => !value.value.trim()),
    )
  )
    throw new Error("Enter a name for every option and value.");
  if (
    new Set(options.map((option) => option.name)).size !== options.length ||
    options.some(
      (option) =>
        new Set(option.values.map((value) => value.value)).size !==
        option.values.length,
    )
  )
    throw new Error("Option names and values within an option must be unique.");
}

export function validateVariants(
  options: ProductOption[],
  variants: ProductVariant[],
  active: boolean,
) {
  validateOptions(options);
  const combinations = new Set<string>();
  if (active && !variants.length)
    throw new Error("Add a variant before publishing.");
  for (const variant of variants) {
    if (active && variant.is_active) {
      if (
        options.some(
          (option) =>
            option.values.filter((value) =>
              variant.option_value_ids.includes(value.id),
            ).length !== 1,
        )
      )
        throw new Error(
          "Every active variant needs one value for each option before publishing.",
        );
      const key = [...variant.option_value_ids].sort().join(",");
      if (combinations.has(key))
        throw new Error(
          "Active variants must have unique option combinations before publishing.",
        );
      combinations.add(key);
    }
  }
}

// Never replace an existing variant: its identity may own inventory and order history.
export function missingVariants(
  options: ProductOption[],
  variants: ProductVariant[],
  price: number,
): ProductVariant[] {
  validateOptions(options);
  if (!Number.isFinite(price) || price < 0 || price > 9999999999.99)
    throw new Error("Enter a valid price for new variants.");
  let count = 1;
  for (const option of options) {
    if (!option.values.length)
      throw new Error("Add at least one value to every option.");
    count *= option.values.length;
    if (count > 500)
      throw new Error("Limit combinations to 500 before generating variants.");
  }
  let combinations: string[][] = [[]];
  for (const option of options)
    combinations = combinations.flatMap((ids) =>
      option.values.map((value) => [...ids, value.id]),
    );
  const existing = new Set(
    variants.map((variant) => [...variant.option_value_ids].sort().join(",")),
  );
  const missing = combinations.filter(
    (ids) => !existing.has([...ids].sort().join(",")),
  );
  if (variants.length + missing.length > 500)
    throw new Error("A product can have at most 500 variants in this editor.");
  return missing.map((ids) => ({
    id: crypto.randomUUID(),
    sku: null,
    price,
    is_active: true,
    track_inventory: true,
    option_value_ids: ids,
  }));
}

export function optionChanges(
  options: ProductOption[],
  original: ProductOption[],
) {
  const deleted = original.filter(
    (old) => !options.some((option) => option.id === old.id),
  );
  return {
    options: [
      ...deleted.map((option) => ({ id: option.id, delete: true })),
      ...options.map(({ id, name, position }) => ({ id, name, position })),
    ],
    option_values: [
      // Parent deletion already cascades to values; do not delete them twice.
      ...original
        .filter((old) => !deleted.includes(old))
        .flatMap((option) =>
          option.values
            .filter(
              (old) =>
                !options.some((current) =>
                  current.values.some((value) => value.id === old.id),
                ),
            )
            .map((value) => ({ id: value.id, delete: true })),
        ),
      ...options.flatMap((option) =>
        option.values.map((value) => ({ ...value, option_id: option.id })),
      ),
    ],
  };
}
