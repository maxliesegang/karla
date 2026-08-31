import { useEffect, useMemo, useState } from "react";
import {
  LINE_OBSERVATION_REFRESH_MS,
  useDepartureBoard,
  useDepartureBoardOrder,
  useDepartureBoards,
  useLineStopBoard,
  useRetainedTrip,
  useTransitStop,
  useTripDepartures,
} from "./hooks";
import {
  extendLineCallStopIds,
  getLineCallStopIds,
  getLineDirectionIds,
  getLineObservationStopIds,
} from "./lib/observed-network";
import { mergeTripSequence } from "./lib/trip-calls";
import { findBestTripReading } from "./lib/trips";
import { getLineSign } from "./data/line-signs";
import { findLineForRoute, isSameLineFamily } from "./lib/line-families";
import {
  createLineSelection,
  getLineSelectionIds,
  isSelectedLine,
  type LineSelection,
} from "./lib/line-bundles";
import type {
  Departure,
  DepartureBoard,
  TransitLine,
  TransitNetwork,
  TransitStop,
  TripReading,
} from "./data/transit-types";
import {
  DEFAULT_STOP_ID,
  findDepartureByRouteId,
  getDepartureRouteId,
  getSelectionPath,
  replaceCurrentRoute,
  stationBoardConfig,
  type AppRoute,
} from "./routing";

const EMPTY_DEPARTURES: readonly Departure[] = [];
const EMPTY_LINES: readonly TransitLine[] = [];
const EMPTY_STOP_IDS: readonly string[] = [];
/**
 * How many of a line's departures at this stop are loaded as whole trips. Enough to mark the
 * vehicles a rider can still reach; past that a board lists trips nobody in front of it is waiting
 * for, and each one is a request of its own.
 */
const LINE_TRIP_LOAD_LIMIT = 6;

/**
 * Whether the visible board is asked for the trips behind its departures, or only for what leaves.
 *
 * The board a rider reads stays light whatever the address names: a selected line's trips are read
 * one at a time from the single-trip endpoint, and the observation boards behind the network are
 * bounded and shared. Only an unattended board whose own rows print `via` needs complete sequences
 * in the board response itself — no address a rider navigates to does.
 */
const NEEDS_BOARD_TRIP_CALLS = stationBoardConfig?.detail === "via";

/**
 * What the address actually resolved to.
 *
 * The selection is a chain — a stop, a line calling at it, one trip of that line — and each level
 * is resolved against live data on its own. A level that no longer resolves is dropped back to the
 * one above it rather than invalidating the whole address, so a departed trip leaves the line in
 * view and a suspended line leaves the stop's board in view. Only a stop can be a dead end, because
 * it is the one level with nothing beneath it.
 */
export type ResolvedSelectionChain = {
  /** The stop actually being shown, which a line-only address resolves for itself. */
  stopId: string;
  selectedStop: TransitStop | undefined;
  isStopLoading: boolean;
  /**
   * The stop's provider read failed rather than answered. A stop that was not found is a dead end;
   * a stop that could not be read is not, and says so instead.
   */
  isStopFailed: boolean;
  /** Reads the stop's provider resolution again after a failed one. */
  retryStop: () => void;
  departureBoard: DepartureBoard | null;
  departures: readonly Departure[];
  selectedLine: TransitLine | undefined;
  /**
   * The sibling lines being read together with it, as they resolved. A bundle is a level of the
   * chain like any other: a sibling the stop's board no longer lists leaves the reading by itself,
   * and the line the rider addressed stays where it was.
   */
  bundledLines: readonly TransitLine[];
  /** The lines in view as one value, which is what every filter and highlight below is asked with. */
  lineSelection: LineSelection;
  selectedDeparture: Departure | undefined;
  /**
   * Where the rider was last heading on this line. A trip states its own direction; once it has
   * departed this keeps the diagram pointing the same way instead of turning around.
   */
  preferredDestination: string | undefined;
  /** This stop's board plus the line-filtered boards discovered along the whole line. */
  lineDepartureBoards: readonly DepartureBoard[];
  /** Whole-trip readings for the selected line at this stop, used for route-aware presentation. */
  lineTripDepartures: readonly Departure[];
  /**
   * The ride: the trip read on its own, without the departure board beside it. It is the trip's
   * mode, so it lasts exactly as long as the trip — once the boards have been read and the trip is
   * not among them, the line comes back into view beside its board.
   */
  isRide: boolean;
  /**
   * The trip in view is the last observation of it rather than a current reading, because the
   * boards have stopped listing it. The ride is not over; it is simply no longer a departure.
   */
  isSelectedDepartureRetained: boolean;
  /** When that observation was taken, which is what the ride status states instead of claiming live. */
  selectedDepartureObservedAt: number;
  /** The stop the rider marked to get off at, once the trip in hand confirms it calls there. */
  alightingStopId: string | undefined;
  /**
   * The stop the ride was begun at, as the address states it. Never inferred and never dropped: it
   * is not a claim about the trip that could stop resolving, it is the place the rider came from,
   * and it is what step up leads back to.
   */
  originStopId: string | undefined;
  /**
   * A link naming a trip alone cannot say which line it belongs to until its board arrives; showing
   * the bare stop first would flip to the line view a moment later.
   */
  isAwaitingLegacyTrip: boolean;
};

export function useSelectionChain(
  route: AppRoute,
  network: TransitNetwork | null,
  observationBoards: readonly DepartureBoard[] = [],
): ResolvedSelectionChain {
  const observedLine = network ? findLineForRoute(network.lines, route.lineId) : undefined;
  const stopId = route.stopId || observedLine?.zentrumStopIds[0] || DEFAULT_STOP_ID;
  // A failed provider read is retried by bumping the nonce: the load re-runs for the same key, so
  // whatever the last attempt settled on stays visible until the new one answers.
  const [stopReloadNonce, setStopReloadNonce] = useState(0);
  const {
    stop: selectedStop,
    loading: isStopLoading,
    failed: isStopFailed,
  } = useTransitStop(network, route.view === "stop" ? stopId : undefined, {
    reloadNonce: stopReloadNonce,
  });

  // Wait for the stable network to resolve the stop before touching the live provider: a deep link
  // to an unknown stop should render locally instead of causing a pointless board request.
  // Only the line order pays for the per-direction completion. It is the reading where a direction
  // the plain board never reached is not a shorter list but a line missing from the answer to "what
  // runs from here?", and it is chosen deliberately — the other two orders keep the light board.
  const departureBoardOrder = useDepartureBoardOrder();
  const departureBoard = useDepartureBoard(
    selectedStop ? stopId : undefined,
    NEEDS_BOARD_TRIP_CALLS ? "calls" : departureBoardOrder === "line" ? "covered" : "plain",
  );
  const departures = departureBoard?.departures ?? EMPTY_DEPARTURES;
  // A trip named beside a stop is that stop's own entry: its countdown, platform and calling point
  // are the ones the board states, so another board's copy of the same trip is not interchangeable.
  const stopDeparture = findDepartureByRouteId(departures, route.tripId);

  const selectedLine = findSelectedLine(
    route,
    network,
    departures,
    departureBoard,
    observedLine,
    stopDeparture,
  );
  // Both directions have to be named or a filtered board answers with only one. The rider's own stop
  // states whichever directions call there — one of them, at the end of a line — so the core
  // observation's departures are read for the other. Naming none reads the whole stop, which is the
  // right answer until a departure of this line has been seen.
  // Keyed by the line's id, never by the sign object: a line the live network has not seen gets a
  // freshly built neutral sign on every render, and hanging memories off that identity would rebuild
  // the trips behind the diagram — and the observations read from them — on every render.
  const selectedLineId = selectedLine?.id;
  // The siblings the address asks for, kept only while this stop's own board still lists them.
  // Nothing else may add one: a bundle is the rider's choice, and inferring it from a shared
  // corridor would pin a level they never chose.
  const bundledLines = useBundledLines(route.bundledLineIds, selectedLine, network, departures);
  const lineSelection = useMemo(
    () =>
      createLineSelection(
        selectedLineId ?? "",
        bundledLines.map(({ id }) => id),
      ),
    [bundledLines, selectedLineId],
  );
  const lineDirectionIds = useMemo(() => {
    const boardDepartures = [
      ...departures,
      ...observationBoards.flatMap((board) => board.departures),
    ];
    // Each line is asked for its own two directions and the answers pooled: one filtered board
    // then carries the whole corridor, so reading two lines together still costs one request.
    return toDistinct(
      getLineSelectionIds(lineSelection).flatMap((lineId) =>
        getLineDirectionIds(lineId, boardDepartures),
      ),
    );
  }, [observationBoards, departures, lineSelection]);
  // The board the rider reads is the whole stop and reaches minutes; this one is the same stop asked
  // for this line alone and reaches most of an hour. The line's own vehicles are found in it.
  const lineStopBoard = useLineStopBoard(selectedLineId ? stopId : undefined, lineDirectionIds);
  const lineDeparturesAtStop = useLineDeparturesAtStop(
    lineSelection,
    lineStopBoard,
    departures,
    stopDeparture,
  );
  const currentLineTrips = useTripDepartures(lineDeparturesAtStop, stopDeparture?.id);
  const lineDepartureBoards = useLineDepartureBoards(
    lineSelection,
    selectedLine,
    stopId,
    lineStopBoard ?? departureBoard,
    currentLineTrips,
    observationBoards,
    lineDirectionIds,
  );
  // A trip addressed on its own names no stop, so the board it was read from is not known in
  // advance: it is looked for across the line's boards, keeping the freshest copy that saw the trip.
  const observedBoards = useMemo(
    () => [...observationBoards, ...lineDepartureBoards],
    [lineDepartureBoards, observationBoards],
  );
  const observedTripReading = findTripInDepartureBoards(observedBoards, route.tripId);
  // The stop row owns countdown, platform and destination; the single-trip reading contributes the
  // complete sequence. This keeps one published departure fact while still preferring fuller calls.
  const observedTrip = observedTripReading?.trip;
  const observedDeparture = useMemo(
    () => (stopDeparture ? mergeTripSequence(stopDeparture, observedTrip) : observedTrip),
    [observedTrip, stopDeparture],
  );
  // A ride outlives the boards that found it: a departure board lists what has not left yet, so a
  // few minutes after boarding no board mentions this trip. Only the ride keeps the last reading —
  // beside a departure board a departed trip still steps back up to its line, as it always has.
  // Dated by the sequence in it, not by the freshest board in hand: every time the ride publishes
  // is a call of this trip, so a row from a thirty-second board completed by a twenty-minute-old
  // sequence is a twenty-minute-old observation and has to be able to say so.
  const receivedAt =
    observedTripReading?.receivedAt ??
    departureBoard?.receivedAt ??
    lineDepartureBoards[0]?.receivedAt ??
    0;
  const retainedTrip = useRetainedTrip(
    route.isRide ? route.tripId : undefined,
    observedDeparture,
    receivedAt,
  );
  const selectedDeparture = route.isRide ? retainedTrip.departure : observedDeparture;
  const preferredDestination = usePreferredDestination(selectedLine, selectedDeparture);
  // Until the boards have been read once, a trip that has not resolved is only unread, and the view
  // stays as addressed instead of flashing the departure board open beside it.
  const isRide = route.isRide && (Boolean(selectedDeparture) || departureBoard === null);
  // The Ausstieg is a level like any other: it holds only while the trip in hand actually calls
  // there, and drops on its own the moment it does not.
  const alightingStopId =
    isRide &&
    route.alightingStopId &&
    selectedDeparture?.tripCalls?.some((call) => call.localStopId === route.alightingStopId)
      ? route.alightingStopId
      : undefined;

  // The origin is the rider's own, not the feed's: it holds for as long as the ride does, whatever
  // the boards go on to say about the trip.
  const originStopId = isRide ? route.originStopId : undefined;

  // The address always states what actually resolved. Writing it back is how a level leaves the
  // chain, and how a legacy link that named a trip alone acquires the line it belongs to.
  const selectionPath = getSelectionPath({
    stopId,
    lineId: selectedLine?.id,
    bundledLineIds: lineSelection.bundledLineIds,
    tripId: selectedDeparture && getDepartureRouteId(selectedDeparture),
    isRide,
    alightingStopId,
    originStopId,
  });
  useEffect(() => {
    // Nothing is dropped before the board that would confirm it has been read once.
    if (route.view !== "stop" || !selectedStop || (route.tripId && departureBoard === null)) return;
    replaceCurrentRoute(selectionPath);
  }, [departureBoard, route.tripId, route.view, selectedStop, selectionPath]);

  return {
    stopId,
    selectedStop,
    isStopLoading,
    isStopFailed,
    retryStop: () => setStopReloadNonce((nonce) => nonce + 1),
    departureBoard,
    departures,
    selectedLine,
    bundledLines,
    lineSelection,
    selectedDeparture,
    preferredDestination,
    lineDepartureBoards,
    lineTripDepartures: currentLineTrips,
    isRide,
    isSelectedDepartureRetained: isRide && retainedTrip.isRetained,
    selectedDepartureObservedAt: retainedTrip.observedAt,
    alightingStopId,
    originStopId,
    // Only ever waits on a stop that resolved, because an unresolved one is never asked for a board
    // and would wait forever.
    isAwaitingLegacyTrip:
      Boolean(selectedStop) && Boolean(route.tripId) && !route.lineId && departureBoard === null,
  };
}

/**
 * The line in view. A line is running here if this stop's own board says so, whether or not the
 * core observation covers it — that is how a bus keeps its sign. A legacy `/departure/:trip/:stop`
 * link names no line at all, so the trip it resolves to supplies one.
 */
function findSelectedLine(
  route: AppRoute,
  network: TransitNetwork | null,
  departures: readonly Departure[],
  departureBoard: DepartureBoard | null,
  observedLine: TransitLine | undefined,
  stopDeparture: Departure | undefined,
): TransitLine | undefined {
  if (observedLine) return observedLine;
  if (!network) return undefined;

  const lineDeparture = route.lineId
    ? departures.find((departure) => isSameLineFamily(departure.lineId, route.lineId))
    : stopDeparture;
  if (lineDeparture)
    return getLineSign(network.lines, lineDeparture.lineId, lineDeparture.transportMode);

  // A ride can restore its saved trip after a reload even when the current observation no longer
  // sees that line. The retained departure supplies the trip below; this neutral sign only keeps
  // the line level available long enough for that honest observation to resolve.
  if (route.isRide && route.lineId) return getLineSign(network.lines, route.lineId, "other");

  // While the board is loading or the feed is down, an asked-for line keeps a neutral sign rather
  // than collapsing the view. Only a readable board that does not list it drops it.
  const isBoardReadable = departureBoard?.dataStatus === "live";
  return route.lineId && !isBoardReadable
    ? getLineSign(network.lines, route.lineId, "other")
    : undefined;
}

/** The trip as the best-informed board in hand describes it: `lib/trips.ts` decides which that is. */
const findTripInDepartureBoards = (
  boards: readonly DepartureBoard[],
  tripId: string | undefined,
): TripReading | undefined =>
  tripId
    ? findBestTripReading(boards, (departures) => findDepartureByRouteId(departures, tripId))
    : undefined;

/**
 * This stop's individually loaded same-line trips first, then the boards read for this line
 * alone.
 *
 * Every discovered calling point is read, but each board is filtered to this line rather than
 * spending its rows on every service at the stop. The stop in view is different: its filtered rows
 * are also loaded individually so the board beside the diagram can present their complete routes.
 */
function useLineDepartureBoards(
  selection: LineSelection,
  line: TransitLine | undefined,
  stopId: string,
  departureBoard: DepartureBoard | null,
  currentLineTrips: readonly Departure[],
  networkObservationBoards: readonly DepartureBoard[],
  lineDirectionIds: readonly string[],
): readonly DepartureBoard[] {
  // Reuse the full trip sequences the shell's network observation already paid for. They often
  // disclose a branch before this view's own crawl reaches its junction.
  const seedTrips = useMemo(() => {
    const networkLineTrips = networkObservationBoards.flatMap((board) =>
      board.departures.filter((departure) => isSelectedLine(selection, departure.lineId)),
    );
    return [...currentLineTrips, ...networkLineTrips];
  }, [currentLineTrips, networkObservationBoards, selection]);
  const observationBoards = useLineObservationBoards(
    selection,
    line,
    stopId,
    seedTrips,
    lineDirectionIds,
  );
  const currentLineBoard = useMemo(
    () =>
      departureBoard && currentLineTrips.length > 0
        ? { ...departureBoard, departures: currentLineTrips }
        : null,
    [currentLineTrips, departureBoard],
  );
  return useMemo(
    () => (currentLineBoard ? [currentLineBoard, ...observationBoards] : observationBoards),
    [currentLineBoard, observationBoards],
  );
}

/**
 * The boards read for this line alone, along the whole route discovery has reached.
 *
 * The crawl is asked for this line's directions only: a stop's rows are shared by every line
 * calling there, so an unfiltered board at a Zentrum post reaches minutes ahead and a vehicle still
 * out at the end of its run is on none of them. It starts with the whole route the seed trips
 * describe, then every answer may extend it with another branch or short working — a fixed-point
 * crawl that stops naturally once an answer adds no calling point. Only the selected lines may
 * teach it: the first, still-unfiltered read must not pull neighbouring lines into the crawl.
 */
function useLineObservationBoards(
  selection: LineSelection,
  line: TransitLine | undefined,
  stopId: string,
  seedTrips: readonly Departure[],
  lineDirectionIds: readonly string[],
): readonly DepartureBoard[] {
  const selectionKey = getLineSelectionIds(selection).slice().sort().join(",");
  const seedStopIds = useMemo(() => getLineCallStopIds(seedTrips, line), [line, seedTrips]);
  const [discovery, setDiscovery] = useState<{ key: string; stopIds: readonly string[] }>({
    key: selectionKey,
    stopIds: seedStopIds,
  });
  const knownStopIds = useMemo(
    () =>
      discovery.key === selectionKey
        ? extendLineCallStopIds(discovery.stopIds, seedTrips)
        : seedStopIds,
    [discovery, seedStopIds, seedTrips, selectionKey],
  );
  const observationStopIds = useMemo(
    () => (line ? getLineObservationStopIds(knownStopIds, stopId) : EMPTY_STOP_IDS),
    [knownStopIds, line, stopId],
  );
  const observationBoards = useDepartureBoards(
    observationStopIds,
    LINE_OBSERVATION_REFRESH_MS,
    lineDirectionIds,
  );
  const observedLineTrips = useMemo(
    () =>
      observationBoards.flatMap((board) =>
        board.departures.filter((departure) => isSelectedLine(selection, departure.lineId)),
      ),
    [observationBoards, selection],
  );
  const expandedStopIds = useMemo(
    () => extendLineCallStopIds(knownStopIds, observedLineTrips),
    [knownStopIds, observedLineTrips],
  );
  // Adjusted while rendering rather than in an effect: the newly discovered stops are read on the
  // next render, and waiting a paint would show a diagram missing the very branch its boards just
  // disclosed. A line change restarts the crawl under its own selection.
  if (discovery.key !== selectionKey || expandedStopIds !== discovery.stopIds) {
    setDiscovery({ key: selectionKey, stopIds: expandedStopIds });
  }
  return observationBoards;
}

/**
 * The departures of the selected line whose whole trip is worth loading.
 *
 * Capped, because a diagram can only mark the vehicles a rider can still catch: a busy post lists
 * this line ten times, and the tenth is three quarters of an hour out and a request nobody reads.
 * The trip the rider actually chose is always among them, however far down the board it sits.
 */
function useLineDeparturesAtStop(
  selection: LineSelection,
  lineStopBoard: DepartureBoard | null,
  departures: readonly Departure[],
  stopDeparture: Departure | undefined,
): readonly Departure[] {
  // Until the filtered board answers, the rows the rider's own board already saw are what there is.
  const rows = lineStopBoard?.departures ?? departures;
  return useMemo(() => {
    if (!selection.lineId) return EMPTY_DEPARTURES;
    // The cap is the reading's, not each line's: it stands for the trips a rider can still catch,
    // and a corridor read as one has one such set of trips however many lines run it.
    const ofSelection = rows.filter((departure) => isSelectedLine(selection, departure.lineId));
    const loaded = ofSelection.slice(0, LINE_TRIP_LOAD_LIMIT);
    return stopDeparture && !loaded.some(({ id }) => id === stopDeparture.id)
      ? [stopDeparture, ...loaded]
      : loaded;
  }, [selection, rows, stopDeparture]);
}

/**
 * The siblings of the addressed line that are actually running here.
 *
 * Resolved against this stop's own board rather than the observed network: the bundle is a reading
 * of this stop's corridor, so the evidence that belongs to it is what leaves from here. A sibling
 * the board does not list drops out of the address and the line is read alone — the same way a
 * departed trip drops back to its line.
 */
function useBundledLines(
  bundledLineIds: readonly string[],
  selectedLine: TransitLine | undefined,
  network: TransitNetwork | null,
  departures: readonly Departure[],
): readonly TransitLine[] {
  return useMemo(() => {
    if (!selectedLine || !network || bundledLineIds.length === 0) return EMPTY_LINES;
    return bundledLineIds.flatMap((lineId) => {
      if (isSameLineFamily(lineId, selectedLine.id)) return [];
      const running = departures.find((departure) => isSameLineFamily(departure.lineId, lineId));
      return running ? [getLineSign(network.lines, running.lineId, running.transportMode)] : [];
    });
  }, [bundledLineIds, departures, network, selectedLine]);
}

/** Order-preserving, which is what keeps a filtered board's parameters stable between refreshes. */
const toDistinct = (ids: readonly string[]): string[] => [...new Set(ids)];

/**
 * The destination the rider was last heading for on this line, remembered against the selection it
 * was read from, so choosing another line or stop starts over.
 */
function usePreferredDestination(
  line: TransitLine | undefined,
  departure: Departure | undefined,
): string | undefined {
  // The line, not the stop it is read at: moving along a line from one of its stops to the next is
  // one reading of one line, and re-deciding the direction at every stop turned the diagram around
  // under a rider who had only stepped along it.
  const selectionKey = line?.id ?? "";
  // Adjusted while rendering rather than in an effect: the direction is derived from the trip in
  // hand, so waiting a paint to record it would draw one frame of the line facing the wrong way.
  const [lastDestination, setLastDestination] = useState<{
    key: string;
    destination: string;
  } | null>(null);
  if (
    departure &&
    (lastDestination?.key !== selectionKey || lastDestination.destination !== departure.destination)
  ) {
    setLastDestination({ key: selectionKey, destination: departure.destination });
  }
  return lastDestination?.key === selectionKey ? lastDestination.destination : undefined;
}
