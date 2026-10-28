import type { StopEvent, Call } from "../data/transit-types";
import { isExceptionalOperationNote } from "../data/operational-exceptions";
import { getBaseName } from "./stop-naming";
import type { PlaceLineFamilies, PlaceSighting } from "./stop-corridor-way";
import {
  findFirstCallBeyondStop,
  findStopCallIndex,
  getCallKey,
  getCallSequenceKey,
  getCallsAfterStop,
} from "./calls";

/**
 * What a stop has learned about where its journeys go and which lines pass its places. Remembered
 * rather than re-derived, since the sequences arrive from other boards on slower cadences and a
 * journey's route does not become unknown again.
 */

/** Whether the journey runs its published route; a diversion must not teach or reuse a pattern. */
function followsPublishedRoute(stopEvent: StopEvent): boolean {
  return stopEvent.status !== "diverted" && !isExceptionalOperationNote(stopEvent.serviceNote);
}

/** One key per journey, however many boards read it. */
const getJourneyKey = (stopEvent: StopEvent) => stopEvent.journeyRef ?? stopEvent.id;

const getLineDestinationKey = (stopEvent: StopEvent) =>
  `${stopEvent.lineId}|${stopEvent.destinationText}`;

const getLineDirectionKey = (stopEvent: StopEvent) => `${stopEvent.lineId}|${stopEvent.lineRef}`;

/** Keeps different operating exceptions from borrowing each other's temporary route. */
const getExceptionalLineDestinationKey = (stopEvent: StopEvent) =>
  `${getLineDestinationKey(stopEvent)}|${stopEvent.serviceNote?.trim().toLocaleLowerCase("de") || stopEvent.status}`;

/** One route out of this stop, and the distinct journeys it has been read from. */
type StopCorridorRoute = {
  calls: readonly Call[];
  /** Journeys, not readings, so a re-read board does not vote again. */
  journeyKeys: ReadonlySet<string>;
};

export type StopCorridorPatterns = {
  stopId: string;
  /** Each fully read journey's route past this stop, by journey id. */
  byJourneyKey: ReadonlyMap<string, readonly Call[]>;
  /** Exceptional journeys' routes; never the line-and-headsign fallback. */
  exceptionalByJourneyKey: ReadonlyMap<string, readonly Call[]>;
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

/**
 * Journeys remembered per stop; the per-journey index grows with every dated journey, so the oldest
 * fall out.
 */
const STOP_CORRIDOR_PATTERN_CAPACITY = 512;

export function createStopCorridorPatterns(stopId: string): StopCorridorPatterns {
  return {
    stopId,
    byJourneyKey: new Map(),
    exceptionalByJourneyKey: new Map(),
    byLineDestination: new Map(),
    byLineDirection: new Map(),
    exceptionalByLineDestination: new Map(),
    lineFamiliesByPlace: new Map(),
    boardPlaceName: undefined,
  };
}

/**
 * Adds what the detailed boards say about this stop's journeys. Returns `base` itself when nothing
 * was learned, for any repeated input, since callers set state on that identity.
 */
export function updateStopCorridorPatterns(
  previous: StopCorridorPatterns | null,
  stopId: string,
  topologyStopEvents: readonly StopEvent[],
  capacity = STOP_CORRIDOR_PATTERN_CAPACITY,
): StopCorridorPatterns {
  const base = previous?.stopId === stopId ? previous : createStopCorridorPatterns(stopId);
  // Indexes are drafted, copying only changed entries, so the common no-op refresh is cheap.
  const journeys = createJourneyRouteDraft(base.byJourneyKey, capacity);
  const exceptionalJourneys = createJourneyRouteDraft(base.exceptionalByJourneyKey, capacity);
  const lineDestinations = createLineRouteDraft(base.byLineDestination);
  const lineDirections = createLineRouteDraft(base.byLineDirection);
  const exceptionalLineDestinations = createLineRouteDraft(base.exceptionalByLineDestination);
  const placeLineFamilies = createPlaceLineFamiliesDraft(base.lineFamiliesByPlace);
  const drafts = [
    journeys,
    exceptionalJourneys,
    lineDestinations,
    lineDirections,
    exceptionalLineDestinations,
    placeLineFamilies,
  ];

  // The first reading of a journey in a pass wins, so disagreeing readings cannot flip-flop and the
  // state reaches a fixed point. `topologyStopEvents` puts the stop's own board first.
  const readJourneyKeys = new Set<string>();

  for (const stopEvent of topologyStopEvents) {
    // Any reading with calls teaches which lines serve which places; idempotent, for the fixed
    // point.
    const lineFamilyId = stopEvent.lineId;
    for (const call of stopEvent.calls ?? []) {
      const placeName = call.placeName && getBaseName(call.placeName);
      if (placeName) placeLineFamilies.learn(placeName, lineFamilyId, call);
    }

    const calls = getCallsAfterStop(stopEvent, stopId);
    if (calls.length === 0) continue;

    const journeyKey = getJourneyKey(stopEvent);
    if (readJourneyKeys.has(journeyKey)) continue;
    readJourneyKeys.add(journeyKey);

    const sequenceKey = getCallSequenceKey(calls);
    if (!followsPublishedRoute(stopEvent)) {
      // Exceptional routes may cover an unread journey with the same exception, never the fallback.
      exceptionalJourneys.learn(journeyKey, sequenceKey, calls);
      exceptionalLineDestinations.learn(
        getExceptionalLineDestinationKey(stopEvent),
        sequenceKey,
        calls,
        journeyKey,
      );
      continue;
    }

    journeys.learn(journeyKey, sequenceKey, calls);
    lineDestinations.learn(getLineDestinationKey(stopEvent), sequenceKey, calls, journeyKey);

    // Headsigns beyond the detailed board's window still relate to a direction, by first link only.
    const lineDirectionKey = getLineDirectionKey(stopEvent);
    const firstCall = findFirstCallBeyondStop(calls, stopId);
    if (lineDirectionKey && firstCall) {
      lineDirections.learn(lineDirectionKey, getCallKey(firstCall), [firstCall], journeyKey);
    }
  }

  const boardPlaceName = base.boardPlaceName ?? findBoardPlaceName(topologyStopEvents, stopId);
  if (drafts.every((draft) => !draft.hasChanges) && boardPlaceName === base.boardPlaceName)
    return base;

  return {
    stopId,
    byJourneyKey: journeys.commit(),
    exceptionalByJourneyKey: exceptionalJourneys.commit(),
    byLineDestination: lineDestinations.commit(),
    byLineDirection: lineDirections.commit(),
    exceptionalByLineDestination: exceptionalLineDestinations.commit(),
    lineFamiliesByPlace: placeLineFamilies.commit(),
    boardPlaceName,
  };
}

/** Per-journey routes, bounded; insertion order is age order, so trimming drops the oldest. */
function createJourneyRouteDraft(base: ReadonlyMap<string, readonly Call[]>, capacity: number) {
  let changed: Map<string, readonly Call[]> | undefined;
  return {
    get hasChanges() {
      return changed !== undefined;
    },
    learn(journeyKey: string, sequenceKey: string, calls: readonly Call[]) {
      const known = (changed ?? base).get(journeyKey);
      if (known && getCallSequenceKey(known) === sequenceKey) return;
      changed ??= new Map(base);
      changed.set(journeyKey, calls);
    },
    commit(): ReadonlyMap<string, readonly Call[]> {
      if (!changed) return base;
      return changed.size > capacity
        ? new Map([...changed].slice(changed.size - capacity))
        : changed;
    },
  };
}

/** Routes per line key with their journeys; unbounded, since a line takes a handful of routes. */
function createLineRouteDraft(base: ReadonlyMap<string, ReadonlyMap<string, StopCorridorRoute>>) {
  let changed: Map<string, Map<string, StopCorridorRoute>> | undefined;
  return {
    get hasChanges() {
      return changed !== undefined;
    },
    learn(lineKey: string, routeKey: string, calls: readonly Call[], journeyKey: string) {
      const route = (changed?.get(lineKey) ?? base.get(lineKey))?.get(routeKey);
      if (route?.journeyKeys.has(journeyKey)) return;
      changed ??= new Map();
      let routes = changed.get(lineKey);
      if (!routes) {
        routes = new Map(base.get(lineKey));
        changed.set(lineKey, routes);
      }
      routes.set(routeKey, {
        calls,
        journeyKeys: new Set([...(route?.journeyKeys ?? []), journeyKey]),
      });
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
  calls: readonly Call[];
  /** False when only the outgoing link was observed. */
  hasFullRoute: boolean;
};

export function findStopCorridorPattern(
  patterns: StopCorridorPatterns,
  stopEvent: StopEvent,
): StopCorridorPatternMatch | undefined {
  if (!followsPublishedRoute(stopEvent)) {
    const calls =
      patterns.exceptionalByJourneyKey.get(getJourneyKey(stopEvent)) ??
      findPredominantRoute(
        patterns.exceptionalByLineDestination.get(getExceptionalLineDestinationKey(stopEvent)),
      );
    return calls ? { calls, hasFullRoute: true } : undefined;
  }

  const observed = patterns.byJourneyKey.get(getJourneyKey(stopEvent));
  if (observed) return { calls: observed, hasFullRoute: true };

  const destinationRoute = findPredominantRoute(
    patterns.byLineDestination.get(getLineDestinationKey(stopEvent)),
  );
  if (destinationRoute) return { calls: destinationRoute, hasFullRoute: true };

  const lineDirectionKey = getLineDirectionKey(stopEvent);
  const outgoingLink = lineDirectionKey
    ? findPredominantRoute(patterns.byLineDirection.get(lineDirectionKey))
    : undefined;
  return outgoingLink ? { calls: outgoingLink, hasFullRoute: false } : undefined;
}

/** The sole or most-observed route; a tie answers nothing. */
function findPredominantRoute(
  routesBySequence: ReadonlyMap<string, StopCorridorRoute> | undefined,
): readonly Call[] | undefined {
  const routes = [...(routesBySequence?.values() ?? [])].sort(
    (first, second) => second.journeyKeys.size - first.journeyKeys.size,
  );
  if (routes.length === 0) return undefined;
  return routes.length === 1 || routes[0].journeyKeys.size > routes[1].journeyKeys.size
    ? routes[0].calls
    : undefined;
}

/**
 * The board's municipality, whose stops need no qualifier ("Richtung Karlsruhe" helps nobody
 * there).
 */
function findBoardPlaceName(stopEvents: readonly StopEvent[], stopId: string): string | undefined {
  for (const stopEvent of stopEvents) {
    const placeName = stopEvent.calls?.[findStopCallIndex(stopEvent, stopId)]?.placeName;
    if (placeName) return getBaseName(placeName);
  }
  return undefined;
}
