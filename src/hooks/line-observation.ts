import { useEffect, useMemo, useState } from "react";
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

const NO_OBSERVATIONS: LineObservations = new Map();
const EMPTY_STOP_IDS: readonly string[] = [];
const NO_ROUTES: ReadonlyMap<string, readonly string[]> = new Map();

/**
 * The routes the provider states for the selected lines, read once per line-direction.
 *
 * This is the one reading here that is not an observation. Everything else the crawl knows it
 * learned from trips that happened to be running, which is always less than the line — off-peak
 * every trip through a stop may turn back short, and the stretch past that turnback is then served
 * by nothing the crawl can see, so it is never read and nothing it would have disclosed is ever
 * learned. A route is published, so it states that stretch whether or not anything is on it now.
 *
 * It stays a *seed*: it decides where boards are read, never what is drawn. A stop of the route
 * that nothing calls at today contributes a board with no rows for the line and leaves the diagram
 * by itself, exactly as an observed stop that falls out of service does.
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
  const [state, setState] = useState<{
    routeStopIdsByLineId: ReadonlyMap<string, readonly string[]>;
    readDirectionIds: ReadonlySet<string>;
  }>({ routeStopIdsByLineId: NO_ROUTES, readDirectionIds: new Set() });

  useEffect(() => {
    let isCurrent = true;
    for (const { lineId, directionId, departureId } of requests) {
      // Asked once per direction and never again: a route does not move, and the source keeps it
      // for the session, so a re-render must not turn into a second request.
      if (state.readDirectionIds.has(directionId)) continue;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setState((current) => ({
        ...current,
        readDirectionIds: new Set(current.readDirectionIds).add(directionId),
      }));
      transitSource.getLineRoute(departureId).then((routeStopIds) => {
        if (!isCurrent || !routeStopIds?.length) return;
        setState((current) => {
          // The two directions of a line are one route: the first read states the order and the
          // opposite adds only what it does not already carry, which on a one-way loop is the half
          // of it no outbound run describes.
          const merged = [...(current.routeStopIdsByLineId.get(lineId) ?? [])];
          for (const stopId of routeStopIds) addOnce(merged, stopId);
          if (merged.length === (current.routeStopIdsByLineId.get(lineId)?.length ?? 0))
            return current;
          const routeStopIdsByLineId = new Map(current.routeStopIdsByLineId);
          routeStopIdsByLineId.set(lineId, merged);
          return { ...current, routeStopIdsByLineId };
        });
      });
    }
    return () => {
      isCurrent = false;
    };
  }, [requests, state.readDirectionIds]);

  return state.routeStopIdsByLineId;
}

/**
 * The `line` filter boards may be asked for, from the boards in hand alone.
 *
 * For a reading that keeps no knowledge of its own — the rider's own stop, which is read whether or
 * not anything is known about the line yet. Where it answers with nothing the board is read
 * unfiltered, which at that one stop costs almost nothing: it is the request the rider's own board
 * already made, and the source answers both from one reading.
 *
 * The boards behind it are the unfiltered ones the shell holds — the rider's stop and the network
 * observation — so what it cannot see is a direction that is named nowhere but along the line
 * itself. That stop then keeps the shorter horizon of a shared board while the crawl below, which
 * does see them, reads the rest of the line whole. It is the narrow case: an outlying line, read
 * at its own end, whose stop does not state the direction that only arrives there.
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

/** The crawl's answer: the boards it read, and whether it has answered for this route at all. */
export type LineObservationReading = {
  boards: readonly DepartureBoard[];
  /**
   * Whether the boards for the route as it is currently known are still outstanding.
   *
   * What it answers is not "is anything loading" but "could a reading still name something this
   * one has not": a trip that has left the rider's stop is on no board there and on one of these,
   * so a chain that drops the trip it was addressed with must wait for this to be false first.
   */
  isReading: boolean;
};

/**
 * The boards read for these lines alone, along the whole route discovery has reached.
 *
 * Where they are read and what they are asked for are both learned, and both only ever grow: every
 * answer may disclose another branch, another short working, or the direction a terminus lists no
 * row for. That makes this a fixed point — it settles on the pass where an answer adds no stop and
 * no direction — and it is stepped while rendering rather than in an effect, because the newly
 * discovered stops are read on the next pass and waiting a paint would show a diagram missing the
 * very branch its boards just disclosed.
 *
 * What the crawl knows is kept per line and remembered for the visit, so a line read again does not
 * start over from the trips that happen to be running this hour.
 */
export function useLineObservation({
  selection,
  lines,
  stopId,
  evidenceBoards,
  isEnabled = true,
}: {
  selection: LineSelection;
  /** The lines being read, for the core stops a line falls back to before any board is in hand. */
  lines: readonly TransitLine[];
  /** The rider's own stop, whose board is already in hand and is never requested twice. */
  stopId: string;
  /**
   * Everything read for these lines outside the crawl: the rider's board, the network observation,
   * and this stop's own trips. The crawl is taught by them before it asks for anything of its own,
   * so the first round already reads the route those trips describe.
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
  // The published route of each selected line, which the crawl is taught before its own boards and
  // before anything it could discover: it is the only statement of where the line goes that does
  // not depend on something running there right now.
  const routeStopIdsByLineId = useLineRoutes(selection, evidenceBoards, isEnabled);
  // What is known before this reading's own boards are asked for.
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
    // A round that could not name its filter reads a sample of the line rather than all of it: its
    // boards are whole stops, and it is there to learn the name, not to survey the route with the
    // heaviest reading there is. The filtered round that follows reads every stop.
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
  );

  const observations = useMemo(
    () => extendLineObservations(known, selection, boards),
    [boards, known, selection],
  );

  // Adjusted while rendering, which is the crawl's whole step: what these boards disclosed is what
  // the next pass reads. A line change starts the reading over under its own key.
  if (state.key !== key || observations !== state.observations) {
    setState({ key, observations });
  }

  // Written back where a later reading of the line can start from it — in an effect, because it is
  // for the next visit to this line and nothing in this one may depend on it having been written.
  useEffect(() => {
    for (const [lineId, observation] of state.observations) {
      rememberLineObservation(lineId, observation);
    }
  }, [state.observations]);

  return { boards, isReading: coverage.status === "loading" };
}
