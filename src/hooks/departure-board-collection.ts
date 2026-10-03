import { useMemo, useSyncExternalStore } from "react";
import type { DepartureBoard, DepartureBoardCoverage } from "../data/transit-types";
import {
  REACH_OBSERVATION_POST_STOP_IDS,
  ZENTRUM_OBSERVATION_POST_STOP_IDS,
  type ObservedNetwork,
} from "../lib/observed-network";
import { transitSource } from "../data/transit-source";
import { getDepartureBoardCoverage, isFailedBoard } from "../lib/departure-board-collection";
import { toSortedIds } from "../lib/collections";
import { useKeyedLoad, type KeyedLoadOptions } from "./keyed-load";
import { useLiveBoards } from "./run-reading-store";

/** Cadence for the boards a line's vehicles are found on; vehicles move real ground in 90 s. */
export const LINE_OBSERVATION_REFRESH_MS = 90_000;
/**
 * Cadence for the Zentrum posts. They only name which runs exist (marks come from the runs' own
 * re-reads), and service, lines and stop positions change slowly; each board is about 100 kB.
 */
export const ZENTRUM_OBSERVATION_REFRESH_MS = 5 * 60_000;
/** Cadence for the reach posts: which lines run today and where stops are, nearly static. */
export const REACH_OBSERVATION_REFRESH_MS = 20 * 60_000;
/** Cadence while nothing in view reads the observation; still re-read so a failed read recovers. */
export const IDLE_OBSERVATION_REFRESH_MS = 30 * 60_000;

const EMPTY_ROUTE_DIRECTION_IDS: readonly string[] = [];
const EMPTY_DEPARTURE_BOARDS: readonly DepartureBoard[] = [];

const hasFailedBoard = (boards: readonly DepartureBoard[]) => boards.some(isFailedBoard);

export type DepartureBoardCollection = {
  departureBoards: readonly DepartureBoard[];
  coverage: DepartureBoardCoverage;
};

/**
 * Several boards, each retained through short failures, plus how many posts answered the latest
 * refresh. Coverage counts raw answers, so retained data does not hide an outage.
 */
export function useDepartureBoardCollection(
  stopIds: readonly string[],
  refreshMs = ZENTRUM_OBSERVATION_REFRESH_MS,
  /**
   * Restrict to one line's directions, so the rows reach about ninety minutes of that line instead
   * of twenty of every line. Empty reads the whole stop.
   */
  routeDirectionIds: readonly string[] = EMPTY_ROUTE_DIRECTION_IDS,
  /** How stale the runs' own re-reads may be; unnamed, they keep the boards' freshness. */
  runMaxAgeMs?: number,
): DepartureBoardCollection {
  const sortedStopIds = useMemo(() => toSortedIds(stopIds), [stopIds]);
  const sortedDirectionIds = useMemo(() => toSortedIds(routeDirectionIds), [routeDirectionIds]);
  // A new cadence restarts the refresh chain but keeps the boards; a new key would blank them.
  const key =
    sortedStopIds.length > 0 ? `${sortedStopIds.join(",")}|${sortedDirectionIds.join(",")}` : null;
  const loadOptions = useMemo<KeyedLoadOptions<DepartureBoard[]>>(
    () => ({ refreshMs, isFailure: hasFailedBoard }),
    [refreshMs],
  );
  // A stop board asks for the trips behind its rows, since the network is observed from them. A
  // line's stops read rows, then each run once (`getLineDepartureBoards`), instead of one sequence
  // per stop. A board another view fetched within this cadence answers instead; the runs' first
  // read skips the trip cache, so a first paint is not placed from the previous visit's reading.
  const loaded = useKeyedLoad(
    key,
    (_key, isEntryRead) =>
      sortedDirectionIds.length > 0
        ? transitSource.getLineDepartureBoards(sortedStopIds, {
            routeDirectionIds: sortedDirectionIds,
            maxAgeMs: refreshMs,
            runMaxAgeMs: isEntryRead ? 0 : runMaxAgeMs,
          })
        : Promise.all(
            sortedStopIds.map((stopId) =>
              transitSource.getDepartureBoard(stopId, {
                includeTripCalls: true,
                maxAgeMs: refreshMs,
              }),
            ),
          ),
    loadOptions,
  );
  // Each post's failed refresh is already answered by its last live board (`refreshFailedAt`).
  const departureBoards = useLiveBoards(loaded ?? EMPTY_DEPARTURE_BOARDS);
  return { departureBoards, coverage: getDepartureBoardCoverage(sortedStopIds, loaded) };
}

/**
 * The network as the live feed describes it, read by the Zentrum view, the line list and the nearby
 * ranking. Two tiers merged into one observation: Zentrum posts (what runs in the centre) and reach
 * posts (which lines run and where stops are). `isEnabled: false` skips it all (an unattended
 * board); `isInView` slows the Zentrum posts when nothing in view reads them.
 */
export function useZentrumNetwork({ isEnabled = true, isInView = true } = {}): {
  network: ObservedNetwork;
  departureBoards: readonly DepartureBoard[];
  coverage: DepartureBoardCoverage;
} {
  const { departureBoards: zentrumBoards, coverage } = useDepartureBoardCollection(
    isEnabled ? ZENTRUM_OBSERVATION_POST_STOP_IDS : [],
    isInView ? ZENTRUM_OBSERVATION_REFRESH_MS : IDLE_OBSERVATION_REFRESH_MS,
  );
  // Reach posts run on their slow clock regardless: boards and the nearby ranking need lines and
  // positions too.
  const { departureBoards: reachBoards } = useDepartureBoardCollection(
    isEnabled ? REACH_OBSERVATION_POST_STOP_IDS : [],
    REACH_OBSERVATION_REFRESH_MS,
  );
  const departureBoards = useMemo(
    () => [...zentrumBoards, ...reachBoards],
    [zentrumBoards, reachBoards],
  );
  // Network knowledge is session state in the source's store, fed by every board from every view.
  const network = useSyncExternalStore(
    (listener) => transitSource.subscribeToObservedNetwork(listener),
    () => transitSource.getObservedNetwork(),
    () => transitSource.getObservedNetwork(),
  );
  // Coverage counts Zentrum posts only: a missing reach post does not shorten the list in view.
  return { network, departureBoards, coverage };
}
