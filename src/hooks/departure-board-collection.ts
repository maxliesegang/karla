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
 * No vehicle mark is placed from these boards: the line diagram reads its own filtered boards, a
 * rider's stop fetches its own board, and the Zentrum map places its marks from the runs' own
 * re-reads (`useZentrumVehicles`). These boards only name which runs exist, so what rests on this
 * observation is which stops have service, which lines call there, where the stops are, and the
 * signs a badge is drawn from. None of that is a countdown, and none of it becomes wrong in ninety
 * seconds.
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
 * anything, and a stop does not move. At twenty minutes the five of them together cost less over an
 * hour than one post read every ninety seconds.
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

const EMPTY_ROUTE_DIRECTION_IDS: readonly string[] = [];
const EMPTY_DEPARTURE_BOARDS: readonly DepartureBoard[] = [];

const hasFailedBoard = (boards: readonly DepartureBoard[]) => boards.some(isFailedBoard);

export type DepartureBoardCollection = {
  departureBoards: readonly DepartureBoard[];
  coverage: DepartureBoardCoverage;
};

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
  routeDirectionIds: readonly string[] = EMPTY_ROUTE_DIRECTION_IDS,
  /**
   * How stale the runs' own re-reads may be. A line's boards are read as rows, and the runs out on
   * it are read as calls on a clock of their own; the boards name which runs exist, the calls are
   * what places the vehicles. With none named, the runs keep the boards' freshness.
   */
  runMaxAgeMs?: number,
): DepartureBoardCollection {
  const sortedStopIds = useMemo(() => toSortedIds(stopIds), [stopIds]);
  const sortedDirectionIds = useMemo(() => toSortedIds(routeDirectionIds), [routeDirectionIds]);
  // What is read, not how often: a new cadence restarts the refresh chain but keeps the boards in
  // hand, where a new key would blank them until it answered.
  const key =
    sortedStopIds.length > 0 ? `${sortedStopIds.join(",")}|${sortedDirectionIds.join(",")}` : null;
  const loadOptions = useMemo<KeyedLoadOptions<DepartureBoard[]>>(
    () => ({ refreshMs, isFailure: hasFailedBoard }),
    [refreshMs],
  );
  // Two different readings. A stop's board is asked for the trips behind its rows, because those
  // trips are what the network is observed from and nothing else will state them. A line's stops
  // are not read that way: the same run is listed at every stop it has yet to leave, so asking each
  // board for it again transfers one calling sequence fifteen times to learn it once.
  // `getLineDepartureBoards` reads the rows and then the trips — see `transit-source.ts`.
  //
  // A board another view fetched within this cadence answers instead of a request of its own. The
  // runs' entry read looks past the trip cache all the same: the boards name which runs exist and
  // the runs are what place the marks, so a diagram's first paint is placed from whatever reading
  // the previous visit left unless the source is asked for a fresh one.
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
  // Network knowledge belongs to the session, not to these two view-owned request cycles. Every
  // live board passes through the source's observed-network store, including boards read by other
  // views, and this subscription survives either collection being disabled or re-keyed.
  const network = useSyncExternalStore(
    (listener) => transitSource.subscribeToObservedNetwork(listener),
    () => transitSource.getObservedNetwork(),
    () => transitSource.getObservedNetwork(),
  );
  // Coverage states the Zentrum posts alone. It is what the view says out loud — "teilweise
  // erreichbar", and the Zentrum list's own empty state — and a reach post that did not answer is
  // not evidence that the list in front of the rider is short: it contributes lines and positions,
  // not the rows of the Zentrum. Counting it here would report an outage the rider cannot see.
  return { network, departureBoards, coverage };
}
