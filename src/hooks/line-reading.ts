import { useMemo } from "react";
import type { StopEvent, StopEventBoard, TransitLine } from "../data/transit-types";
import { isSelectedLine, type LineSelection } from "../lib/line-bundles";
import { findStopEventByAddressId } from "../routing";
import { useLineStopBoard } from "./stop-event-board";
import {
  useLineFilterLineRefs,
  useLineObservation,
  type LineObservationReading,
} from "./line-observation";
import { useDatedJourneyReadings } from "./dated-journey-reading-loader";

const EMPTY_STOP_EVENTS: readonly StopEvent[] = [];

/** A line's departures at this stop loaded as whole journeys: enough for the reachable vehicles. */
const LINE_DATED_JOURNEY_LOAD_LIMIT = 6;

/** What reading a selected line at one stop produces. */
export type LineReading = {
  /**
   * The addressed dated journey as this stop states it, on the shared or the line-filtered board.
   */
  addressedStopEvent: StopEvent | undefined;
  /**
   * This stop's dated journeys of the line, plus the line-filtered boards read along the whole
   * line.
   */
  lineStopEventBoards: readonly StopEventBoard[];
  /** Whole-journey readings for the selected line at this stop. */
  lineDatedJourneyStopEvents: readonly StopEvent[];
  /** Whether boards that could still name the addressed dated journey are outstanding. */
  isReadingLine: boolean;
};

/**
 * Everything read for the selected line: the stop's board filtered to it, its nearest dated
 * journeys read whole, and the boards along the line. Nothing without a selected line.
 */
export function useLineReading({
  stopId,
  addressId,
  lineSelection,
  lines,
  stopEventBoard,
  observationBoards,
  ownStopEvent,
}: {
  stopId: string;
  addressId: string | undefined;
  lineSelection: LineSelection;
  lines: readonly TransitLine[];
  /** The rider's own, unfiltered board. */
  stopEventBoard: StopEventBoard | null;
  observationBoards: readonly StopEventBoard[];
  /** The addressed dated journey as the rider's own board lists it, where it does. */
  ownStopEvent: StopEvent | undefined;
}): LineReading {
  const stopEvents = stopEventBoard?.stopEvents ?? EMPTY_STOP_EVENTS;
  // The shell's unfiltered boards (rider's stop, network observation) name the line-directions that
  // decide every filter below.
  const shellBoards = useMemo(
    () => (stopEventBoard ? [stopEventBoard, ...observationBoards] : observationBoards),
    [stopEventBoard, observationBoards],
  );
  const stopFilterLineRefs = useLineFilterLineRefs(lineSelection, shellBoards);
  // This stop filtered to the line, reaching most of an hour instead of minutes.
  const lineStopBoard = useLineStopBoard(
    lineSelection.lineId ? stopId : undefined,
    stopFilterLineRefs,
  );
  // Looked for on both readings of this stop: at a busy stop the addressed dated journey is often
  // only on the filtered one.
  const addressedStopEvent =
    ownStopEvent ??
    findStopEventByAddressId(lineStopBoard?.stopEvents ?? EMPTY_STOP_EVENTS, addressId);
  const lineDeparturesAtStop = useLineDeparturesAtStop(
    lineSelection,
    lineStopBoard,
    stopEvents,
    addressedStopEvent,
  );
  const currentLineDatedJourneys = useDatedJourneyReadings(lineDeparturesAtStop, {
    selectedRowId: addressedStopEvent?.id,
  });
  const { boards: lineStopEventBoards, isReading: isReadingLine } = useLineStopEventBoards({
    selection: lineSelection,
    lines,
    stopId,
    shellBoards,
    stopEventBoard: lineStopBoard ?? stopEventBoard,
    currentLineDatedJourneys,
  });
  return {
    addressedStopEvent,
    lineStopEventBoards,
    lineDatedJourneyStopEvents: currentLineDatedJourneys,
    isReadingLine,
  };
}

/**
 * This stop's loaded dated journeys first, then the line-filtered boards along the line. The stop's
 * own dated journeys are loaded whole for the board beside the diagram and teach the crawl the
 * route.
 */
function useLineStopEventBoards({
  selection,
  lines,
  stopId,
  shellBoards,
  stopEventBoard,
  currentLineDatedJourneys,
}: {
  selection: LineSelection;
  lines: readonly TransitLine[];
  stopId: string;
  shellBoards: readonly StopEventBoard[];
  stopEventBoard: StopEventBoard | null;
  currentLineDatedJourneys: readonly StopEvent[];
}): LineObservationReading {
  // This stop's rows as whole journeys: complete sequences that teach the crawl from its first
  // round.
  const currentLineBoard = useMemo(
    () =>
      stopEventBoard && currentLineDatedJourneys.length > 0
        ? { ...stopEventBoard, stopEvents: currentLineDatedJourneys }
        : null,
    [currentLineDatedJourneys, stopEventBoard],
  );
  const evidenceBoards = useMemo(
    () => (currentLineBoard ? [...shellBoards, currentLineBoard] : shellBoards),
    [currentLineBoard, shellBoards],
  );
  const { boards, isReading } = useLineObservation({
    selection,
    lines,
    stopId,
    evidenceBoards,
    isEnabled: lines.length > 0,
  });
  return useMemo(
    () => ({
      boards: currentLineBoard ? [currentLineBoard, ...boards] : boards,
      isReading,
    }),
    [boards, currentLineBoard, isReading],
  );
}

/**
 * The selected line's departures worth loading as whole journeys: capped, but always the chosen
 * journey.
 */
function useLineDeparturesAtStop(
  selection: LineSelection,
  lineStopBoard: StopEventBoard | null,
  stopEvents: readonly StopEvent[],
  ownStopEvent: StopEvent | undefined,
): readonly StopEvent[] {
  // Until the filtered board answers, the rider's own rows stand in.
  const rows = lineStopBoard?.stopEvents ?? stopEvents;
  return useMemo(() => {
    if (!selection.lineId) return EMPTY_STOP_EVENTS;
    // The cap applies to the whole selection, not per line.
    const ofSelection = rows.filter((stopEvent) => isSelectedLine(selection, stopEvent));
    const loaded = ofSelection.slice(0, LINE_DATED_JOURNEY_LOAD_LIMIT);
    return ownStopEvent && !loaded.some(({ id }) => id === ownStopEvent.id)
      ? [ownStopEvent, ...loaded]
      : loaded;
  }, [selection, rows, ownStopEvent]);
}
