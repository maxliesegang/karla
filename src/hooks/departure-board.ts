import { useMemo, useState } from "react";
import { useLiveBoard } from "./run-reading-store";
import { transitSource, type DepartureBoardRequest } from "../data/transit-source";
import type { DepartureBoard, ServiceNoticeBoard } from "../data/transit-types";
import { isFailedBoard } from "../lib/departure-board-collection";
import { createSortedKey } from "../lib/collections";
import { useKeyedLoad, type KeyedLoadOptions } from "./keyed-load";

/** Often enough that countdowns stay believable. */
export const DEPARTURE_BOARD_REFRESH_MS = 30_000;
/** Route relationships change slowly. */
const STOP_TOPOLOGY_REFRESH_MS = 30 * 60_000;
/** Notices are published for weeks. */
const SERVICE_NOTICE_REFRESH_MS = 15 * 60_000;

/** Departures each direction needs before the board is complete: the next one and two behind it. */
const BOARD_MINIMUM_DEPARTURES_PER_DIRECTION = 3;

/** The three readings a view may ask a stop for, each its own request and key. */
const departureBoardRequestByVariant = {
  /** What leaves next; the smallest board. */
  plain: {},
  /** Topped up so no direction calling here is missing. */
  covered: { minimumDeparturesPerDirection: BOARD_MINIMUM_DEPARTURES_PER_DIRECTION },
  /** Every departure with its trip; heavy, for a board that prints `via`. */
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
 * This stop's last live board, shown while a new key (another order, a learned filter) has not
 * answered. Dropped on a stop change. Failed refreshes are already covered by `refreshFailedAt`.
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

/** The board a view shows, and how many readings of it have answered. */
export type DepartureBoardReading = {
  board: DepartureBoard | null;
  /** Readings answered, failures included; a pull to refresh settles on any answer. */
  readingCount: number;
};

/**
 * Loads and refreshes one stop's board, keeping the last good board while reloading. `covered` tops
 * up short directions in one filtered request, only while the line order is on screen (an hourly
 * line can have no row at a busy post). Each variant has its own key, so switching keeps the board
 * in hand until the other answers.
 */
export function useDepartureBoard(
  stopId: string | undefined,
  variant: DepartureBoardVariant = "plain",
  /** Bumped by a pull to refresh: re-reads now and forgives the backoff. */
  reloadNonce?: number,
): DepartureBoardReading {
  // Keyed per variant, so a new order asks now and answers never cross. Counted before resolving to
  // `null`, so an empty answer still counts.
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
 * A rare detailed reading, only to learn how this stop's visible trips relate. A successful reading
 * survives later failures for the visit: going offline does not make routes false.
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
  // No age limit: a route does not go wrong by sitting there, and nothing here is shown as a time.
  const lastLive = useLastLiveBoard(stopId, loaded);
  return useLiveBoard(loaded?.dataStatus === "live" ? loaded : (lastLive ?? loaded));
}

/**
 * One stop's board filtered to one line's directions, so its rows reach about forty minutes of that
 * line. No line reads the whole stop, until a direction id is known.
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
  // Held across a change of ids: the first reading is what names them.
  const lastLive = useLastLiveBoard(stopId, loaded);
  return useLiveBoard(loaded ?? lastLive);
}

/**
 * The operator's notices, on their own cadence and never mixed with boards. `enabled: false` skips
 * the request (an unattended board).
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
