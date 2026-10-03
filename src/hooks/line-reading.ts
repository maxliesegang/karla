import { useMemo } from "react";
import type { Departure, DepartureBoard, TransitLine } from "../data/transit-types";
import { isSelectedLine, type LineSelection } from "../lib/line-bundles";
import { findDepartureByAddressId } from "../routing";
import { useLineStopBoard } from "./departure-board";
import {
  useLineFilterDirectionIds,
  useLineObservation,
  type LineObservationReading,
} from "./line-observation";
import { useRunReadings } from "./run-reading-loader";

const EMPTY_DEPARTURES: readonly Departure[] = [];

/** A line's departures at this stop loaded as whole trips: enough for the reachable vehicles. */
const LINE_RUN_LOAD_LIMIT = 6;

/** What reading a selected line at one stop produces. */
export type LineReading = {
  /** The addressed run as this stop states it, on the shared or the line-filtered board. */
  addressedDeparture: Departure | undefined;
  /** This stop's line runs, plus the line-filtered boards read along the whole line. */
  lineDepartureBoards: readonly DepartureBoard[];
  /** Whole-run readings for the selected line at this stop. */
  lineRunDepartures: readonly Departure[];
  /** Whether boards that could still name the addressed run are outstanding. */
  isReadingLine: boolean;
};

/**
 * Everything read for the selected line: the stop's board filtered to it, its nearest runs read
 * whole, and the boards along the line. Nothing without a selected line.
 */
export function useLineReading({
  stopId,
  addressId,
  lineSelection,
  lines,
  departureBoard,
  observationBoards,
  stopDeparture,
}: {
  stopId: string;
  addressId: string | undefined;
  lineSelection: LineSelection;
  lines: readonly TransitLine[];
  /** The rider's own, unfiltered board. */
  departureBoard: DepartureBoard | null;
  observationBoards: readonly DepartureBoard[];
  /** The addressed run as the rider's own board lists it, where it does. */
  stopDeparture: Departure | undefined;
}): LineReading {
  const departures = departureBoard?.departures ?? EMPTY_DEPARTURES;
  // The shell's unfiltered boards (rider's stop, network observation) name the line-directions that
  // decide every filter below.
  const shellBoards = useMemo(
    () => (departureBoard ? [departureBoard, ...observationBoards] : observationBoards),
    [departureBoard, observationBoards],
  );
  const stopFilterDirectionIds = useLineFilterDirectionIds(lineSelection, shellBoards);
  // This stop filtered to the line, reaching most of an hour instead of minutes.
  const lineStopBoard = useLineStopBoard(
    lineSelection.lineId ? stopId : undefined,
    stopFilterDirectionIds,
  );
  // Looked for on both readings of this stop: at a busy stop the addressed run is often only on the
  // filtered one.
  const addressedDeparture =
    stopDeparture ??
    findDepartureByAddressId(lineStopBoard?.departures ?? EMPTY_DEPARTURES, addressId);
  const lineDeparturesAtStop = useLineDeparturesAtStop(
    lineSelection,
    lineStopBoard,
    departures,
    addressedDeparture,
  );
  const currentLineRuns = useRunReadings(lineDeparturesAtStop, {
    selectedRowId: addressedDeparture?.id,
  });
  const { boards: lineDepartureBoards, isReading: isReadingLine } = useLineDepartureBoards({
    selection: lineSelection,
    lines,
    stopId,
    shellBoards,
    departureBoard: lineStopBoard ?? departureBoard,
    currentLineRuns,
  });
  return {
    addressedDeparture,
    lineDepartureBoards,
    lineRunDepartures: currentLineRuns,
    isReadingLine,
  };
}

/**
 * This stop's loaded runs first, then the line-filtered boards along the line. The stop's own runs
 * are loaded whole for the board beside the diagram and teach the crawl the route.
 */
function useLineDepartureBoards({
  selection,
  lines,
  stopId,
  shellBoards,
  departureBoard,
  currentLineRuns,
}: {
  selection: LineSelection;
  lines: readonly TransitLine[];
  stopId: string;
  shellBoards: readonly DepartureBoard[];
  departureBoard: DepartureBoard | null;
  currentLineRuns: readonly Departure[];
}): LineObservationReading {
  // This stop's rows as whole runs: complete sequences that teach the crawl from its first round.
  const currentLineBoard = useMemo(
    () =>
      departureBoard && currentLineRuns.length > 0
        ? { ...departureBoard, departures: currentLineRuns }
        : null,
    [currentLineRuns, departureBoard],
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
 * The selected line's departures worth loading as whole trips: capped, but always the chosen trip.
 */
function useLineDeparturesAtStop(
  selection: LineSelection,
  lineStopBoard: DepartureBoard | null,
  departures: readonly Departure[],
  stopDeparture: Departure | undefined,
): readonly Departure[] {
  // Until the filtered board answers, the rider's own rows stand in.
  const rows = lineStopBoard?.departures ?? departures;
  return useMemo(() => {
    if (!selection.lineId) return EMPTY_DEPARTURES;
    // The cap applies to the whole selection, not per line.
    const ofSelection = rows.filter((departure) => isSelectedLine(selection, departure.lineId));
    const loaded = ofSelection.slice(0, LINE_RUN_LOAD_LIMIT);
    return stopDeparture && !loaded.some(({ id }) => id === stopDeparture.id)
      ? [stopDeparture, ...loaded]
      : loaded;
  }, [selection, rows, stopDeparture]);
}
