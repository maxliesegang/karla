import { useState } from "react";
import { transitSource, type DepartureBoardRequest } from "../data/transit-source";
import type { DepartureBoard, ServiceNoticeBoard } from "../data/transit-types";
import { RETAINED_BOARD_LIMIT_MS } from "../lib/departure-board-collection";
import { createSortedKey } from "../lib/collections";
import { useKeyedLoad, type KeyedLoadOptions } from "./use-keyed-load";

/** The board is re-read often enough that countdowns stay believable without churning. */
export const BOARD_REFRESH_MS = 30_000;
/** Route relationships change slowly; the live countdown board remains on its 30-second cadence. */
const STOP_TOPOLOGY_REFRESH_MS = 30 * 60_000;
/** Notices are written by hand and published for weeks; asking often would only cost the rider data. */
const SERVICE_NOTICE_REFRESH_MS = 15 * 60_000;

const createDepartureBoardLoader = (request: DepartureBoardRequest) => (stopId: string) =>
  transitSource.getDepartureBoard(stopId, request);

/**
 * The key that names stops and, optionally, line ids: `stopIds|lineIds`. Stop slugs and provider
 * direction ids contain neither separator.
 */
const parseStopLineKey = (key: string): { stopKey: string; lineKey: string } => {
  const [stopKey = "", lineKey = ""] = key.split("|");
  return { stopKey, lineKey };
};

/** One stop's board restricted to one line's directions; the key is `stopId|directionIds`. */
const loadLineStopBoard = (key: string) => {
  const { stopKey: stopId, lineKey } = parseStopLineKey(key);
  return transitSource.getDepartureBoard(stopId, lineKey ? { lineIds: lineKey.split(",") } : {});
};

/**
 * Several stops at once, keyed by the joined ids `useKeyedLoad` addresses them under, optionally
 * with a line filter after a `|`.
 */
export const createDepartureBoardsLoader = (request: DepartureBoardRequest) => (key: string) => {
  const { stopKey, lineKey } = parseStopLineKey(key);
  const lineIds = lineKey ? lineKey.split(",") : undefined;
  const loadOne = createDepartureBoardLoader(lineIds ? { ...request, lineIds } : request);
  return Promise.all(stopKey.split(",").map(loadOne));
};

/**
 * What every direction calling at the stop has to contribute before the board is complete.
 *
 * Three, which is the same reading the line order gives a direction it can see: the next departure
 * says the direction still runs from here, and the two behind it say how long the wait is if this
 * one is missed and how often it comes. One would put the rare direction on the board and still
 * leave it the only one a rider cannot judge.
 */
const BOARD_MINIMUM_DEPARTURES_PER_DIRECTION = 3;

/**
 * The three readings a view may ask a stop for, each a request of its own and each answered under
 * its own key. A reading is named rather than described by flags: the board a rider is shown is one
 * of these, never a combination of them, and naming it keeps that decision at the view that makes
 * it.
 */
const departureBoardLoaderByVariant = {
  /** What leaves next, and nothing more: the smallest board and the one every reading starts from. */
  plain: createDepartureBoardLoader({}),
  /** The same board, topped up so no direction calling here is missing from it. */
  covered: createDepartureBoardLoader({
    minimumDeparturesPerDirection: BOARD_MINIMUM_DEPARTURES_PER_DIRECTION,
  }),
  /** Every departure with the trip behind it — the heavy reading, for a board that prints `via`. */
  calls: createDepartureBoardLoader({ includeTripCalls: true }),
};

export type DepartureBoardVariant = keyof typeof departureBoardLoaderByVariant;

const DEFAULT_DEPARTURE_BOARD_VARIANT: DepartureBoardVariant = "plain";

const isDepartureBoardVariant = (value: string): value is DepartureBoardVariant =>
  value in departureBoardLoaderByVariant;

/**
 * One stop's board in the variant its key names, `stopId|variant`. Stable, because the load is an
 * effect dependency: a loader built per render would restart the refresh chain on every one of them.
 */
const loadDepartureBoardVariant = (key: string) => {
  const { stopKey: stopId, lineKey } = parseStopLineKey(key);
  const variant = isDepartureBoardVariant(lineKey) ? lineKey : DEFAULT_DEPARTURE_BOARD_VARIANT;
  return departureBoardLoaderByVariant[variant](stopId);
};
const loadStopTopologyBoard = createDepartureBoardLoader({
  includeTripCalls: true,
  maxAgeMs: STOP_TOPOLOGY_REFRESH_MS,
});
const isUnavailableBoard = (board: DepartureBoard) => board.dataStatus === "unavailable";

const SINGLE_BOARD_LOAD_OPTIONS: KeyedLoadOptions<DepartureBoard> = {
  refreshMs: BOARD_REFRESH_MS,
  isFailure: isUnavailableBoard,
};

const loadServiceNotices = () => transitSource.getServiceNotices();
const isUnavailableNoticeBoard = (board: ServiceNoticeBoard) => board.dataStatus === "unavailable";
const SERVICE_NOTICE_LOAD_OPTIONS: KeyedLoadOptions<ServiceNoticeBoard> = {
  refreshMs: SERVICE_NOTICE_REFRESH_MS,
  isFailure: isUnavailableNoticeBoard,
};

/**
 * The last board of this stop that could actually be read.
 *
 * Kept while a refresh fails, because a failed request says nothing about whether the board before
 * it was right. Adjusted while rendering rather than in an effect, so a board that failed is never
 * shown for one paint before the kept one replaces it, and dropped the moment the view moves on:
 * another stop's board is not a refresh of this one and must never stand in for it.
 */
function useLastLiveBoard(
  stopId: string | undefined,
  loaded: DepartureBoard | null,
): DepartureBoard | null {
  const [lastLiveBoard, setLastLiveBoard] = useState<DepartureBoard | null>(null);

  if (loaded?.dataStatus === "live" && lastLiveBoard !== loaded) setLastLiveBoard(loaded);
  else if (lastLiveBoard && lastLiveBoard.stopId !== stopId) setLastLiveBoard(null);

  return lastLiveBoard?.stopId === stopId ? lastLiveBoard : null;
}

/**
 * The board a view shows, keeping the last one that could be read.
 *
 * A request that failed says nothing about whether the board before it was right, so blanking the
 * view on one timeout throws away good data and answers the rider with nothing. The retained board
 * keeps its own `feedUpdatedAt` and `receivedAt`, so it states its real age and every countdown read from
 * it stays honest — no local data is substituted, and nothing is presented as fresher than it is.
 * Past `RETAINED_BOARD_LIMIT_MS` the board is too old to act on and the failure is the answer.
 */
function useRetainedDepartureBoard(
  stopId: string | undefined,
  loaded: DepartureBoard | null,
): DepartureBoard | null {
  const retained = useLastLiveBoard(stopId, loaded);

  if (loaded?.dataStatus === "live") return loaded;
  // Nothing has resolved under this key yet, which at a stop already read means the rider changed
  // how they are reading it. The board in hand is the same stop's own last reading and still true,
  // so it stands rather than the view emptying for the length of one request. Only a key change can
  // reach here with a board retained: the first load of a stop has none, and moving to another stop
  // drops it.
  if (!loaded) return retained;
  // The failed read carries the instant it failed, so how old the retained board is by now is a
  // subtraction between two boards rather than a reading of the device clock while rendering.
  return retained && loaded.receivedAt - retained.receivedAt <= RETAINED_BOARD_LIMIT_MS
    ? retained
    : loaded;
}

/**
 * Loads and periodically refreshes one stop's board, keeping the last good board while reloading.
 *
 * The variant is the view naming the reading it needs, and the three are very differently sized
 * requests. `calls` draws the trips behind the departures rather than only listing them. `covered`
 * is the line order asking for the board that order needs: a stop's rows are shared by every line
 * calling there, so at a busy post the frequent lines spend all of them within ten minutes and an
 * hourly line serving the same platform has no row at all — which the time order shows as a board
 * reaching ten minutes, and the line order as a line simply not being there. The completion tops up
 * only the directions that are short, in one filtered request on its own slower life, and is asked
 * for only while that reading is the one on screen: the other orders answer their own question from
 * the plain board and should not pay for it.
 *
 * Changing the variant does not blank the view: each is its own key, so the board already read
 * stays until the other answers — the departures a rider is reading stand while the diagram beside
 * them waits for its calls, and switching orders keeps the board in hand.
 */
export function useDepartureBoard(
  stopId: string | undefined,
  variant: DepartureBoardVariant = DEFAULT_DEPARTURE_BOARD_VARIANT,
): DepartureBoard | null {
  // Keyed per variant, so choosing the line order asks for its board now rather than at whatever is
  // left of the thirty-second cadence — and so the answer to one reading is never kept as another's.
  const loaded =
    useKeyedLoad(
      stopId ? `${stopId}|${variant}` : null,
      loadDepartureBoardVariant,
      SINGLE_BOARD_LOAD_OPTIONS,
    ) ?? null;
  return useRetainedDepartureBoard(stopId, loaded);
}

/**
 * An infrequent detailed reading used only to learn how this stop's currently visible trips relate.
 *
 * The board beside it remains lightweight and refreshes every 30 seconds. A successful topology
 * reading survives a later failed refresh for the rest of this stop visit: losing connectivity is
 * not evidence that the already observed route sequences became false.
 */
export function useStopTopologyBoard(stopId: string | undefined): DepartureBoard | null {
  const loaded =
    useKeyedLoad(stopId ?? null, loadStopTopologyBoard, {
      refreshMs: STOP_TOPOLOGY_REFRESH_MS,
      isFailure: isUnavailableBoard,
    }) ?? null;
  // Kept without the age limit a shown board has: a route sequence does not become wrong by sitting
  // there, and nothing here is published to a rider as a time.
  const lastLive = useLastLiveBoard(stopId, loaded);
  return loaded?.dataStatus === "live" ? loaded : (lastLive ?? loaded);
}

/**
 * One stop's board read for one line's directions only.
 *
 * A stop's rows are shared by every line calling there, so the board a rider reads reaches about ten
 * minutes at a busy post — long enough to catch a tram, far too short to find the vehicles of one
 * line. Asked for a line, the same rows are spent on it alone and reach some forty minutes, which is
 * what the diagram needs to see a vehicle still out at the end of its run. Naming no line reads the
 * whole stop, which is the right answer until a direction id has been seen.
 */
export function useLineStopBoard(
  stopId: string | undefined,
  lineIds: readonly string[],
): DepartureBoard | null {
  const key = stopId ? `${stopId}|${createSortedKey(lineIds)}` : null;
  const loaded = useKeyedLoad(key, loadLineStopBoard, SINGLE_BOARD_LOAD_OPTIONS) ?? null;
  // Retained across a change of line ids as well as a failed refresh: the directions are learned
  // from the board itself, so the first reading is always the one that names them.
  const lastLive = useLastLiveBoard(stopId, loaded);
  return loaded?.dataStatus === "live" ? loaded : (lastLive ?? loaded);
}

/**
 * What the operator has published about the network.
 *
 * Read on its own cadence and kept apart from the boards on purpose: a notice is an announcement
 * about the days ahead, not a measurement of the next ten minutes, and the two must never stand in
 * for one another. `enabled` is how a view with no use for them — an unattended board showing one
 * stop — avoids the request entirely.
 */
export function useServiceNotices(enabled = true): ServiceNoticeBoard | null {
  return (
    useKeyedLoad(
      enabled ? "service-notices" : null,
      loadServiceNotices,
      SERVICE_NOTICE_LOAD_OPTIONS,
    ) ?? null
  );
}
