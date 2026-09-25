export function reportRange(start: string, end: string) {
  const explicit =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
  const a = Date.parse(start),
    b = Date.parse(end);
  if (
    !explicit.test(start) ||
    !explicit.test(end) ||
    !Number.isFinite(a) ||
    !Number.isFinite(b) ||
    b <= a ||
    b - a > 744 * 3600_000
  )
    throw Error(
      "Use explicit ISO timestamps with timezone offsets, start before end, at most 744 hours apart.",
    );
  return { start_at: start, end_at: end };
}
