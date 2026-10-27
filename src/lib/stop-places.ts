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
  const splits = new Set(overrides.splits);
  const groups: CatalogStop[][] = [];
  for (const stop of catalog) {
    const joining = splits.has(stop.globalId)
      ? []
      : groups.filter((group) =>
          group.some((other) => isSamePlace(other, stop) && !splits.has(other.globalId)),
        );
    for (const group of joining) groups.splice(groups.indexOf(group), 1);
    groups.push([...joining.flat(), stop]);
  }
  for (const stopPointIds of overrides.joins ?? []) {
    const joined = groups.filter((group) =>
      group.some(({ globalId }) => stopPointIds.includes(globalId)),
    );
    for (const group of joined) groups.splice(groups.indexOf(group), 1);
    groups.push(joined.flat());
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
  return Object.fromEntries([...entries].sort(([a], [b]) => a.localeCompare(b)));
}

/** The operator's bracketed aside (`Marktplatz (Pyramide U)` → `Pyramide`); `U` alone is the tunnel. */
function getPartName(name: string): string {
  const aside = /\(([^)]*)\)/.exec(name)?.[1].trim();
  if (aside === undefined) return "Straße";
  return aside.replace(/\s*\bU$/, "") || "Tunnel";
}

const isSamePlace = (a: CatalogStop, b: CatalogStop): boolean =>
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
