/** Adds a value to a list used as a set, keeping first-seen order. */
export function addOnce(values: string[], value: string) {
  if (!values.includes(value)) values.push(value);
}

/** Distinct values, most frequent first. */
export function getDistinctByFrequency(values: Iterable<string>): string[] {
  const countByValue = new Map<string, number>();
  for (const value of values) countByValue.set(value, (countByValue.get(value) ?? 0) + 1);
  return [...countByValue.entries()].sort(([, a], [, b]) => b - a).map(([value]) => value);
}

/** Distinct ids in a stable order, so differently ordered callers share one cached reading. */
export const toSortedIds = (values: Iterable<string>): string[] => [...new Set(values)].sort();

/** The ids as one key. */
export const createSortedKey = (values: Iterable<string>): string => toSortedIds(values).join(",");
