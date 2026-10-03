import type { TripCall } from "../data/transit-types";
import { getDistanceMeters } from "./geo";
import { getBaseName } from "./stop-naming";
import { getVisitedStopKeys, getCallSequenceKey } from "./trip-calls";

/** The way a corridor's row sketches: its trips' ends, and the places between worth naming. */

/** One place along a corridor's way: an end a trip turns back at, or a place the way passes. */
export type StopServiceCorridorPlace = {
  label: string;
  /** Whether a trip ends here. Ends are always shown; places between only where there is room. */
  isTerminus: boolean;
  /**
   * Prominence among the way's places (connections, then calls), most prominent first; ends have
   * none.
   */
  rank?: number;
};

/** Calls to one place that make it a place the way winds through, as opposed to passes. */
const PROMINENT_PLACE_CALL_COUNT = 2;

/** Places a row states. Every end is stated regardless; this limits the places between them. */
const CORRIDOR_PLACE_COUNT = 3;

/**
 * Where a line family was seen serving a place. One name can mean two places (`Friedrichstal` on
 * the S2 and on the S8, 70 km apart), so connections count only where positions agree.
 */
export type PlaceSighting = Pick<TripCall, "latitude" | "longitude">;

/** The line families each place is served by, and where each was seen. */
export type PlaceLineFamilies = ReadonlyMap<string, ReadonlyMap<string, PlaceSighting>>;

/**
 * How far apart two sightings may be and still be one place: wider than a town, far short of 70 km.
 */
const SAME_PLACE_RADIUS_METERS = 15_000;

/** Whether two sightings are one place; one without a position matches by name. */
function isSamePlace(sighting: PlaceSighting, here: PlaceSighting): boolean {
  if (here.latitude === undefined || here.longitude === undefined) return true;
  if (sighting.latitude === undefined || sighting.longitude === undefined) return true;
  return getDistanceMeters(here.latitude, here.longitude, sighting) <= SAME_PLACE_RADIUS_METERS;
}

/** What the way reads each place's prominence from, beside the route itself. */
export type CorridorWayKnowledge = {
  /** The board's municipality, whose places say nothing about the way out. */
  boardPlaceName: string | undefined;
  lineFamiliesByPlace: PlaceLineFamilies;
  /** The corridor line's own family, which is no connection to itself. */
  lineFamilyId: string;
};

/**
 * The place a call names a direction by: the feed's place (a municipality or a Karlsruhe district
 * like `Durlach`), or the stop name where that is the rider's own place.
 */
export function getCallDirectionLabel(call: TripCall, boardPlaceName: string | undefined): string {
  const placeName = call.placeName && getBaseName(call.placeName);
  return placeName && placeName !== boardPlaceName ? placeName : call.stopName;
}

/** The corridor's ends in route order: what a rider picks between. */
export const getCorridorTermini = (
  places: readonly StopServiceCorridorPlace[],
): StopServiceCorridorPlace[] => places.filter(({ isTerminus }) => isTerminus);

/** The way after the least prominent places between the ends stand down; ends never do. */
export function getShownCorridorPlaces(
  places: readonly StopServiceCorridorPlace[],
  standDownCount: number,
): StopServiceCorridorPlace[] {
  const wayPlaceCount = places.length - getCorridorTermini(places).length;
  const kept = Math.max(0, wayPlaceCount - standDownCount);
  return places.filter((place) => place.isTerminus || (place.rank ?? 0) < kept);
}

type WayEvent = StopServiceCorridorPlace & { index: number };

/**
 * The corridor's distinct routes, shortest first, each a prefix of the next (a short working and
 * its through service). Routes that genuinely part return nothing.
 */
function findContinuationRoutes(
  sequences: readonly (readonly TripCall[])[],
): readonly (readonly TripCall[])[] | undefined {
  const routeByKey = new Map<string, readonly TripCall[]>();
  for (const sequence of sequences) routeByKey.set(getCallSequenceKey(sequence), sequence);
  const routes = [...routeByKey.values()].sort(
    (first, second) =>
      getVisitedStopKeys(first).length - getVisitedStopKeys(second).length ||
      first.length - second.length,
  );
  const visitedKeys = getVisitedStopKeys(routes.at(-1) ?? []);
  if (visitedKeys.length === 0) return undefined;

  const isContinuation = routes.every((route) =>
    getVisitedStopKeys(route).every((key, index) => key === visitedKeys[index]),
  );
  return isContinuation ? routes : undefined;
}

/** Where each route turns back; two ends in one place both stay. */
function findTerminusEvents(
  routes: readonly (readonly TripCall[])[],
  boardPlaceName: string | undefined,
): WayEvent[] {
  return routes.flatMap((route) => {
    const terminus = route.at(-1);
    if (!terminus) return [];
    return [
      {
        index: route.length - 1,
        label: getCallDirectionLabel(terminus, boardPlaceName),
        isTerminus: true,
      },
    ];
  });
}

/**
 * The places between the ends, ranked by connections to other lines, then by repeated calls. The
 * rider's own place is not counted.
 */
function findWayPlaceEvents(
  longest: readonly TripCall[],
  terminusLabels: ReadonlySet<string>,
  { boardPlaceName, lineFamiliesByPlace, lineFamilyId }: CorridorWayKnowledge,
): WayEvent[] {
  const sightingsByPlace = new Map<
    string,
    { count: number; firstIndex: number; here: PlaceSighting }
  >();
  for (const [index, call] of longest.entries()) {
    const placeName = call.placeName && getBaseName(call.placeName);
    if (!placeName || placeName === boardPlaceName || terminusLabels.has(placeName)) continue;
    const seen = sightingsByPlace.get(placeName);
    if (seen) seen.count += 1;
    else sightingsByPlace.set(placeName, { count: 1, firstIndex: index, here: call });
  }

  const candidates: { label: string; index: number; occurrences: number; connections: number }[] =
    [];
  for (const [placeName, { count, firstIndex, here }] of sightingsByPlace) {
    // A connection is another line seen at this place, not another one of the same name.
    const connections = [...(lineFamiliesByPlace.get(placeName) ?? [])].filter(
      ([familyId, sighting]) => familyId !== lineFamilyId && isSamePlace(sighting, here),
    ).length;
    if (connections < 1 && count < PROMINENT_PLACE_CALL_COUNT) continue;
    candidates.push({ label: placeName, index: firstIndex, occurrences: count, connections });
  }
  // Most prominent first, so the least useful stands down first.
  candidates.sort(
    (first, second) =>
      second.connections - first.connections || second.occurrences - first.occurrences,
  );
  return candidates.map(({ label, index }, rank) => ({ index, label, isTerminus: false, rank }));
}

/** The places along the way in route order: every end, and prominent places between. */
export function getCorridorWayPlaces(
  sequences: readonly (readonly TripCall[])[],
  knowledge: CorridorWayKnowledge,
): StopServiceCorridorPlace[] {
  const routes = findContinuationRoutes(sequences);
  const longest = routes?.at(-1);
  if (!routes || !longest) return [];

  const terminusEvents = findTerminusEvents(routes, knowledge.boardPlaceName);
  const terminusLabels = new Set(terminusEvents.map(({ label }) => label));
  const events = [...terminusEvents, ...findWayPlaceEvents(longest, terminusLabels, knowledge)];
  events.sort((first, second) => first.index - second.index);

  const places: StopServiceCorridorPlace[] = [];
  for (const { label, isTerminus, rank } of events) {
    // Only neighbouring repeats collapse, so an end revisited later is stated again.
    if (places.at(-1)?.label === label) continue;
    places.push(isTerminus ? { label, isTerminus } : { label, isTerminus, rank });
  }
  return takeMostRelevantPlaces(places);
}

/** The way cut to every end plus the most relevant places up to the count, re-ranked from 0. */
function takeMostRelevantPlaces(
  places: readonly StopServiceCorridorPlace[],
): StopServiceCorridorPlace[] {
  const wayPlaces = places.filter(({ isTerminus }) => !isTerminus);
  const room = Math.max(0, CORRIDOR_PLACE_COUNT - (places.length - wayPlaces.length));
  if (wayPlaces.length <= room) return [...places];

  const keptRankByLabel = new Map(
    [...wayPlaces]
      .sort((first, second) => (first.rank ?? 0) - (second.rank ?? 0))
      .slice(0, room)
      .map(({ label }, rank) => [label, rank] as const),
  );
  return places.flatMap((place) => {
    if (place.isTerminus) return [place];
    const rank = keptRankByLabel.get(place.label);
    return rank === undefined ? [] : [{ ...place, rank }];
  });
}
