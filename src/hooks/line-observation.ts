import { useEffect, useMemo, useRef, useState } from "react";
import type { DepartureBoard, TransitLine } from "../data/transit-types";
import { recallLineObservation, rememberLineObservation } from "../data/line-observation-memory";
import { transitSource } from "../data/transit-source";
import { addOnce } from "../lib/collections";
import {
  extendLineObservationRoutes,
  extendLineObservations,
  getLineFilterDirectionIds,
  getLineObservationStopIds,
  getLineObservationsStopIds,
  getLineRouteRequests,
  MAX_LINE_OBSERVATION_STOPS,
  MAX_UNFILTERED_LINE_OBSERVATION_STOPS,
  sampleLineObservationStopIds,
  seedLineObservations,
  type LineObservationBoard,
  type LineObservations,
} from "../lib/line-observation";
import { getLineSelectionIds, type LineSelection } from "../lib/line-bundles";
import {
  LINE_OBSERVATION_REFRESH_MS,
  useDepartureBoardCollection,
} from "./departure-board-collection";
import { LINE_RUN_READING_MAX_AGE_MS } from "./run-reading-loader";

const NO_OBSERVATIONS: LineObservations = new Map();
const EMPTY_STOP_IDS: readonly string[] = [];
const NO_ROUTES: ReadonlyMap<string, readonly string[]> = new Map();

/**
 * The published routes of the selected lines, once per line-direction. A seed for where boards are
 * read (off-peak trips may not cover the whole line), never for what is drawn.
 */
export function useLineRoutes(
  selection: LineSelection,
  boards: readonly LineObservationBoard[],
  isEnabled = true,
): ReadonlyMap<string, readonly string[]> {
  const requests = useMemo(
    () => (isEnabled ? getLineRouteRequests(selection, boards) : []),
    [boards, isEnabled, selection],
  );
  const [routeStopIdsByLineId, setRouteStopIdsByLineId] = useState(NO_ROUTES);
  // Once per direction; the source keeps routes for the session.
  const askedDirectionIds = useRef(new Set<string>());

  useEffect(() => {
    for (const { lineId, directionId, rowId } of requests) {
      if (askedDirectionIds.current.has(directionId)) continue;
      askedDirectionIds.current.add(directionId);
      transitSource.getLineRoute(rowId).then((routeStopIds) => {
        // Asked again with the next boards.
        if (routeStopIds === undefined) askedDirectionIds.current.delete(directionId);
        if (!routeStopIds?.length) return;
        setRouteStopIdsByLineId((current) => {
          // The second direction adds only stops the first lacks (the other half of a one-way
          // loop).
          const known = current.get(lineId) ?? [];
          const merged = [...known];
          for (const stopId of routeStopIds) addOnce(merged, stopId);
          if (merged.length === known.length) return current;
          return new Map(current).set(lineId, merged);
        });
      });
    }
  }, [requests]);

  return routeStopIdsByLineId;
}

/**
 * The `line` filter from the boards in hand alone, for the rider's own stop. Without one the board
 * is read unfiltered, which the source answers from the rider's existing board.
 */
export function useLineFilterDirectionIds(
  selection: LineSelection,
  boards: readonly LineObservationBoard[],
): readonly string[] {
  return useMemo(
    () =>
      getLineFilterDirectionIds(
        extendLineObservations(NO_OBSERVATIONS, selection, boards),
        selection,
      ),
    [boards, selection],
  );
}

/** The crawl's boards, and whether it has answered for this route. */
export type LineObservationReading = {
  boards: readonly DepartureBoard[];
  /**
   * Whether boards for the route as known are still outstanding: whether a reading could still name
   * a trip that left the rider's stop.
   */
  isReading: boolean;
};

/**
 * The boards read for these lines along the route discovered so far. Stops and directions only
 * grow, so it settles at a fixed point; stepped during render so newly found stops are read on the
 * next pass. Knowledge is kept per line for the visit.
 */
export function useLineObservation({
  selection,
  lines,
  stopId,
  evidenceBoards,
  isEnabled = true,
}: {
  selection: LineSelection;
  /** The lines read, for their core-stop fallback. */
  lines: readonly TransitLine[];
  /** The rider's stop, whose board is in hand and never requested twice. */
  stopId: string;
  /**
   * Boards read outside the crawl (rider's board, network observation, this stop's trips), learned
   * first.
   */
  evidenceBoards: readonly LineObservationBoard[];
  isEnabled?: boolean;
}): LineObservationReading {
  const key = getLineSelectionIds(selection).slice().sort().join(",");
  const [state, setState] = useState<{ key: string; observations: LineObservations }>(() => ({
    key,
    observations: seedLineObservations(selection, lines, recallLineObservation),
  }));
  const seeded =
    state.key === key
      ? state.observations
      : seedLineObservations(selection, lines, recallLineObservation);
  // The published route, learned before any of the crawl's own boards.
  const routeStopIdsByLineId = useLineRoutes(selection, evidenceBoards, isEnabled);
  const known = useMemo(
    () =>
      extendLineObservationRoutes(
        extendLineObservations(seeded, selection, evidenceBoards),
        selection,
        routeStopIdsByLineId,
      ),
    [evidenceBoards, routeStopIdsByLineId, seeded, selection],
  );
  const stopIds = useMemo(() => getLineObservationsStopIds(known, selection), [known, selection]);
  const filterDirectionIds = useMemo(
    () => getLineFilterDirectionIds(known, selection),
    [known, selection],
  );
  const observationStopIds = useMemo(() => {
    if (!isEnabled) return EMPTY_STOP_IDS;
    const readable = getLineObservationStopIds(stopIds, stopId);
    // A round without a filter reads a sample: it reads whole stops, to learn the filter.
    return sampleLineObservationStopIds(
      readable,
      filterDirectionIds.length > 0
        ? MAX_LINE_OBSERVATION_STOPS
        : MAX_UNFILTERED_LINE_OBSERVATION_STOPS,
    );
  }, [filterDirectionIds, isEnabled, stopIds, stopId]);
  const { departureBoards: boards, coverage } = useDepartureBoardCollection(
    observationStopIds,
    LINE_OBSERVATION_REFRESH_MS,
    filterDirectionIds,
    LINE_RUN_READING_MAX_AGE_MS,
  );

  const observations = useMemo(
    () => extendLineObservations(known, selection, boards),
    [boards, known, selection],
  );

  // Stepped during render; a line change starts over under its key.
  if (state.key !== key || observations !== state.observations) {
    setState({ key, observations });
  }

  // Stored for the next visit, so in an effect.
  useEffect(() => {
    for (const [lineId, observation] of state.observations) {
      rememberLineObservation(lineId, observation);
    }
  }, [state.observations]);

  return { boards, isReading: coverage.status === "loading" };
}
