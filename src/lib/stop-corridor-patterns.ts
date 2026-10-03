import type { Departure, TripCall } from "../data/transit-types";
import { isExceptionalOperationNote } from "../data/operational-exceptions";
import { getLineFamilyId } from "./line-families";
import { getBaseName } from "./stop-naming";
import type { PlaceLineFamilies, PlaceSighting } from "./stop-corridor-way";
import {
  findFirstCallBeyondStop,
  findStopCallIndex,
  getCallKey,
  getCallSequenceKey,
  getCallsAfterStop,
} from "./trip-calls";

/**
 * What a stop has learned about where its trips go and which lines pass its places. Remembered
 * rather than re-derived, since the sequences arrive from other boards on slower cadences and a
 * trip's route does not become unknown again.
 */

/** Whether the trip runs its published route; a diversion must not teach or reuse a pattern. */
function followsPublishedRoute(departure: Departure): boolean {
  return departure.status !== "diverted" && !isExceptionalOperationNote(departure.serviceNote);
}

/** One key per trip, however many boards read it. */
const getTripKey = (departure: Departure) => departure.tripId ?? departure.id;

const getLineDestinationKey = (departure: Departure) =>
  `${getLineFamilyId(departure.lineId)}|${departure.destination}`;

const getLineDirectionKey = (departure: Departure) =>
  departure.routeDirectionId
    ? `${getLineFamilyId(departure.lineId)}|${departure.routeDirectionId}`
    : undefined;

/** Keeps different operating exceptions from borrowing each other's temporary route. */
const getExceptionalLineDestinationKey = (departure: Departure) =>
  `${getLineDestinationKey(departure)}|${departure.serviceNote?.trim().toLocaleLowerCase("de") || departure.status}`;

/** One route out of this stop, and the distinct trips it has been read from. */
type StopCorridorRoute = {
  calls: readonly TripCall[];
  /** Trips, not readings, so a re-read board does not vote again. */
  tripKeys: ReadonlySet<string>;
};

export type StopCorridorPatterns = {
  stopId: string;
  /** Each fully read trip's route past this stop, by trip id. */
  byTripKey: ReadonlyMap<string, readonly TripCall[]>;
  /** Exceptional trips' routes; never the line-and-headsign fallback. */
  exceptionalByTripKey: ReadonlyMap<string, readonly TripCall[]>;
  /** Every published route seen per line and headsign. */
  byLineDestination: ReadonlyMap<string, ReadonlyMap<string, StopCorridorRoute>>;
  /** Observed first links by the feed's stable line-direction identity. */
  byLineDirection: ReadonlyMap<string, ReadonlyMap<string, StopCorridorRoute>>;
  /** Exceptional routes, indexed apart so a diversion never describes normal service. */
  exceptionalByLineDestination: ReadonlyMap<string, ReadonlyMap<string, StopCorridorRoute>>;
  /**
   * The line families seen serving each place, by place name, with where each was seen (one name
   * can mean two places). Used to name the places a corridor passes by their connections.
   */
  lineFamiliesByPlace: PlaceLineFamilies;
  /** The board's municipality, learned once per visit. */
  boardPlaceName: string | undefined;
};

/** Trips remembered per stop; the per-trip index grows with every run, so the oldest fall out. */
const STOP_CORRIDOR_PATTERN_CAPACITY = 512;

export function createStopCorridorPatterns(stopId: string): StopCorridorPatterns {
  return {
    stopId,
    byTripKey: new Map(),
    exceptionalByTripKey: new Map(),
    byLineDestination: new Map(),
    byLineDirection: new Map(),
    exceptionalByLineDestination: new Map(),
    lineFamiliesByPlace: new Map(),
    boardPlaceName: undefined,
  };
}

/**
 * Adds what the detailed boards say about this stop's trips. Returns `base` itself when nothing was
 * learned, for any repeated input, since callers set state on that identity.
 */
export function updateStopCorridorPatterns(
  previous: StopCorridorPatterns | null,
  stopId: string,
  topologyDepartures: readonly Departure[],
  capacity = STOP_CORRIDOR_PATTERN_CAPACITY,
): StopCorridorPatterns {
  const base = previous?.stopId === stopId ? previous : createStopCorridorPatterns(stopId);
  // Indexes are drafted, copying only changed entries, so the common no-op refresh is cheap.
  const trips = createTripRouteDraft(base.byTripKey, capacity);
  const exceptionalTrips = createTripRouteDraft(base.exceptionalByTripKey, capacity);
  const lineDestinations = createLineRouteDraft(base.byLineDestination);
  const lineDirections = createLineRouteDraft(base.byLineDirection);
  const exceptionalLineDestinations = createLineRouteDraft(base.exceptionalByLineDestination);
  const placeLineFamilies = createPlaceLineFamiliesDraft(base.lineFamiliesByPlace);
  const drafts = [
    trips,
    exceptionalTrips,
    lineDestinations,
    lineDirections,
    exceptionalLineDestinations,
    placeLineFamilies,
  ];

  // The first reading of a trip in a pass wins, so disagreeing readings cannot flip-flop and the
  // state reaches a fixed point. `topologyDepartures` puts the stop's own board first.
  const readTripKeys = new Set<string>();

  for (const departure of topologyDepartures) {
    // Any reading with calls teaches which lines serve which places; idempotent, for the fixed
    // point.
    const lineFamilyId = getLineFamilyId(departure.lineId);
    for (const call of departure.tripCalls ?? []) {
      const placeName = call.placeName && getBaseName(call.placeName);
      if (placeName) placeLineFamilies.learn(placeName, lineFamilyId, call);
    }

    const calls = getCallsAfterStop(departure, stopId);
    if (calls.length === 0) continue;

    const tripKey = getTripKey(departure);
    if (readTripKeys.has(tripKey)) continue;
    readTripKeys.add(tripKey);

    const sequenceKey = getCallSequenceKey(calls);
    if (!followsPublishedRoute(departure)) {
      // Exceptional routes may cover an unread trip with the same exception, never the fallback.
      exceptionalTrips.learn(tripKey, sequenceKey, calls);
      exceptionalLineDestinations.learn(
        getExceptionalLineDestinationKey(departure),
        sequenceKey,
        calls,
        tripKey,
      );
      continue;
    }

    trips.learn(tripKey, sequenceKey, calls);
    lineDestinations.learn(getLineDestinationKey(departure), sequenceKey, calls, tripKey);

    // Headsigns beyond the detailed board's window still relate to a direction, by first link only.
    const lineDirectionKey = getLineDirectionKey(departure);
    const firstCall = findFirstCallBeyondStop(calls, stopId);
    if (lineDirectionKey && firstCall) {
      lineDirections.learn(lineDirectionKey, getCallKey(firstCall), [firstCall], tripKey);
    }
  }

  const boardPlaceName = base.boardPlaceName ?? findBoardPlaceName(topologyDepartures, stopId);
  if (drafts.every((draft) => !draft.hasChanges) && boardPlaceName === base.boardPlaceName)
    return base;

  return {
    stopId,
    byTripKey: trips.commit(),
    exceptionalByTripKey: exceptionalTrips.commit(),
    byLineDestination: lineDestinations.commit(),
    byLineDirection: lineDirections.commit(),
    exceptionalByLineDestination: exceptionalLineDestinations.commit(),
    lineFamiliesByPlace: placeLineFamilies.commit(),
    boardPlaceName,
  };
}

/** Per-trip routes, bounded; insertion order is age order, so trimming drops the oldest. */
function createTripRouteDraft(base: ReadonlyMap<string, readonly TripCall[]>, capacity: number) {
  let changed: Map<string, readonly TripCall[]> | undefined;
  return {
    get hasChanges() {
      return changed !== undefined;
    },
    learn(tripKey: string, sequenceKey: string, calls: readonly TripCall[]) {
      const known = (changed ?? base).get(tripKey);
      if (known && getCallSequenceKey(known) === sequenceKey) return;
      changed ??= new Map(base);
      changed.set(tripKey, calls);
    },
    commit(): ReadonlyMap<string, readonly TripCall[]> {
      if (!changed) return base;
      return changed.size > capacity
        ? new Map([...changed].slice(changed.size - capacity))
        : changed;
    },
  };
}

/** Routes per line key with their trips; unbounded, since a line takes a handful of routes. */
function createLineRouteDraft(base: ReadonlyMap<string, ReadonlyMap<string, StopCorridorRoute>>) {
  let changed: Map<string, Map<string, StopCorridorRoute>> | undefined;
  return {
    get hasChanges() {
      return changed !== undefined;
    },
    learn(lineKey: string, routeKey: string, calls: readonly TripCall[], tripKey: string) {
      const route = (changed?.get(lineKey) ?? base.get(lineKey))?.get(routeKey);
      if (route?.tripKeys.has(tripKey)) return;
      changed ??= new Map();
      let routes = changed.get(lineKey);
      if (!routes) {
        routes = new Map(base.get(lineKey));
        changed.set(lineKey, routes);
      }
      routes.set(routeKey, { calls, tripKeys: new Set([...(route?.tripKeys ?? []), tripKey]) });
    },
    commit(): ReadonlyMap<string, ReadonlyMap<string, StopCorridorRoute>> {
      return changed ? new Map([...base, ...changed]) : base;
    },
  };
}

/** The line families each place is served by; unbounded but small (places, not stops). */
function createPlaceLineFamiliesDraft(base: PlaceLineFamilies) {
  let changed: Map<string, ReadonlyMap<string, PlaceSighting>> | undefined;
  return {
    get hasChanges() {
      return changed !== undefined;
    },
    // The first sighting is kept, so repeats stay a no-op.
    learn(placeName: string, lineFamilyId: string, { latitude, longitude }: PlaceSighting) {
      const known = (changed ?? base).get(placeName);
      if (known?.has(lineFamilyId)) return;
      changed ??= new Map(base);
      changed.set(placeName, new Map([...(known ?? []), [lineFamilyId, { latitude, longitude }]]));
    },
    commit(): PlaceLineFamilies {
      return changed ?? base;
    },
  };
}

/**
 * The route a departure takes out of the stop: its own where read, else its line's route towards
 * that headsign. The fallback needs a clear winner; a tie means two branches and answers nothing.
 */
export type StopCorridorPatternMatch = {
  calls: readonly TripCall[];
  /** False when only the outgoing link was observed. */
  hasFullRoute: boolean;
};

export function findStopCorridorPattern(
  patterns: StopCorridorPatterns,
  departure: Departure,
): StopCorridorPatternMatch | undefined {
  if (!followsPublishedRoute(departure)) {
    const calls =
      patterns.exceptionalByTripKey.get(getTripKey(departure)) ??
      findPredominantRoute(
        patterns.exceptionalByLineDestination.get(getExceptionalLineDestinationKey(departure)),
      );
    return calls ? { calls, hasFullRoute: true } : undefined;
  }

  const observed = patterns.byTripKey.get(getTripKey(departure));
  if (observed) return { calls: observed, hasFullRoute: true };

  const destinationRoute = findPredominantRoute(
    patterns.byLineDestination.get(getLineDestinationKey(departure)),
  );
  if (destinationRoute) return { calls: destinationRoute, hasFullRoute: true };

  const lineDirectionKey = getLineDirectionKey(departure);
  const outgoingLink = lineDirectionKey
    ? findPredominantRoute(patterns.byLineDirection.get(lineDirectionKey))
    : undefined;
  return outgoingLink ? { calls: outgoingLink, hasFullRoute: false } : undefined;
}

/** The sole or most-observed route; a tie answers nothing. */
function findPredominantRoute(
  routesBySequence: ReadonlyMap<string, StopCorridorRoute> | undefined,
): readonly TripCall[] | undefined {
  const routes = [...(routesBySequence?.values() ?? [])].sort(
    (first, second) => second.tripKeys.size - first.tripKeys.size,
  );
  if (routes.length === 0) return undefined;
  return routes.length === 1 || routes[0].tripKeys.size > routes[1].tripKeys.size
    ? routes[0].calls
    : undefined;
}

/**
 * The board's municipality, whose stops need no qualifier ("Richtung Karlsruhe" helps nobody
 * there).
 */
function findBoardPlaceName(departures: readonly Departure[], stopId: string): string | undefined {
  for (const departure of departures) {
    const placeName = departure.tripCalls?.[findStopCallIndex(departure, stopId)]?.placeName;
    if (placeName) return getBaseName(placeName);
  }
  return undefined;
}
