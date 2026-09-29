import { useEffect, useMemo, useState } from "react";
import { useDepartureBoard } from "./hooks/departure-board";
import { useDepartureBoardOrder } from "./hooks/departure-order";
import { useHeldRun } from "./hooks/run-reading-store";
import { useLineReading } from "./hooks/line-reading";
import { useRetainedRun } from "./hooks/retained-run";
import { useTransitStop } from "./hooks/transit-network";
import { useRunReadings } from "./hooks/run-reading-loader";
import { mergeRunReading } from "./lib/trip-calls";
import { findBestRunReading } from "./lib/trips";
import { getLineSign } from "./data/line-signs";
import { findLineForRoute, isSameLineFamily } from "./lib/line-families";
import {
  createLineSelection,
  getResolvedBundledLineIds,
  type LineSelection,
} from "./lib/line-bundles";
import type {
  Departure,
  DepartureBoard,
  TransitLine,
  TransitNetwork,
  TransitStop,
} from "./data/transit-types";
import {
  DEFAULT_STOP_ID,
  findDepartureByAddressId,
  getDepartureAddressId,
  getSelectionPath,
  isAddressOutstanding,
  replaceCurrentRoute,
  stationBoardConfig,
  type AppRoute,
} from "./routing";

const EMPTY_DEPARTURES: readonly Departure[] = [];
const EMPTY_LINES: readonly TransitLine[] = [];
/**
 * Whether the visible board is asked for the trips behind its departures, or only for what leaves.
 *
 * The board a rider reads stays light whatever the address names: a selected line's trips are read
 * one at a time from the single-trip endpoint, and the observation boards behind the network are
 * bounded and shared. Only an unattended board whose own rows print `via` needs complete sequences
 * in the board response itself — no address a rider navigates to does.
 */
const NEEDS_BOARD_CALLS = stationBoardConfig?.detail === "via";

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
  /**
   * Reads the stop's board again, whatever its last reading was. The board in view stands while the
   * reading is under way and is simply replaced by it; this is what a pull to refresh asks for.
   */
  refreshBoard: () => void;
  departureBoard: DepartureBoard | null;
  /** How many readings of the board have answered, however each of them answered. */
  boardReadingCount: number;
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
  /** Whole-run readings for the selected line at this stop, used for route-aware presentation. */
  lineRunDepartures: readonly Departure[];
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
   * A stop-scoped trip cannot say which line it belongs to until its board arrives; showing the
   * bare stop first would flip to the line view a moment later.
   */
  isAwaitingStopBoardTrip: boolean;
};

export function useSelectionChain(
  route: AppRoute,
  network: TransitNetwork,
  observationBoards: readonly DepartureBoard[] = [],
): ResolvedSelectionChain {
  const observedLine = findLineForRoute(network.lines, route.lineId);
  const addressedStopId = route.stopId || observedLine?.zentrumCalls[0] || DEFAULT_STOP_ID;
  // A failed provider read is retried by bumping the nonce: the load re-runs for the same key, so
  // whatever the last attempt settled on stays visible until the new one answers.
  const [stopReloadNonce, setStopReloadNonce] = useState(0);
  const {
    stop: selectedStop,
    loading: isStopLoading,
    failed: isStopFailed,
  } = useTransitStop(route.view === "stop" ? addressedStopId : undefined, {
    reloadNonce: stopReloadNonce,
  });
  // An address is a seed, not the stop's identity. A former dynamic link may resolve to a stable
  // authored stop; every reading after resolution and the canonical address use that answer so a
  // board and its trip calls can never describe the same place under different ids.
  const stopId = selectedStop?.id ?? addressedStopId;
  // The board a rider can ask to be read again by pulling it down. The nonce re-runs the same
  // reading rather than starting a new one, so the board in view stands until the answer arrives.
  const [boardReloadNonce, setBoardReloadNonce] = useState(0);

  // Wait for the stable network to resolve the stop before touching the live provider: a deep link
  // to an unknown stop should render locally instead of causing a pointless board request.
  // Only the line order pays for the per-direction completion. It is the reading where a direction
  // the plain board never reached is not a shorter list but a line missing from the answer to "what
  // runs from here?", and it is chosen deliberately — the other two orders keep the light board.
  const departureBoardOrder = useDepartureBoardOrder();
  const departureBoardReading = useDepartureBoard(
    selectedStop ? stopId : undefined,
    NEEDS_BOARD_CALLS ? "calls" : departureBoardOrder === "line" ? "covered" : "plain",
    boardReloadNonce,
  );
  const departureBoard = departureBoardReading.board;
  const departures = departureBoard?.departures ?? EMPTY_DEPARTURES;
  // A trip named beside a stop is that stop's own entry: its countdown, platform and calling point
  // are the ones the board states, so another board's copy of the same trip is not interchangeable.
  const stopDeparture = findDepartureByAddressId(departures, route.addressId);

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
  const bundledLines = useBundledLines(route.bundledLineIds, selectedLine, network, departureBoard);
  const lineSelection = useMemo(
    () =>
      createLineSelection(
        selectedLineId ?? "",
        bundledLines.map(({ id }) => id),
      ),
    [bundledLines, selectedLineId],
  );
  const selectionLines = useMemo(
    () => (selectedLine ? [selectedLine, ...bundledLines] : bundledLines),
    [bundledLines, selectedLine],
  );
  const { addressedDeparture, lineDepartureBoards, lineRunDepartures, isReadingLine } =
    useLineReading({
      stopId,
      addressId: route.addressId,
      lineSelection,
      lines: selectionLines,
      departureBoard,
      observationBoards,
      stopDeparture,
    });
  // A run addressed on its own names no stop, so the board it was read from is not known in
  // advance: it is looked for across the line's boards, keeping the freshest copy that saw the run.
  const observedBoards = useMemo(
    () => [...observationBoards, ...lineDepartureBoards],
    [lineDepartureBoards, observationBoards],
  );
  const observedRunReading = findRunInDepartureBoards(observedBoards, route.addressId);
  // A run found up the line is a row before it is a run: the boards along a line are read as rows,
  // and only the runs actually out on it are read as calls (`getLineDepartureBoards`). One that is
  // not — a departure still hours from setting out, which a rider may well have shared a link to —
  // has no chain for the diagram to draw, so the one run the address names is read on its own.
  const addressedRunRows = useMemo(
    () =>
      observedRunReading && !observedRunReading.tripCalls?.length
        ? [observedRunReading]
        : EMPTY_DEPARTURES,
    [observedRunReading],
  );
  const [addressedRunReading] = useRunReadings(addressedRunRows, {
    selectedRowId: addressedRunRows[0]?.id,
  });
  // The stop row owns countdown, platform and destination; the single-run reading contributes the
  // complete sequence. This keeps one published departure fact while still preferring fuller calls.
  const observedRun = addressedRunReading ?? observedRunReading;
  const observedDeparture = useMemo(
    () => (addressedDeparture ? mergeRunReading(addressedDeparture, observedRun) : observedRun),
    [addressedDeparture, observedRun],
  );
  // A ride outlives the boards that found it: a departure board lists what has not left yet, so a
  // few minutes after boarding no board mentions this run. Only the ride keeps the last reading;
  // beside a departure board a departed run steps back up to its line.
  // The departure states when each half of it was read, so the ride reads its own age off it: a row
  // from a thirty-second board completed by a twenty-minute-old sequence is a twenty-minute-old
  // observation and says so without being told.
  const retainedRun = useRetainedRun(route.isRide ? route.addressId : undefined, observedDeparture);
  // Off the ride, the addressed run is held only while the readings that could name it are still
  // out — a step along the line re-keys every board behind it. Once they have answered without it,
  // the trip leaves the address.
  const heldDeparture = useHeldRun(route.isRide ? undefined : route.addressId, observedDeparture);
  const isAddressStillOutstanding = isAddressOutstanding({
    addressId: route.addressId,
    hasResolvedDeparture: Boolean(route.isRide ? retainedRun.departure : observedDeparture),
    isStopBoardRead: departureBoard !== null,
    isReadingLine,
  });
  const selectedDeparture = route.isRide
    ? retainedRun.departure
    : (observedDeparture ?? (isAddressStillOutstanding ? heldDeparture : undefined));
  const preferredDestination = usePreferredDestination(selectedLine, selectedDeparture);
  // Until the boards have been read once, a run that has not resolved is only unread, and the view
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
  // chain, and how a stop-scoped trip acquires the line it belongs to without changing its parent
  // — but a level is only ever dropped once the readings that could name it have answered, which
  // for a run is not this stop's board alone (`isAddressOutstanding`).
  const selectionPath = getSelectionPath({
    stopId,
    lineId: selectedLine?.id,
    bundledLineIds: lineSelection.bundledLineIds,
    addressId: selectedDeparture && getDepartureAddressId(selectedDeparture),
    tripParent: route.tripParent,
    isRide,
    alightingStopId,
    originStopId,
  });
  useEffect(() => {
    if (route.view !== "stop" || !selectedStop || isAddressStillOutstanding) return;
    replaceCurrentRoute(selectionPath);
  }, [isAddressStillOutstanding, route.view, selectedStop, selectionPath]);

  return {
    stopId,
    selectedStop,
    isStopLoading,
    isStopFailed,
    retryStop: () => setStopReloadNonce((nonce) => nonce + 1),
    refreshBoard: () => setBoardReloadNonce((nonce) => nonce + 1),
    departureBoard,
    boardReadingCount: departureBoardReading.readingCount,
    departures,
    selectedLine,
    bundledLines,
    lineSelection,
    selectedDeparture,
    preferredDestination,
    lineDepartureBoards,
    lineRunDepartures,
    isRide,
    isSelectedDepartureRetained: isRide && retainedRun.isRetained,
    selectedDepartureObservedAt: retainedRun.observedAt,
    alightingStopId,
    originStopId,
    // Only ever waits on a stop that resolved, because an unresolved one is never asked for a board
    // and would wait forever.
    isAwaitingStopBoardTrip:
      Boolean(selectedStop) && Boolean(route.addressId) && !route.lineId && departureBoard === null,
  };
}

/**
 * The line in view. A line is running here if this stop's own board says so, whether or not the
 * Zentrum observation covers it — that is how a bus keeps its sign. A stop-scoped trip address
 * names no line at all, so the departure it resolves to supplies one.
 */
function findSelectedLine(
  route: AppRoute,
  network: TransitNetwork,
  departures: readonly Departure[],
  departureBoard: DepartureBoard | null,
  observedLine: TransitLine | undefined,
  stopDeparture: Departure | undefined,
): TransitLine | undefined {
  if (observedLine) return observedLine;

  const lineDeparture = route.lineId
    ? departures.find((departure) => isSameLineFamily(departure.lineId, route.lineId))
    : stopDeparture;
  if (lineDeparture)
    return getLineSign(network.lines, lineDeparture.lineId, lineDeparture.transportMode);

  // A ride can restore its saved run after a reload even when the current observation no longer
  // sees that line. The retained departure supplies the run below; this neutral sign only keeps
  // the line level available long enough for that honest observation to resolve.
  if (route.isRide && route.lineId) return getLineSign(network.lines, route.lineId, "other");

  // While the board is loading or the feed is down, an asked-for line keeps a neutral sign rather
  // than collapsing the view. Only a readable board that does not list it drops it.
  const isBoardReadable = departureBoard?.dataStatus === "live";
  return route.lineId && !isBoardReadable
    ? getLineSign(network.lines, route.lineId, "other")
    : undefined;
}

/** The run as the best-informed board in hand describes it: `lib/trips.ts` decides which that is. */
const findRunInDepartureBoards = (
  boards: readonly DepartureBoard[],
  addressId: string | undefined,
): Departure | undefined =>
  addressId
    ? findBestRunReading(boards, (departures) => findDepartureByAddressId(departures, addressId))
    : undefined;

/**
 * The siblings of the addressed line that resolve at this stop.
 *
 * A bundle is a rider choice, so it is retained while this stop's board is unread or unavailable.
 * A live whole-stop board resolves it from `servingLines`, not only its limited departure rows: at
 * a busy stop a sibling can call here without appearing among the next twenty trips. Only a live
 * answer that names neither the line nor one of its departures drops it from the address.
 */
function useBundledLines(
  bundledLineIds: readonly string[],
  selectedLine: TransitLine | undefined,
  network: TransitNetwork,
  departureBoard: DepartureBoard | null,
): readonly TransitLine[] {
  return useMemo(() => {
    if (!selectedLine || bundledLineIds.length === 0) return EMPTY_LINES;
    return getResolvedBundledLineIds(bundledLineIds, departureBoard).flatMap((lineId) => {
      if (isSameLineFamily(lineId, selectedLine.id)) return [];
      const running = departureBoard?.departures.find((departure) =>
        isSameLineFamily(departure.lineId, lineId),
      );
      const observed = findLineForRoute(network.lines, lineId);
      if (observed) return [observed];
      return running ? [getLineSign(network.lines, running.lineId, running.transportMode)] : [];
    });
  }, [bundledLineIds, departureBoard, network, selectedLine]);
}

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
