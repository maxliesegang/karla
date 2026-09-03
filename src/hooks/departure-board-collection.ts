import { useMemo, useState } from "react";
import type { DepartureBoard, DepartureBoardCoverage } from "../data/transit-types";
import {
  buildObservedNetwork,
  REACH_OBSERVATION_POST_STOP_IDS,
  ZENTRUM_OBSERVATION_POST_STOP_IDS,
  type ObservedNetwork,
} from "../lib/observed-network";
import {
  buildRetainedDepartureBoards,
  getDepartureBoardCoverage,
} from "../lib/departure-board-collection";
import { createSortedKey } from "../lib/collections";
import { createDepartureBoardsLoader } from "./departure-board";
import { useKeyedLoad, type KeyedLoadOptions } from "./keyed-load";

/**
 * The cadence for the boards that place a line's vehicles.
 *
 * These are the one observation that is still a countdown of sorts: a mark drawn from a board is
 * drawn where that board said the vehicle was, and a vehicle covers real ground in ninety seconds.
 * Nothing else read here moves that fast.
 */
export const LINE_OBSERVATION_REFRESH_MS = 90_000;
/**
 * The cadence for the posts the Zentrum list is read from.
 *
 * This used to be ninety seconds, which was the cadence of a view that read its vehicle marks from
 * these boards. It no longer does — a diagram takes its own filtered boards along the line, and a
 * rider's own stop fetches its own board — so what is actually left resting on this observation is
 * which stops have service, which lines call there, where the stops are, and the signs a badge is
 * drawn from. None of that is a countdown, and none of it becomes wrong in ninety seconds.
 *
 * Five minutes, then, because a stop that stops being served or a line that stops running is worth
 * noticing inside the visit that follows it, and because these boards are a hundred kilobytes each
 * and a rider reading a departure is already paying for one of their own.
 */
export const ZENTRUM_OBSERVATION_REFRESH_MS = 5 * 60_000;
/**
 * The cadence for the posts the rest of the network is read from.
 *
 * These answer a question that is nearly static: which lines the operator is running today, and
 * where the stops of the network are. A line does not appear or vanish between two refreshes of
 * anything, and a stop does not move. Twenty minutes is chosen so that the five of them together
 * cost less over an hour than one post did at the old cadence.
 */
export const REACH_OBSERVATION_REFRESH_MS = 20 * 60_000;
/**
 * The cadence for the observation while nothing in view is read from it.
 *
 * On a stop's own board the observed network supplies line signs, stop positions and the search
 * list — none of which change while a rider reads a departure. It is still re-read rather than read
 * once, because a first reading that failed has to be able to recover.
 */
export const IDLE_OBSERVATION_REFRESH_MS = 30 * 60_000;

const EMPTY_LINE_IDS: readonly string[] = [];
const EMPTY_DEPARTURE_BOARDS: readonly DepartureBoard[] = [];

const hasUnavailableBoard = (boards: readonly DepartureBoard[]) =>
  boards.some((board) => board.dataStatus === "unavailable");

export type DepartureBoardCollection = {
  departureBoards: readonly DepartureBoard[];
  coverage: DepartureBoardCoverage;
};

/**
 * Loads several stops' boards at once. Each board carries the whole trip behind every departure, so
 * a handful of well-placed boards describes the entire Zentrum — the stops, the track between them,
 * and the vehicles on it. Requests are deduplicated and cached by the source, so a shared stop
 * costs nothing.
 */
export function useDepartureBoards(
  stopIds: readonly string[],
  refreshMs = ZENTRUM_OBSERVATION_REFRESH_MS,
  lineIds: readonly string[] = EMPTY_LINE_IDS,
): readonly DepartureBoard[] {
  return useDepartureBoardCollection(stopIds, refreshMs, lineIds).departureBoards;
}

/**
 * Several boards retained independently, plus how many observation posts answered this refresh.
 *
 * The retained boards keep the observed network still through a short provider failure. Coverage
 * deliberately describes the raw refresh instead: old usable data must not turn an outage into a
 * claim that every post is currently readable.
 */
export function useDepartureBoardCollection(
  stopIds: readonly string[],
  /** Boards nobody is reading directly are worth a slower cadence than the one in front of a rider. */
  refreshMs = ZENTRUM_OBSERVATION_REFRESH_MS,
  /**
   * Restrict these boards to one line's directions. A stop's rows are shared by every line calling
   * there, so an unfiltered board reaches about twenty minutes; asked for one line the same rows
   * reach an hour and a half, which is the difference between seeing a vehicle at the end of its
   * run and not seeing it at all. Empty reads the whole stop, as the Zentrum observation does.
   */
  lineIds: readonly string[] = EMPTY_LINE_IDS,
): DepartureBoardCollection {
  const stopKey = createSortedKey(stopIds);
  const lineKey = createSortedKey(lineIds);
  const key = lineKey ? `${stopKey}|${lineKey}` : stopKey;
  const loadOptions = useMemo<KeyedLoadOptions<DepartureBoard[]>>(
    () => ({ refreshMs, isFailure: hasUnavailableBoard }),
    [refreshMs],
  );
  // An observation of the whole stop carries its trips, because the trips are what the network is
  // read from; a reading of one line takes its rows here and its runs from the trip endpoint (see
  // `createDepartureBoardsLoader`). A board another view fetched within this cadence answers
  // instead of a request of its own.
  const load = useMemo(
    () => createDepartureBoardsLoader({ includeTripCalls: true, maxAgeMs: refreshMs }),
    [refreshMs],
  );
  const loaded = useKeyedLoad(stopKey ? key : null, load, loadOptions);
  const orderedStopIds = stopKey ? stopKey.split(",") : [];
  const [retention, setRetention] = useState<{
    key: string;
    loaded: readonly DepartureBoard[] | undefined | null;
    departureBoards: readonly DepartureBoard[];
    liveBoardByStopId: Map<string, DepartureBoard>;
  }>({ key, loaded: null, departureBoards: EMPTY_DEPARTURE_BOARDS, liveBoardByStopId: new Map() });

  let currentRetention = retention;
  if (retention.key !== key || retention.loaded !== loaded) {
    const previousLiveBoardByStopId =
      retention.key === key ? retention.liveBoardByStopId : new Map();
    const { departureBoards, liveBoardByStopId } = buildRetainedDepartureBoards(
      orderedStopIds,
      loaded,
      previousLiveBoardByStopId,
    );
    currentRetention = { key, loaded, departureBoards, liveBoardByStopId };
    setRetention(currentRetention);
  }

  return {
    departureBoards: loaded === null ? EMPTY_DEPARTURE_BOARDS : currentRetention.departureBoards,
    coverage: getDepartureBoardCoverage(orderedStopIds, loaded),
  };
}

/**
 * The network as the live feed currently describes it. The Zentrum view, the app's line list and
 * the nearby ranking all read from this, and the source caches the underlying boards, so asking
 * twice costs one set of requests.
 *
 * Two tiers on two cadences, because two different questions are being asked. The Zentrum posts
 * answer what is running in the middle of the city, which a rider is looking at; the reach posts
 * answer what the network is — the lines running today and where their stops are — which holds for
 * hours. Merging them here rather than at the call sites means every view keeps seeing one
 * observation, however many clocks it was read on.
 *
 * `isEnabled` is how a view that needs none of it — an unattended board showing one stop — avoids
 * the requests for the rest of the day. `isInView` tells the Zentrum list and the nearby ranking,
 * which are read from this observation, apart from the line signs a stop's own board borrows from
 * it, which hold for hours.
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
  // The reach posts are read on their own slow clock whether or not the Zentrum is in view: what
  // they answer is the line list and the stop positions, which a board and a nearby ranking use
  // just as much as the Zentrum list does.
  const { departureBoards: reachBoards } = useDepartureBoardCollection(
    isEnabled ? REACH_OBSERVATION_POST_STOP_IDS : [],
    REACH_OBSERVATION_REFRESH_MS,
  );
  const departureBoards = useMemo(
    () => [...zentrumBoards, ...reachBoards],
    [zentrumBoards, reachBoards],
  );
  const network = useMemo(() => buildObservedNetwork(departureBoards), [departureBoards]);
  // Coverage states the Zentrum posts alone. It is what the view says out loud — "teilweise
  // erreichbar", and the Zentrum list's own empty state — and a reach post that did not answer is
  // not evidence that the list in front of the rider is short: it contributes lines and positions,
  // not the rows of the Zentrum. Counting it here would report an outage the rider cannot see.
  return { network, departureBoards, coverage };
}
