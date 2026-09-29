import { useMemo, useState } from "react";
import { useLiveBoard } from "./run-reading-store";
import { transitSource, type DepartureBoardRequest } from "../data/transit-source";
import type { DepartureBoard, ServiceNoticeBoard } from "../data/transit-types";
import { isFailedBoard } from "../lib/departure-board-collection";
import { createSortedKey } from "../lib/collections";
import { useKeyedLoad, type KeyedLoadOptions } from "./keyed-load";

/** The board is re-read often enough that countdowns stay believable without churning. */
export const DEPARTURE_BOARD_REFRESH_MS = 30_000;
/** Route relationships change slowly; the live countdown board remains on its 30-second cadence. */
const STOP_TOPOLOGY_REFRESH_MS = 30 * 60_000;
/** Notices are written by hand and published for weeks; asking often would only cost the rider data. */
const SERVICE_NOTICE_REFRESH_MS = 15 * 60_000;

const createDepartureBoardLoader = (request: DepartureBoardRequest) => (stopId: string) =>
  transitSource.getDepartureBoard(stopId, request);

/**
 * The key that names stops and, optionally, route direction ids: `stopIds|routeDirectionIds`. Stop slugs and provider
 * direction ids contain neither separator.
 */
const parseStopLineKey = (key: string): { stopKey: string; lineKey: string } => {
  const [stopKey = "", lineKey = ""] = key.split("|");
  return { stopKey, lineKey };
};

/** One stop's board restricted to one line's directions; the key is `stopId|directionIds`. */
const loadLineStopBoard = (key: string) => {
  const { stopKey: stopId, lineKey } = parseStopLineKey(key);
  return transitSource.getDepartureBoard(
    stopId,
    lineKey ? { routeDirectionIds: lineKey.split(",") } : {},
  );
};

/**
 * What a batched reading is asked for: what one board is asked for, plus — on a line's reading
 * only — how stale the runs' own re-reads may be. A whole-stop reading carries its runs inside the
 * boards, and a single board has no runs of its own, so there the field has no one to speak to.
 */
type DepartureBoardsRequest = DepartureBoardRequest & {
  runMaxAgeMs?: number;
};

/**
 * Several stops at once, keyed by the joined ids `useKeyedLoad` addresses them under, optionally
 * with a line filter after a `|`.
 *
 * The filter is not a narrowing of the same reading but a different one. A stop's board is asked
 * for the trips behind its rows, because those trips are what the network is observed from and
 * nothing else will state them. A line's stops are not read that way: the same run is listed at
 * every stop it has yet to leave, so asking each board for it again transfers one calling sequence
 * fifteen times to learn it once. `getLineDepartureBoards` reads the rows and then the trips —
 * see `transit-source.ts`, where both halves and their dating live.
 */
export const createDepartureBoardsLoader = (request: DepartureBoardsRequest) => (key: string) => {
  const { stopKey, lineKey } = parseStopLineKey(key);
  const stopIds = stopKey.split(",");
  if (lineKey) {
    return transitSource.getLineDepartureBoards(stopIds, {
      routeDirectionIds: lineKey.split(","),
      maxAgeMs: request.maxAgeMs,
      runMaxAgeMs: request.runMaxAgeMs,
    });
  }
  return Promise.all(stopIds.map(createDepartureBoardLoader(request)));
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

const SINGLE_BOARD_LOAD_OPTIONS: KeyedLoadOptions<DepartureBoard> = {
  refreshMs: DEPARTURE_BOARD_REFRESH_MS,
  isFailure: isFailedBoard,
};

const loadServiceNotices = () => transitSource.getServiceNotices();
const isUnavailableNoticeBoard = (board: ServiceNoticeBoard) => board.dataStatus === "unavailable";
const SERVICE_NOTICE_LOAD_OPTIONS: KeyedLoadOptions<ServiceNoticeBoard> = {
  refreshMs: SERVICE_NOTICE_REFRESH_MS,
  isFailure: isUnavailableNoticeBoard,
};

/**
 * The last live board this hook read for this stop, for a new key that has not answered yet.
 *
 * A rider changing how a stop is read — another order, a line filter learned — asks a new key, and
 * this stop's last reading is still true meanwhile, so it stands rather than the view emptying for
 * one request. A failed refresh needs nothing here: the source already answers it with the last
 * live board (`refreshFailedAt`). Dropped the moment the view moves to another stop, whose board is
 * never a refresh of this one.
 */
function useLastLiveBoard(
  stopId: string | undefined,
  loaded: DepartureBoard | null,
): DepartureBoard | null {
  const [lastLive, setLastLive] = useState<DepartureBoard | null>(null);
  if (loaded?.dataStatus === "live" && lastLive !== loaded) setLastLive(loaded);
  else if (lastLive && lastLive.stopId !== stopId) setLastLive(null);
  return lastLive?.stopId === stopId ? lastLive : null;
}

/**
 * The board a view shows, and how many readings of it have answered.
 */
export type DepartureBoardReading = {
  board: DepartureBoard | null;
  /**
   * How many readings of the board have answered, however each of them answered. A refresh asked
   * for by a pull is settled by its reading having answered at all — a fresh board takes the old
   * one's place, a failed one is stated by the board's age — and never by a particular kind of
   * answer coming back, which is why this counts answers rather than reading their contents.
   */
  readingCount: number;
};

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
  /**
   * Bumped by a caller's explicit "ask again" — a pull to refresh. The board already read stays on
   * screen until the new reading answers, and the backoff the cadence had earned is forgiven: a
   * rider asking again is the evidence the feed is worth asking.
   */
  reloadNonce?: number,
): DepartureBoardReading {
  // Keyed per variant, so choosing the line order asks for its board now rather than at whatever is
  // left of the thirty-second cadence — and so the answer to one reading is never kept as another's.
  // Counted as the raw answer, before the "nothing has resolved" reading is flattened into `null`,
  // so an answer that resolves to nothing still counts against the one before it.
  const loaded = useKeyedLoad(stopId ? `${stopId}|${variant}` : null, loadDepartureBoardVariant, {
    ...SINGLE_BOARD_LOAD_OPTIONS,
    reloadNonce,
  });
  const lastLive = useLastLiveBoard(stopId, loaded ?? null);
  const board = useLiveBoard(loaded ?? lastLive);
  const [counted, setCounted] = useState<{
    loaded: DepartureBoard | undefined | null;
    readingCount: number;
  }>({ loaded: null, readingCount: 0 });
  const readingCount = counted.loaded === loaded ? counted.readingCount : counted.readingCount + 1;
  if (counted.loaded !== loaded) setCounted({ loaded, readingCount });
  return useMemo(() => ({ board, readingCount }), [board, readingCount]);
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
      isFailure: isFailedBoard,
    }) ?? null;
  // Kept without the age limit a shown board has: a route sequence does not become wrong by sitting
  // there, and nothing here is published to a rider as a time.
  const lastLive = useLastLiveBoard(stopId, loaded);
  return useLiveBoard(loaded?.dataStatus === "live" ? loaded : (lastLive ?? loaded));
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
  routeDirectionIds: readonly string[],
): DepartureBoard | null {
  const key = stopId ? `${stopId}|${createSortedKey(routeDirectionIds)}` : null;
  const loaded = useKeyedLoad(key, loadLineStopBoard, SINGLE_BOARD_LOAD_OPTIONS) ?? null;
  // Held across a change of line ids: the directions are learned from the board itself, so the
  // first reading is always the one that names them.
  const lastLive = useLastLiveBoard(stopId, loaded);
  return useLiveBoard(loaded ?? lastLive);
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
