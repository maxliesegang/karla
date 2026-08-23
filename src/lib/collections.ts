/** Adds a value to a list used as a set, keeping first-seen order. */
export function addOnce(values: string[], value: string) {
  if (!values.includes(value)) values.push(value);
}

/**
 * The distinct values, most frequent first — it deduplicates as well as orders, which is why it is
 * not a `sort`. Used wherever a set of observations has to lead with what was actually seen most:
 * the destination a line mostly runs to, rather than a rare short working that was read first.
 */
export function getDistinctByFrequency(values: Iterable<string>): string[] {
  const countByValue = new Map<string, number>();
  for (const value of values) countByValue.set(value, (countByValue.get(value) ?? 0) + 1);
  return [...countByValue.entries()].sort(([, a], [, b]) => b - a).map(([value]) => value);
}

/**
 * A set of ids in one stable order, so two callers naming the same ids in different orders address
 * one cached reading rather than two.
 */
export const toSortedIds = (values: Iterable<string>): string[] => [...new Set(values)].sort();

/** The same set as a single key, which is how a load addresses several ids at once. */
export const createSortedKey = (values: Iterable<string>): string => toSortedIds(values).join(",");
