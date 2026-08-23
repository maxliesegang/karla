import type { Departure, TripCall } from "../data/transit-types";
import { isExceptionalOperationNote } from "../data/operational-exceptions";
import { getLineFamilyId } from "./line-families";
import { getBaseName } from "./stop-naming";
import type { PlaceLineFamilies, PlaceSighting } from "./stop-corridor-way";
import { getCallKey, getCallSequenceKey, getCallsAfterStop } from "./trip-calls";

/**
 * What a stop has learned about where its trips go, and about the places its lines pass.
 *
 * The board a rider reads is fetched without calling sequences every thirty seconds; the sequences
 * come from other boards on far slower cadences. Resolving the two against each other from scratch
 * on every refresh made the grouping a function of whichever detailed boards happened to be in hand
 * at that instant — a trip that grouped a minute ago would stop resolving because an unrelated
 * observation post had refreshed, and its row would split off under its own headsign. What a stop's
 * trips do is not something that becomes unknown again, so it is remembered instead.
 */

/**
 * Whether the trip is running the route its line publishes, and so may teach or reuse a pattern.
 *
 * A diversion is a route nobody has observed and nobody should learn from: applied to the next
 * trip with the same headsign it would state a corridor the trip does not take, and learned from
 * it would outlive the diversion itself.
 */
function followsPublishedRoute(departure: Departure): boolean {
  return departure.status !== "diverted" && !isExceptionalOperationNote(departure.serviceNote);
}

/** What a trip is called where the same run is read off two boards, or off the same board twice. */
const getTripKey = (departure: Departure) => departure.tripId ?? departure.id;

const getLineDestinationKey = (departure: Departure) =>
  `${getLineFamilyId(departure.lineId)}|${departure.destination}`;

const getLineDirectionKey = (departure: Departure) =>
  departure.routeDirectionId
    ? `${getLineFamilyId(departure.lineId)}|${departure.routeDirectionId}`
    : undefined;

/** Keeps unlike operating exceptions from borrowing one another's temporary route. */
const getExceptionalLineDestinationKey = (departure: Departure) =>
  `${getLineDestinationKey(departure)}|${departure.serviceNote?.trim().toLocaleLowerCase("de") || departure.status}`;

/** One route out of this stop, and the distinct trips it has been read from. */
type StopCorridorRoute = {
  calls: readonly TripCall[];
  /** Trips, not readings: a board re-read every ninety seconds must not vote for its route again. */
  tripKeys: ReadonlySet<string>;
};

export type StopCorridorPatterns = {
  stopId: string;
  /** Published route past this stop of each trip that has been read in full, by the feed's trip id. */
  byTripKey: ReadonlyMap<string, readonly TripCall[]>;
  /**
   * The observed route of an exceptional trip. It may describe that run, but must never become the
   * line-and-headsign fallback: a temporary diversion is not the route a later trip promises.
   */
  exceptionalByTripKey: ReadonlyMap<string, readonly TripCall[]>;
  /** Every published route a line has been seen taking towards one headsign, by line and headsign. */
  byLineDestination: ReadonlyMap<string, ReadonlyMap<string, StopCorridorRoute>>;
  /** Observed first links by the feed's stable line-direction identity. */
  byLineDirection: ReadonlyMap<string, ReadonlyMap<string, StopCorridorRoute>>;
  /**
   * Exceptional routes indexed separately, so an unread diverted trip may reuse another diverted
   * trip's evidence without that temporary route ever describing normal service.
   */
  exceptionalByLineDestination: ReadonlyMap<string, ReadonlyMap<string, StopCorridorRoute>>;
  /**
   * The line families each place has been seen served by, by the feed's own place name, and where
   * each was seen — two places may answer to one name, so the position is what tells them apart.
   *
   * A corridor's row sketches the places its route winds through, and what makes one worth naming
   * is the connections it offers: which other lines a rider could change to there. The feed states
   * this only through trips, so it is observed the way the routes are — every reading that carries
   * calls names its line at every place it passes, wherever the trip was read from.
   */
  lineFamiliesByPlace: PlaceLineFamilies;
  /** The municipality the board is read from, which is learned once and holds for the visit. */
  boardPlaceName: string | undefined;
};

/**
 * How many trips' routes one stop remembers.
 *
 * A stop reached its lines' patterns within a few readings; what grows after that is the per-trip
 * index, one entry per run that has passed through. Bounded so a board left open all day cannot
 * accumulate without end — the oldest entries fall out first, and their line's pattern remains.
 */
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
 * Adds what the detailed boards in hand say about this stop's trips to what it already knew.
 *
 * Returns the previous memory unchanged where a refresh taught it nothing, so a re-read of the same
 * boards is not a state change — the caller sets state against that identity, so the guarantee has
 * to hold for *any* repeated input, including one naming the same trip twice. Another stop's memory
 * is never carried over: the routes are all stated relative to the stop they were read at.
 */
export function updateStopCorridorPatterns(
  previous: StopCorridorPatterns | null,
  stopId: string,
  topologyDepartures: readonly Departure[],
  capacity = STOP_CORRIDOR_PATTERN_CAPACITY,
): StopCorridorPatterns {
  const base = previous?.stopId === stopId ? previous : createStopCorridorPatterns(stopId);
  // Every index is drafted rather than rebuilt: only the entries a reading actually changes are
  // copied, and an index nothing touched is committed as the very map it started from. Most
  // detailed refreshes overlap the previous one heavily; eagerly cloning every remembered line and
  // route made that no-op case the most expensive path even though this function deliberately
  // returns `base` for it.
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

  // One trip is read by several boards at once — its own detailed board and whichever observation
  // posts happen to see it — and those readings need not agree about the calls after this stop.
  // Whoever wrote last used to win, which made this function disagree with itself: two readings of
  // one trip overwrote each other on every pass, so a re-read that had taught nothing still returned
  // a new memory and `useStopCorridorPatterns` never reached the fixed point it sets state against.
  // The first reading of a trip in a pass is the one kept, and `topologyDepartures` puts the stop's
  // own detailed board in front of the observation posts — which is the reading that should win.
  const readTripKeys = new Set<string>();

  for (const departure of topologyDepartures) {
    // Every reading that carries calls states which lines serve which places, wherever the trip
    // was read from: a trip seen from another post still runs its route. The learning is
    // idempotent — a family a place has is not learned again — so a repeated reading stays the
    // no-op the fixed point above requires.
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
      // Kept in the exceptional indexes: this route may cover an unread trip under the same
      // operating exception, but it can never teach the published-route fallback.
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

    // A headsign that lies beyond the detailed board's bounded window can still be related to an
    // observed direction. Only the first outgoing link is learned here: the direction identity is
    // evidence that trips leave this way, not evidence for their unobserved route further ahead.
    const lineDirectionKey = getLineDirectionKey(departure);
    const firstCall = calls[0];
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

/**
 * One trip's route, remembered per trip.
 *
 * Bounded, because this is the index that grows: a stop learns its lines' patterns in a few
 * readings, but every run that passes through adds a trip of its own. Insertion order is age order,
 * so trimming from the front drops the runs that passed longest ago.
 */
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

/**
 * The routes seen under one line key, each with the trips that took it — the shape every pattern
 * fallback is read from. Unbounded on purpose: a line takes a handful of routes past a stop, and
 * which of them predominates is exactly what a fallback needs the whole history for.
 */
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

/**
 * The line families one place has been seen served by.
 *
 * Unbounded on purpose, and small in kind: an entry is a place — a municipality, not a stop — and
 * its set grows only while genuinely new lines are seen there. The whole observed network is the
 * honest answer to what a rider could change to.
 */
function createPlaceLineFamiliesDraft(base: PlaceLineFamilies) {
  let changed: Map<string, ReadonlyMap<string, PlaceSighting>> | undefined;
  return {
    get hasChanges() {
      return changed !== undefined;
    },
    // The first sighting of a family at a place is the one kept, so a family a place already has
    // is never learned again and a repeated reading stays the no-op the fixed point requires.
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
 * The route this departure takes out of the stop, from the trip itself where it has been read, and
 * otherwise from the route its line runs towards that headsign.
 *
 * The line-and-headsign fallback is what covers the trips further down the board than any detailed
 * reading reached. It needs a clear winner rather than a single answer: one oddly reported run out
 * of a dozen readings used to withdraw the pattern from every trip on the line, whereas two routes
 * observed equally often really are two branches, and neither may speak for the other.
 */
export type StopCorridorPatternMatch = {
  calls: readonly TripCall[];
  /** False when only the outgoing link, not the trip's complete remaining route, was observed. */
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

/** The sole or most-observed route, with a tie deliberately answering nothing. */
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
 * The municipality this board is being read from, whose stops need no qualifier.
 *
 * Without it every calling point in the city answers to the same place, and a direction read at a
 * Karlsruhe stop says "Richtung Karlsruhe" — true, and no use to anyone standing in it.
 */
function findBoardPlaceName(departures: readonly Departure[], stopId: string): string | undefined {
  for (const departure of departures) {
    const call = (departure.tripCalls ?? []).find(
      (candidate) =>
        candidate.localStopId === stopId ||
        (departure.boardingStopId === stopId && candidate.isCurrentStop),
    );
    if (call?.placeName) return getBaseName(call.placeName);
  }
  return undefined;
}
