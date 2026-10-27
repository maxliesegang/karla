/**
 * A network's reach in the feed: which data pools' lines a board keeps, and where a found stop may
 * stand. The feed answers far beyond it (all of Baden-Württemberg; docs/trias-api.md).
 */

export type Bounds = { south: number; north: number; west: number; east: number };

export type NetworkScope = {
  /** Pools as a line or journey ref's first segment (`kvv` in `kvv:22304:E:H:s26`). */
  pools: ReadonlySet<string>;
  bounds: Bounds;
};

/** A ref's pool: `kvv` for `kvv:22304:E:H:s26`; none for a ref without one. */
export function getRefPool(ref: string | undefined): string | undefined {
  const separator = ref?.indexOf(":") ?? -1;
  return ref && separator >= 0 ? ref.slice(0, separator) : undefined;
}

export function isWithinScopePools(scope: NetworkScope, ref: string | undefined): boolean {
  const pool = getRefPool(ref);
  return pool !== undefined && scope.pools.has(pool);
}

export function isWithinScopeBounds(
  scope: NetworkScope,
  latitude: number,
  longitude: number,
): boolean {
  const { south, north, west, east } = scope.bounds;
  return latitude >= south && latitude <= north && longitude >= west && longitude <= east;
}
