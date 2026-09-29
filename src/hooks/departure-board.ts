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
const departureBoardRequestByVariant = {
  /** What leaves next, and nothing more: the smallest board and the one every reading starts from. */
  plain: {},
  /** The same board, topped up so no direction calling here is missing from it. */
  covered: { minimumDeparturesPerDirection: BOARD_MINIMUM_DEPARTURES_PER_DIRECTION },
  /** Every departure with the trip behind it — the heavy reading, for a board that prints `via`. */
  calls: { includeTripCalls: true },
} satisfies Record<string, DepartureBoardRequest>;

export type DepartureBoardVariant = keyof typeof departureBoardRequestByVariant;

const STOP_TOPOLOGY_REQUEST: DepartureBoardRequest = {
  includeTripCalls: true,
  maxAgeMs: STOP_TOPOLOGY_REFRESH_MS,
};

const SINGLE_BOARD_LOAD_OPTIONS: KeyedLoadOptions<DepartureBoard> = {
  refreshMs: DEPARTURE_BOARD_REFRESH_MS,
  isFailure: isFailedBoard,
};

const SERVICE_NOTICE_LOAD_OPTIONS: KeyedLoadOptions<ServiceNoticeBoard> = {
  refreshMs: SERVICE_NOTICE_REFRESH_MS,
  isFailure: (board) => board.dataStatus === "unavailable",
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
  variant: DepartureBoardVariant = "plain",
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
  const loaded = useKeyedLoad(
    stopId ? `${stopId}|${variant}` : null,
    () => transitSource.getDepartureBoard(stopId!, departureBoardRequestByVariant[variant]),
    { ...SINGLE_BOARD_LOAD_OPTIONS, reloadNonce },
  );
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
    useKeyedLoad(
      stopId ?? null,
      (key) => transitSource.getDepartureBoard(key, STOP_TOPOLOGY_REQUEST),
      {
        refreshMs: STOP_TOPOLOGY_REFRESH_MS,
        isFailure: isFailedBoard,
      },
    ) ?? null;
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
  const loaded =
    useKeyedLoad(
      key,
      () =>
        transitSource.getDepartureBoard(
          stopId!,
          routeDirectionIds.length > 0 ? { routeDirectionIds } : {},
        ),
      SINGLE_BOARD_LOAD_OPTIONS,
    ) ?? null;
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
      () => transitSource.getServiceNotices(),
      SERVICE_NOTICE_LOAD_OPTIONS,
    ) ?? null
  );
}
