import { useEffect, useMemo, useState } from "react";
import { useStopEventBoard } from "./hooks/stop-event-board";
import { useStoredPreference } from "./hooks/stored-preference";
import { stopEventBoardOrder } from "./lib/stop-event-board-order";
import { useHeldDatedJourney } from "./hooks/dated-journey-reading-store";
import { useLineReading } from "./hooks/line-reading";
import { useRetainedDatedJourney } from "./hooks/retained-dated-journey";
import { useTransitStop } from "./hooks/transit-network";
import {
  readDatedJourneysNow,
  useDatedJourneyReadings,
} from "./hooks/dated-journey-reading-loader";
import { mergeAddressedDatedJourney } from "./lib/calls";
import { findBestDatedJourneyReading } from "./lib/journeys";
import { findLineForRoute } from "./lib/line-families";
import { createLineSelectionOf, type LineSelection } from "./lib/line-bundles";
import type {
  StopEvent,
  StopEventBoard,
  TransitLine,
  TransitNetwork,
  StopPlace,
} from "./data/transit-types";
import {
  DEFAULT_STOP_ID,
  findStopEventByAddressId,
  getStopEventAddressId,
  getSelectionPath,
  isAddressOutstanding,
  replaceCurrentRoute,
  type AppRoute,
} from "./routing";
import { findBundledLines, findSelectedLine } from "./selected-line";
import { stationBoardConfig } from "./station-board";

const EMPTY_STOP_EVENTS: readonly StopEvent[] = [];
/**
 * Whether the visible board asks for calling sequences. Only an unattended board printing `via`
 * does; selected-line journeys are read one at a time.
 */
const NEEDS_BOARD_CALLS = stationBoardConfig?.detail === "via";

/**
 * What the address resolved to: stop, line, journey, each resolved on its own. A level that no
 * longer resolves drops back to the one above; only a stop can be a dead end.
 */
export type ResolvedSelectionChain = {
  /** The stop shown, which a line-only address resolves itself. */
  stopId: string;
  selectedStop: StopPlace | undefined;
  isStopLoading: boolean;
  /** The stop's read failed, as opposed to not found. */
  isStopFailed: boolean;
  retryStop: () => void;
  /** Reads the board again (pull to refresh); the board in view stays until the answer. */
  refreshBoard: () => void;
  /**
   * Reads the line's dated journeys at this stop again, or on a ride the ride's own dated journey
   * (pull to refresh); settles when they have answered.
   */
  refreshLine: () => Promise<void>;
  stopEventBoard: StopEventBoard | null;
  /** How many board readings have answered, however they answered. */
  boardReadingCount: number;
  stopEvents: readonly StopEvent[];
  selectedLine: TransitLine | undefined;
  /** The sibling lines as resolved; one the stop no longer lists drops out. */
  bundledLines: readonly TransitLine[];
  /** The lines in view, as one value for filters and highlights. */
  lineSelection: LineSelection;
  selectedStopEvent: StopEvent | undefined;
  /** Where the rider was last heading on this line, so the diagram keeps its direction. */
  preferredDestination: string | undefined;
  /** This stop's board plus the line-filtered boards discovered along the whole line. */
  lineStopEventBoards: readonly StopEventBoard[];
  /** Whole-journey readings for the selected line at this stop. */
  lineDatedJourneyStopEvents: readonly StopEvent[];
  /** A ride: the journey on its own, without the board. Ends with the journey. */
  isRide: boolean;
  /** The journey shown is the last observation, because boards stopped listing it. */
  isSelectedStopEventRetained: boolean;
  /** When that observation was taken. */
  selectedStopEventObservedAt: number;
  /** The rider's Ausstieg, once the journey confirms it calls there. */
  alightingStopId: string | undefined;
  /** The stop the ride began at, from the address; never inferred, never dropped. */
  originStopId: string | undefined;
  /**
   * A stop-scoped journey awaits its board to learn its line, so the bare stop does not flash
   * first.
   */
  isAwaitingStopBoardJourney: boolean;
};

export function useSelectionChain(
  route: AppRoute,
  network: TransitNetwork,
  observationBoards: readonly StopEventBoard[] = [],
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
  const boardOrder = useStoredPreference(stopEventBoardOrder);
  const stopEventBoardReading = useStopEventBoard(
    selectedStop ? stopId : undefined,
    NEEDS_BOARD_CALLS ? "calls" : boardOrder === "line" ? "covered" : "plain",
    boardReloadNonce,
  );
  const stopEventBoard = stopEventBoardReading.board;
  const stopEvents = stopEventBoard?.stopEvents ?? EMPTY_STOP_EVENTS;
  // A journey beside a stop is that stop's own row; other boards' copies are not interchangeable.
  const ownStopEvent = findStopEventByAddressId(stopEvents, route.addressId);

  const selectedLine = findSelectedLine(
    route,
    network,
    stopEvents,
    stopEventBoard,
    observedLine,
    ownStopEvent,
  );
  // Keyed by id, not by the sign object: an unseen line gets a fresh sign object every render.
  const selectedLineId = selectedLine?.id;
  // Siblings come only from the address and stay while this stop's board lists them.
  const bundledLines = useBundledLines(route.bundledLineIds, selectedLine, network, stopEventBoard);
  const selectedLineIdentity = selectedLine?.identity;
  const lineSelection = useMemo(
    () =>
      createLineSelectionOf(
        { id: selectedLineId ?? "", identity: selectedLineIdentity },
        bundledLines,
      ),
    [bundledLines, selectedLineId, selectedLineIdentity],
  );
  const selectionLines = useMemo(
    () => (selectedLine ? [selectedLine, ...bundledLines] : bundledLines),
    [bundledLines, selectedLine],
  );
  const { addressedStopEvent, lineStopEventBoards, lineDatedJourneyStopEvents, isReadingLine } =
    useLineReading({
      stopId,
      addressId: route.addressId,
      lineSelection,
      lines: selectionLines,
      stopEventBoard,
      observationBoards,
      ownStopEvent,
    });
  // A dated journey without a stop is looked for across the line's boards, freshest copy first.
  const observedBoards = useMemo(
    () => [...observationBoards, ...lineStopEventBoards],
    [lineStopEventBoards, observationBoards],
  );
  const observedDatedJourneyReading = findDatedJourneyInStopEventBoards(
    observedBoards,
    route.addressId,
  );
  // The addressed dated journey is always read alone: a board's calls never stand in for its
  // reading.
  const addressedDatedJourneyRows = useMemo(
    () => (observedDatedJourneyReading ? [observedDatedJourneyReading] : EMPTY_STOP_EVENTS),
    [observedDatedJourneyReading],
  );
  const [addressedDatedJourneyReading] = useDatedJourneyReadings(addressedDatedJourneyRows, {
    selectedRowId: addressedDatedJourneyRows[0]?.id,
  });
  // The stop row owns countdown, bay and destination; the dated journey reading adds the full
  // sequence.
  const observedStopEvent = useMemo(
    () =>
      mergeAddressedDatedJourney(
        addressedStopEvent,
        observedDatedJourneyReading,
        addressedDatedJourneyReading,
      ),
    [addressedStopEvent, observedDatedJourneyReading, addressedDatedJourneyReading],
  );
  // A ride keeps the last reading once boards stop listing the dated journey; its age comes from
  // the departure's own read times.
  const retainedDatedJourney = useRetainedDatedJourney(
    route.isRide ? route.addressId : undefined,
    observedStopEvent,
  );
  // Off a ride, the addressed dated journey is held only until the readings that could name it have
  // answered.
  const heldStopEvent = useHeldDatedJourney(
    route.isRide ? undefined : route.addressId,
    observedStopEvent,
  );
  const isAddressStillOutstanding = isAddressOutstanding({
    addressId: route.addressId,
    hasResolvedStopEvent: Boolean(
      route.isRide ? retainedDatedJourney.stopEvent : observedStopEvent,
    ),
    isStopBoardRead: stopEventBoard !== null,
    isReadingLine,
  });
  const selectedStopEvent = route.isRide
    ? retainedDatedJourney.stopEvent
    : (observedStopEvent ?? (isAddressStillOutstanding ? heldStopEvent : undefined));
  const preferredDestination = usePreferredDestination(selectedLine, selectedStopEvent);
  // Until boards are read once, an unresolved dated journey is only unread.
  const isRide = route.isRide && (Boolean(selectedStopEvent) || stopEventBoard === null);
  // The Ausstieg holds only while the journey calls there.
  const alightingStopId =
    isRide &&
    route.alightingStopId &&
    selectedStopEvent?.calls?.some((call) => call.localStopId === route.alightingStopId)
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
    addressId: selectedStopEvent && getStopEventAddressId(selectedStopEvent),
    journeyParent: route.journeyParent,
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
    refreshLine: () => {
      if (isRide) return readDatedJourneysNow(selectedStopEvent ? [selectedStopEvent.id] : []);
      setBoardReloadNonce((nonce) => nonce + 1);
      return readDatedJourneysNow([
        ...new Set([
          ...(selectedStopEvent ? [selectedStopEvent.id] : []),
          ...lineDatedJourneyStopEvents.map(({ id }) => id),
        ]),
      ]);
    },
    stopEventBoard,
    boardReadingCount: stopEventBoardReading.readingCount,
    stopEvents,
    selectedLine,
    bundledLines,
    lineSelection,
    selectedStopEvent,
    preferredDestination,
    lineStopEventBoards,
    lineDatedJourneyStopEvents,
    isRide,
    isSelectedStopEventRetained: isRide && retainedDatedJourney.isRetained,
    selectedStopEventObservedAt: retainedDatedJourney.observedAt,
    alightingStopId,
    originStopId,
    // Only a resolved stop is asked for a board, so only then can it wait.
    isAwaitingStopBoardJourney:
      Boolean(selectedStop) && Boolean(route.addressId) && !route.lineId && stopEventBoard === null,
  };
}

/** The dated journey as the best-informed board in hand describes it (`lib/journeys.ts`). */
const findDatedJourneyInStopEventBoards = (
  boards: readonly StopEventBoard[],
  addressId: string | undefined,
): StopEvent | undefined =>
  addressId
    ? findBestDatedJourneyReading(boards, (stopEvents) =>
        findStopEventByAddressId(stopEvents, addressId),
      )
    : undefined;

function useBundledLines(
  bundledLineIds: readonly string[],
  selectedLine: TransitLine | undefined,
  network: TransitNetwork,
  stopEventBoard: StopEventBoard | null,
): readonly TransitLine[] {
  return useMemo(
    () => findBundledLines(bundledLineIds, selectedLine, network, stopEventBoard),
    [bundledLineIds, stopEventBoard, network, selectedLine],
  );
}

/** The destination last headed for on this line; another line starts over. */
function usePreferredDestination(
  line: TransitLine | undefined,
  stopEvent: StopEvent | undefined,
): string | undefined {
  // Keyed by line, not stop, so stepping along the line keeps the direction.
  const selectionKey = line?.id ?? "";
  // Set during render, so no frame draws the line facing the wrong way.
  const [lastDestination, setLastDestination] = useState<{
    key: string;
    destination: string;
  } | null>(null);
  if (
    stopEvent &&
    (lastDestination?.key !== selectionKey ||
      lastDestination.destination !== stopEvent.destinationText)
  ) {
    setLastDestination({ key: selectionKey, destination: stopEvent.destinationText });
  }
  return lastDestination?.key === selectionKey ? lastDestination.destination : undefined;
}
