/**
 * Stop places from the stop catalog: stop points named alike (`Europaplatz`, `Europaplatz (U)`)
 * and standing close are one place, with one page. A network's overrides join and part what the
 * names miss. `npm run refresh:stops` writes the result to the network's `generated/`.
 */
import type {
  CatalogStop,
  StopPlaceDefinition,
  StopPlaceOverrides,
} from "../networks/network-definition";
import { getDistanceMeters } from "./geo";
import { getBaseName } from "./stop-naming";
import { createStopSlug } from "./stop-slug";

/** Farther apart than a tunnel and the street above it, nearer than the next stop. */
export const STOP_PLACE_JOIN_METERS = 250;

export function deriveStopPlaces(
  catalog: readonly CatalogStop[],
  homePlaceName: string,
  overrides: StopPlaceOverrides = {},
): Record<string, StopPlaceDefinition> {
  const catalogIds = new Set(catalog.map(({ globalId }) => globalId));
  const named = [
    ...(overrides.joins ?? []).flat(),
    ...(overrides.splits ?? []),
    ...Object.keys(overrides.slugs ?? {}),
    ...Object.keys(overrides.partNames ?? {}),
  ];
  assertNone(
    named.filter((globalId) => !catalogIds.has(globalId)),
    "Stop place overrides name stop points the catalog lacks",
  );

  const splits = new Set(overrides.splits);
  let groups: CatalogStop[][] = [];
  for (const stop of catalog) {
    const isSplit = splits.has(stop.globalId);
    groups = joinGroups(
      groups,
      (group) =>
        !isSplit && group.some((other) => isSamePlace(other, stop) && !splits.has(other.globalId)),
      [stop],
    );
  }
  for (const stopPointIds of overrides.joins ?? []) {
    groups = joinGroups(groups, (group) =>
      group.some(({ globalId }) => stopPointIds.includes(globalId)),
    );
  }

  const places = groups.map((group) => {
    // The busiest stop point names and places the page.
    const stops = [...group].sort((a, b) => b.callCount - a.callCount);
    const name = getBaseName(stops[0].name);
    const placeName = getBaseName(stops[0].placeName);
    const pinned = stops.map(({ globalId }) => overrides.slugs?.[globalId]).find(Boolean);
    return { stops, name, placeName, slug: pinned ?? getSlug(name, placeName, homePlaceName) };
  });

  const slugCounts = new Map<string, number>();
  for (const { slug } of places) slugCounts.set(slug, (slugCounts.get(slug) ?? 0) + 1);
  const entries = places.map(({ stops, name, placeName, slug }) => {
    // A name repeated within one district takes its stop number.
    const id = slugCounts.get(slug)! > 1 ? `${slug}-${stops[0].globalId.split(":").at(-1)}` : slug;
    const formerName = overrides.formerNames?.[id];
    const definition: StopPlaceDefinition = {
      name,
      ...(placeName === homePlaceName ? {} : { placeName }),
      ...(formerName ? { formerName } : {}),
      stopPoints: stops.map(({ globalId }) => globalId) as [string, ...string[]],
      ...(stops.length > 1
        ? {
            parts: stops.map(
              ({ globalId, name }) => overrides.partNames?.[globalId] ?? getPartName(name),
            ),
          }
        : {}),
    };
    return [id, definition] as const;
  });
  assertNone(
    entries.flatMap(([id, { parts = [] }]) =>
      new Set(parts).size < parts.length ? [`${id} (${parts.join(", ")})`] : [],
    ),
    "Parts share a name; give them partNames",
  );
  const ids = new Set(entries.map(([id]) => id));
  assertNone(
    Object.keys(overrides.formerNames ?? {}).filter((id) => !ids.has(id)),
    "Former names are kept for stop places that no longer exist",
  );
  return Object.fromEntries([...entries].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Stop points met outside the catalog, joined as the catalog's are (by name and distance), in the
 * order each place was first met.
 */
export function groupSamePlaceStops<T extends PlacedStop>(stops: readonly T[]): T[][] {
  let groups: T[][] = [];
  for (const stop of stops) {
    // A stop near two groups joins them: the tunnel between a station's two ends.
    const first = groups.findIndex((group) => group.some((other) => isSamePlace(other, stop)));
    if (first < 0) {
      groups.push([stop]);
      continue;
    }
    const isJoined = (group: readonly T[]) => group.some((other) => isSamePlace(other, stop));
    const joined = groups.filter(isJoined).flat();
    groups = groups.flatMap((group, index) =>
      index === first ? [[...joined, stop]] : isJoined(group) ? [] : [group],
    );
  }
  return groups;
}

/** The groups `isJoined` picks, and `added`, as one group after the rest. */
function joinGroups<T>(
  groups: readonly T[][],
  isJoined: (group: readonly T[]) => boolean,
  added: readonly T[] = [],
): T[][] {
  const kept: T[][] = [];
  const joined: T[] = [];
  for (const group of groups) {
    if (isJoined(group)) joined.push(...group);
    else kept.push(group);
  }
  return [...kept, [...joined, ...added]];
}

/** A stale override would otherwise drop out unnoticed at the next refresh. */
function assertNone(stale: readonly string[], message: string): void {
  if (stale.length > 0) throw new Error(`${message}: ${stale.join(", ")}`);
}

/** The parts a name says only by its `(U)`, or by having none. */
export const UPPER_PART_NAME = "Oben";
export const LOWER_PART_NAME = "Unten";

/** The operator's bracketed aside (`Marktplatz (Pyramide U)` → `Pyramide`). */
function getPartName(name: string): string {
  const aside = /\(([^)]*)\)/.exec(name)?.[1].trim();
  if (aside === undefined) return UPPER_PART_NAME;
  return aside.replace(/\s*\bU$/, "") || LOWER_PART_NAME;
}

/** A stop point as joining reads it. */
type PlacedStop = { name: string; placeName?: string; latitude: number; longitude: number };

const isSamePlace = (a: PlacedStop, b: PlacedStop): boolean =>
  a.placeName === b.placeName &&
  getBaseName(a.name) === getBaseName(b.name) &&
  getDistanceMeters(a.latitude, a.longitude, b) <= STOP_PLACE_JOIN_METERS;

/** The name before any `/` (`Ettlinger Tor/Staatstheater`), led by its district outside home. */
function getSlug(name: string, placeName: string, homePlaceName: string): string {
  const slug = createStopSlug(name.split("/")[0]);
  const district = createStopSlug(placeName);
  return placeName === homePlaceName || slug.startsWith(`${district}-`)
    ? slug
    : `${district}-${slug}`;
}
