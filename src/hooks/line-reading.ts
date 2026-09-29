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

/**
 * How many of a line's departures at this stop are loaded as whole trips. Enough to mark the
 * vehicles a rider can still reach; past that a board lists trips nobody in front of it is waiting
 * for, and each one is a request of its own.
 */
const LINE_RUN_LOAD_LIMIT = 6;

/** What reading a selected line at one stop produces. */
export type LineReading = {
  /** The addressed run as this stop states it, on either the shared or the line-filtered board. */
  addressedDeparture: Departure | undefined;
  /** This stop's line runs, plus the line-filtered boards read along the whole line. */
  lineDepartureBoards: readonly DepartureBoard[];
  /** Whole-run readings for the selected line at this stop. */
  lineRunDepartures: readonly Departure[];
  /** Whether boards that could still name the addressed run are outstanding. */
  isReadingLine: boolean;
};

/**
 * Everything read for the selected line: the stop's own board filtered to the line, its nearest runs
 * read whole, and the boards along the line. With no line selected it reads nothing.
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
  // The boards the shell already holds: the rider's own, which describes their whole stop, and the
  // network observation. Both are read unfiltered, so between them they name the line-directions
  // that decide what every board below may be asked for.
  const shellBoards = useMemo(
    () => (departureBoard ? [departureBoard, ...observationBoards] : observationBoards),
    [departureBoard, observationBoards],
  );
  const stopFilterDirectionIds = useLineFilterDirectionIds(lineSelection, shellBoards);
  // The board the rider reads is the whole stop and reaches minutes; this one is the same stop asked
  // for this line alone and reaches most of an hour. The line's own vehicles are found in it.
  const lineStopBoard = useLineStopBoard(
    lineSelection.lineId ? stopId : undefined,
    stopFilterDirectionIds,
  );
  // The addressed run as this stop states it, on either reading of this stop.
  //
  // The shared board is not the only one: read for the line alone the same stop reaches most of an
  // hour where the shared board reaches minutes, and at a busy stop — a dozen lines and twenty rows
  // between them — the run a rider addressed is very often on that reading and on no other. It is
  // the same stop's own row either way, and looking for it only on the board a rider happens to be
  // shown left a shared link to a trip at the Hauptbahnhof with nothing to resolve.
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
 * This stop's individually loaded same-line runs first, then the boards read for this line alone.
 *
 * Every discovered calling point is read, and each board is filtered to this line — where both of
 * its directions are known — rather than spending its rows on every service at the stop. The stop
 * in view is different: its rows are also loaded individually so the board beside the diagram can
 * present their complete routes, and they are what the crawl learns this line's route from.
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
  // This stop's rows, read as whole runs. They are the richest thing the crawl is ever taught — a
  // complete calling sequence each — so the route it reads is theirs from its very first round.
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
    const loaded = ofSelection.slice(0, LINE_RUN_LOAD_LIMIT);
    return stopDeparture && !loaded.some(({ id }) => id === stopDeparture.id)
      ? [stopDeparture, ...loaded]
      : loaded;
  }, [selection, rows, stopDeparture]);
}
