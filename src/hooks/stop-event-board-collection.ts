import { useMemo, useSyncExternalStore } from "react";
import type { StopEventBoard, StopEventBoardCoverage } from "../data/transit-types";
import {
  REACH_OBSERVATION_POST_STOP_IDS,
  ZENTRUM_OBSERVATION_POST_STOP_IDS,
  type ObservedNetwork,
} from "../lib/observed-network";
import { transitSource } from "../data/transit-source";
import {
  getBoardsFailureKind,
  getStopEventBoardCoverage,
} from "../lib/stop-event-board-collection";
import { toSortedIds } from "../lib/collections";
import { useKeyedLoad, type KeyedLoadOptions } from "./keyed-load";
import { useLiveBoards } from "./dated-journey-reading-store";

/** Cadence for the boards a line's vehicles are found on; vehicles move real ground in 90 s. */
export const LINE_OBSERVATION_REFRESH_MS = 90_000;
/**
 * Cadence for the Zentrum posts. They only name which dated journeys exist (marks come from the
 * dated journeys' own re-reads), and service, lines and stop positions change slowly; each board is
 * about 100 kB.
 */
export const ZENTRUM_OBSERVATION_REFRESH_MS = 5 * 60_000;
/** Cadence for the reach posts: which lines run today and where stops are, nearly static. */
export const REACH_OBSERVATION_REFRESH_MS = 20 * 60_000;
/** Cadence while nothing in view reads the observation; still re-read so a failed read recovers. */
export const IDLE_OBSERVATION_REFRESH_MS = 30 * 60_000;

const EMPTY_LINE_REFS: readonly string[] = [];
const EMPTY_STOP_EVENT_BOARDS: readonly StopEventBoard[] = [];

export type StopEventBoardCollection = {
  stopEventBoards: readonly StopEventBoard[];
  coverage: StopEventBoardCoverage;
};

/**
 * Several boards, each retained through short failures, plus how many posts answered the latest
 * refresh. Coverage counts raw answers, so retained data does not hide an outage.
 */
export function useStopEventBoardCollection(
  stopIds: readonly string[],
  refreshMs = ZENTRUM_OBSERVATION_REFRESH_MS,
  /**
   * Restrict to one line's directions, so the rows reach about ninety minutes of that line instead
   * of twenty of every line. Empty reads the whole stop.
   */
  lineRefs: readonly string[] = EMPTY_LINE_REFS,
  /**
   * How stale the dated journeys' own re-reads may be; unnamed, they keep the boards' freshness.
   */
  datedJourneyMaxAgeMs?: number,
): StopEventBoardCollection {
  const sortedStopIds = useMemo(() => toSortedIds(stopIds), [stopIds]);
  const sortedLineRefs = useMemo(() => toSortedIds(lineRefs), [lineRefs]);
  // A new cadence restarts the refresh chain but keeps the boards; a new key would blank them.
  const key =
    sortedStopIds.length > 0 ? `${sortedStopIds.join(",")}|${sortedLineRefs.join(",")}` : null;
  const loadOptions = useMemo<KeyedLoadOptions<StopEventBoard[]>>(
    () => ({ refreshMs, getFailureKind: getBoardsFailureKind }),
    [refreshMs],
  );
  // A stop board asks for the journeys behind its rows, since the network is observed from them. A
  // line's stops read rows, then each dated journey once (`getLineStopEventBoards`), instead of one
  // sequence per stop. A board another view fetched within this cadence answers instead; the dated
  // journeys' first read skips the journey cache, so a first paint is not placed from the previous
  // visit's reading.
  const loaded = useKeyedLoad(
    key,
    (_key, isEntryRead) =>
      sortedLineRefs.length > 0
        ? transitSource.getLineStopEventBoards(sortedStopIds, {
            lineRefs: sortedLineRefs,
            maxAgeMs: refreshMs,
            datedJourneyMaxAgeMs: isEntryRead ? 0 : datedJourneyMaxAgeMs,
          })
        : Promise.all(
            sortedStopIds.map((stopId) =>
              transitSource.getStopEventBoard(stopId, {
                includeCalls: true,
                maxAgeMs: refreshMs,
              }),
            ),
          ),
    loadOptions,
  );
  // Each post's failed refresh is already answered by its last live board (`refreshFailedAt`).
  const stopEventBoards = useLiveBoards(loaded ?? EMPTY_STOP_EVENT_BOARDS);
  return { stopEventBoards, coverage: getStopEventBoardCoverage(sortedStopIds, loaded) };
}

/**
 * The network as the live feed describes it, read by the Zentrum view, the line list and the nearby
 * ranking. Two tiers merged into one observation: Zentrum posts (what runs in the centre) and reach
 * posts (which lines run and where stops are). `isEnabled: false` skips it all (an unattended
 * board, or no view has needed it yet); `isInView` slows the Zentrum posts when nothing in view
 * reads them.
 */
export function useZentrumNetwork({ isEnabled = true, isInView = true } = {}): {
  network: ObservedNetwork;
  stopEventBoards: readonly StopEventBoard[];
  coverage: StopEventBoardCoverage;
} {
  const { stopEventBoards: zentrumBoards, coverage } = useStopEventBoardCollection(
    isEnabled ? ZENTRUM_OBSERVATION_POST_STOP_IDS : [],
    isInView ? ZENTRUM_OBSERVATION_REFRESH_MS : IDLE_OBSERVATION_REFRESH_MS,
  );
  // Reach posts run on their slow clock regardless: boards and the nearby ranking need lines and
  // positions too.
  const { stopEventBoards: reachBoards } = useStopEventBoardCollection(
    isEnabled ? REACH_OBSERVATION_POST_STOP_IDS : [],
    REACH_OBSERVATION_REFRESH_MS,
  );
  const stopEventBoards = useMemo(
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
  return { network, stopEventBoards, coverage };
}
