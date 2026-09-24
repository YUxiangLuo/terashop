type Location = { id: string; is_active: boolean; is_default: boolean };

export function inventoryLocationSelection(
  locations: Location[],
  requested: string | null | undefined,
): string {
  if (requested && locations.some((location) => location.id === requested))
    return requested;
  return (
    locations.find((location) => location.is_active && location.is_default)
      ?.id ??
    locations.find((location) => location.is_active)?.id ??
    locations[0]?.id ??
    ""
  );
}

export function allowsNewInventoryOperation(
  locations: Location[],
  selected: string,
): boolean {
  return locations.some(
    (location) => location.id === selected && location.is_active,
  );
}
