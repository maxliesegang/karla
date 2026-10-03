import { useEffect, useMemo, useState } from "react";
import { useDepartureBoard } from "./hooks/departure-board";
import { useStoredPreference } from "./hooks/stored-preference";
import { departureBoardOrder } from "./lib/departure-board-order";
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
  type AppRoute,
} from "./routing";
import { findSelectedLine } from "./selected-line";
import { stationBoardConfig } from "./station-board";

const EMPTY_DEPARTURES: readonly Departure[] = [];
const EMPTY_LINES: readonly TransitLine[] = [];
/**
 * Whether the visible board asks for calling sequences. Only an unattended board printing `via`
 * does; selected-line trips are read one at a time.
 */
const NEEDS_BOARD_CALLS = stationBoardConfig?.detail === "via";

/**
 * What the address resolved to: stop, line, trip, each resolved on its own. A level that no longer
 * resolves drops back to the one above; only a stop can be a dead end.
 */
export type ResolvedSelectionChain = {
  /** The stop shown, which a line-only address resolves itself. */
  stopId: string;
  selectedStop: TransitStop | undefined;
  isStopLoading: boolean;
  /** The stop's read failed, as opposed to not found. */
  isStopFailed: boolean;
  retryStop: () => void;
  /** Reads the board again (pull to refresh); the board in view stays until the answer. */
  refreshBoard: () => void;
  departureBoard: DepartureBoard | null;
  /** How many board readings have answered, however they answered. */
  boardReadingCount: number;
  departures: readonly Departure[];
  selectedLine: TransitLine | undefined;
  /** The sibling lines as resolved; one the stop no longer lists drops out. */
  bundledLines: readonly TransitLine[];
  /** The lines in view, as one value for filters and highlights. */
  lineSelection: LineSelection;
  selectedDeparture: Departure | undefined;
  /** Where the rider was last heading on this line, so the diagram keeps its direction. */
  preferredDestination: string | undefined;
  /** This stop's board plus the line-filtered boards discovered along the whole line. */
  lineDepartureBoards: readonly DepartureBoard[];
  /** Whole-run readings for the selected line at this stop. */
  lineRunDepartures: readonly Departure[];
  /** A ride: the trip on its own, without the board. Ends with the trip. */
  isRide: boolean;
  /** The trip shown is the last observation, because boards stopped listing it. */
  isSelectedDepartureRetained: boolean;
  /** When that observation was taken. */
  selectedDepartureObservedAt: number;
  /** The rider's Ausstieg, once the trip confirms it calls there. */
  alightingStopId: string | undefined;
  /** The stop the ride began at, from the address; never inferred, never dropped. */
  originStopId: string | undefined;
  /**
   * A stop-scoped trip awaits its board to learn its line, so the bare stop does not flash first.
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
  // Retry by bumping the nonce, so the last result stays visible meanwhile.
  const [stopReloadNonce, setStopReloadNonce] = useState(0);
  const {
    stop: selectedStop,
    loading: isStopLoading,
    failed: isStopFailed,
  } = useTransitStop(route.view === "stop" ? addressedStopId : undefined, {
    reloadNonce: stopReloadNonce,
  });
  // The resolved stop is the identity, so board and calls never use different ids for one place.
  const stopId = selectedStop?.id ?? addressedStopId;
  // Reloading re-runs the same reading, so the board in view stays until the answer.
  const [boardReloadNonce, setBoardReloadNonce] = useState(0);

  // Only the line order pays for per-direction completion, where a missing direction would be a
  // missing line.
  const boardOrder = useStoredPreference(departureBoardOrder);
  const departureBoardReading = useDepartureBoard(
    selectedStop ? stopId : undefined,
    NEEDS_BOARD_CALLS ? "calls" : boardOrder === "line" ? "covered" : "plain",
    boardReloadNonce,
  );
  const departureBoard = departureBoardReading.board;
  const departures = departureBoard?.departures ?? EMPTY_DEPARTURES;
  // A trip beside a stop is that stop's own row; other boards' copies are not interchangeable.
  const stopDeparture = findDepartureByAddressId(departures, route.addressId);

  const selectedLine = findSelectedLine(
    route,
    network,
    departures,
    departureBoard,
    observedLine,
    stopDeparture,
  );
  // Keyed by id, not by the sign object: an unseen line gets a fresh sign object every render.
  const selectedLineId = selectedLine?.id;
  // Siblings come only from the address and stay while this stop's board lists them.
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
  // A run without a stop is looked for across the line's boards, freshest copy first.
  const observedBoards = useMemo(
    () => [...observationBoards, ...lineDepartureBoards],
    [lineDepartureBoards, observationBoards],
  );
  const observedRunReading = findRunInDepartureBoards(observedBoards, route.addressId);
  // A run not yet under way has no calls from the line's boards, so the addressed run is read
  // alone.
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
  // The stop row owns countdown, platform and destination; the run reading adds the full sequence.
  const observedRun = addressedRunReading ?? observedRunReading;
  const observedDeparture = useMemo(
    () => (addressedDeparture ? mergeRunReading(addressedDeparture, observedRun) : observedRun),
    [addressedDeparture, observedRun],
  );
  // A ride keeps the last reading once boards stop listing the run; its age comes from the
  // departure's own read times.
  const retainedRun = useRetainedRun(route.isRide ? route.addressId : undefined, observedDeparture);
  // Off a ride, the addressed run is held only until the readings that could name it have answered.
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
  // Until boards are read once, an unresolved run is only unread.
  const isRide = route.isRide && (Boolean(selectedDeparture) || departureBoard === null);
  // The Ausstieg holds only while the trip calls there.
  const alightingStopId =
    isRide &&
    route.alightingStopId &&
    selectedDeparture?.tripCalls?.some((call) => call.localStopId === route.alightingStopId)
      ? route.alightingStopId
      : undefined;

  // The origin holds as long as the ride does.
  const originStopId = isRide ? route.originStopId : undefined;

  // The address states what resolved. A level drops only once the readings that could name it have
  // answered (`isAddressOutstanding`).
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
    // Only a resolved stop is asked for a board, so only then can it wait.
    isAwaitingStopBoardTrip:
      Boolean(selectedStop) && Boolean(route.addressId) && !route.lineId && departureBoard === null,
  };
}

/** The run as the best-informed board in hand describes it (`lib/trips.ts`). */
const findRunInDepartureBoards = (
  boards: readonly DepartureBoard[],
  addressId: string | undefined,
): Departure | undefined =>
  addressId
    ? findBestRunReading(boards, (departures) => findDepartureByAddressId(departures, addressId))
    : undefined;

/**
 * The addressed siblings that resolve at this stop. Kept while the board is unread or unavailable;
 * a live whole-stop board resolves them from `servingLines`, not just its rows.
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

/** The destination last headed for on this line; another line starts over. */
function usePreferredDestination(
  line: TransitLine | undefined,
  departure: Departure | undefined,
): string | undefined {
  // Keyed by line, not stop, so stepping along the line keeps the direction.
  const selectionKey = line?.id ?? "";
  // Set during render, so no frame draws the line facing the wrong way.
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
