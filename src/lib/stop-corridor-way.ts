import type { TripCall } from "../data/transit-types";
import { getDistanceMeters } from "./geo";
import { getBaseName } from "./stop-naming";
import { getVisitedStopKeys, getCallSequenceKey } from "./trip-calls";

/**
 * The way a corridor's row sketches: the ends its trips turn back at, and the places between them
 * worth naming.
 */

/**
 * One place along a corridor's way. The ends are where the corridor's trips turn back — the
 * places a rider picks between — while a place between two ends is the way itself passing
 * through, stated only as enrichment.
 */
export type StopServiceCorridorPlace = {
  label: string;
  /** Whether one of the corridor's trips ends here. Ends are always stated; the way between them only where the row has room. */
  isTerminus: boolean;
  /**
   * Where the place stands among the way's own places, most prominent first: how many other lines
   * offer a connection there, then how often the route calls. Only the way's own places carry a
   * rank — an end is never stood down, so it needs no rank.
   */
  rank?: number;
};

/**
 * How many calls to one place make it a place the way winds through rather than one it passes.
 *
 * One honest proxy among two: a municipality the line serves with several stops is a place a
 * rider changes trains in, while a hamlet passed once is not — unless it offers a connection of
 * its own.
 */
const PROMINENT_PLACE_CALL_COUNT = 2;

/**
 * How many places a corridor's way is stated by.
 *
 * A row is a sketch, not an itinerary: three places is what a rider reads at a glance, and a
 * fourth buys less than the width it costs. The ends are what the row is for and are all stated,
 * even where a corridor turns back at more places than this — the count governs how many of the
 * way's own places may stand beside them, which where the ends already fill the row is none.
 */
const CORRIDOR_PLACE_COUNT = 3;

/**
 * Where one line family was seen serving a place.
 *
 * The feed names a place, not a locality, and two places seventy kilometres apart may answer to
 * one name: `Friedrichstal` is Stutensee's on the S2 and Baiersbronn's, up the Murg valley, on the
 * S8. Held by name alone the two lend each other connections neither offers, and the Murg valley's
 * Friedrichstal reads as a better interchange than Gaggenau on the S8's own row. So a sighting
 * carries where it was seen, and a connection counts only where both lines were seen at the same
 * place on the ground.
 */
export type PlaceSighting = Pick<TripCall, "latitude" | "longitude">;

/** The line families each place has been seen served by, and where each was seen. */
export type PlaceLineFamilies = ReadonlyMap<string, ReadonlyMap<string, PlaceSighting>>;

/**
 * How far apart two sightings may be and still be the same place.
 *
 * Generous against a municipality's own spread — a line crosses Karlsruhe end to end well inside
 * it — and far short of the distance that separates places sharing a name.
 */
const SAME_PLACE_RADIUS_METERS = 15_000;

/**
 * Whether two sightings of one place name are the same place. A sighting the feed gave no position
 * for is not evidence of a second place, so it answers to the name as it always did.
 */
function isSamePlace(sighting: PlaceSighting, here: PlaceSighting): boolean {
  if (here.latitude === undefined || here.longitude === undefined) return true;
  if (sighting.latitude === undefined || sighting.longitude === undefined) return true;
  return getDistanceMeters(here.latitude, here.longitude, sighting) <= SAME_PLACE_RADIUS_METERS;
}

/** What the way reads each place's prominence from, beside the route itself. */
export type CorridorWayKnowledge = {
  /** The municipality the board is read from, whose places say nothing about the way out. */
  boardPlaceName: string | undefined;
  /** The line families each place has been seen served by, as the observed trips state them. */
  lineFamiliesByPlace: PlaceLineFamilies;
  /** The corridor line's own family, which is no connection to itself. */
  lineFamilyId: string;
};

/**
 * How a calling point names a direction: the place it is in.
 *
 * The feed answers a Karlsruhe district in the same field it answers a municipality in — `Durlach`,
 * `Rüppurr` and `Daxlanden` come back exactly as `Ettlingen` does, while the inner city says plain
 * `Karlsruhe`. So one rule covers both: a rider is told the place they are heading into, and only
 * where that is the place they are already standing in does the stop's own name have to do the
 * work.
 */
export function getCallDirectionLabel(call: TripCall, boardPlaceName: string | undefined): string {
  const placeName = call.placeName && getBaseName(call.placeName);
  return placeName && placeName !== boardPlaceName ? placeName : call.stopName;
}

/** The corridor's ends, in the order the way passes them: what a rider is picking between. */
export const getCorridorTermini = (
  places: readonly StopServiceCorridorPlace[],
): StopServiceCorridorPlace[] => places.filter(({ isTerminus }) => isTerminus);

/**
 * The way as a row states it once the least prominent of its own places have stood down.
 *
 * The ends are never stood down — they are what the row is for — so only the ranked places
 * between them answer to the count, and they leave in rank order: the place connecting to the
 * fewest other lines goes first.
 */
export function getShownCorridorPlaces(
  places: readonly StopServiceCorridorPlace[],
  standDownCount: number,
): StopServiceCorridorPlace[] {
  const wayPlaceCount = places.length - getCorridorTermini(places).length;
  const kept = Math.max(0, wayPlaceCount - standDownCount);
  return places.filter((place) => place.isTerminus || (place.rank ?? 0) < kept);
}

/** A place the way passes, at the point along the longest route where it passes it. */
type WayEvent = StopServiceCorridorPlace & { index: number };

/**
 * The distinct routes of the corridor, shortest first, where each is a prefix of the next.
 *
 * A short working and the through service it turns back along are one direction with two ends, and
 * a rider deciding between them is choosing how far, not which way. Two trips that genuinely part
 * are not a chain: nothing is returned for them, and the row falls back to the point they share.
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

/**
 * Where each route turns back, at the point the way passes it. An end is a fact about the route,
 * not about the row, so two ends in one place stand beside each other rather than collapsing away.
 */
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
 * The places between the ends worth naming, each ranked by how much it says about the way: a place
 * is prominent when other lines offer a connection there, or when the route itself calls
 * repeatedly. A hamlet passed once, served by nothing else, is neither.
 *
 * The place the rider is already standing in says nothing about the way out, so its calls are left
 * uncounted — the stop names of its termini carry that part.
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
    // A connection is another line seen at *this* place, not at another one answering to its name.
    const connections = [...(lineFamiliesByPlace.get(placeName) ?? [])].filter(
      ([familyId, sighting]) => familyId !== lineFamilyId && isSamePlace(sighting, here),
    ).length;
    if (connections < 1 && count < PROMINENT_PLACE_CALL_COUNT) continue;
    candidates.push({ label: placeName, index: firstIndex, occurrences: count, connections });
  }
  // Most prominent first — connections before occurrences — so the row stands the least useful
  // place down first when it lacks the room for the whole way.
  candidates.sort(
    (first, second) =>
      second.connections - first.connections || second.occurrences - first.occurrences,
  );
  return candidates.map(({ label, index }, rank) => ({ index, label, isTerminus: false, rank }));
}

/**
 * The places along the corridor's way, in the order the route visits them.
 *
 * Every end is named where the way passes it, even where the way returns to a place it has named
 * before. Between the ends, the prominent places stand in, so the chain sketches the way without
 * listing every stop.
 */
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
    // Ends in one place read as one place: only neighbours collapse, so an end the way returns
    // to after naming a further one is stated again.
    if (places.at(-1)?.label === label) continue;
    places.push(isTerminus ? { label, isTerminus } : { label, isTerminus, rank });
  }
  return takeMostRelevantPlaces(places);
}

/**
 * The way cut to the places a row states: every end, and beneath them the most relevant of the
 * way's own places — the ones other lines connect at, then the ones the route winds through — until
 * the count is filled.
 *
 * What is kept is re-ranked so the ranks stay a run from the most prominent place down, which is
 * what a row's stand-down walks when it lacks the room even for these.
 */
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
