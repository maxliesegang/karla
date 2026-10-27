import { useMemo, useState } from "react";
import { useLiveBoard } from "./dated-journey-reading-store";
import { transitSource, type StopEventBoardRequest } from "../data/transit-source";
import type { StopEventBoard } from "../data/transit-types";
import { getBoardsFailureKind } from "../lib/stop-event-board-collection";
import { createSortedKey } from "../lib/collections";
import { useKeyedLoad, type KeyedLoadOptions } from "./keyed-load";

/** Often enough that countdowns stay believable. */
export const STOP_EVENT_BOARD_REFRESH_MS = 30_000;
/** Route relationships change slowly. */
const STOP_TOPOLOGY_REFRESH_MS = 30 * 60_000;

/** Departures each direction needs before the board is complete: the next one and two behind it. */
const BOARD_MINIMUM_STOP_EVENTS_PER_DIRECTION = 3;

/** The three readings a view may ask a stop for, each its own request and key. */
const stopEventBoardRequestByVariant = {
  /** What leaves next; the smallest board. */
  plain: {},
  /** Topped up so no direction calling here is missing. */
  covered: { minimumStopEventsPerDirection: BOARD_MINIMUM_STOP_EVENTS_PER_DIRECTION },
  /** Every departure with its journey; heavy, for a board that prints `via`. */
  calls: { includeCalls: true },
} satisfies Record<string, StopEventBoardRequest>;

export type StopEventBoardVariant = keyof typeof stopEventBoardRequestByVariant;

const STOP_TOPOLOGY_REQUEST: StopEventBoardRequest = {
  includeCalls: true,
  maxAgeMs: STOP_TOPOLOGY_REFRESH_MS,
};

const SINGLE_BOARD_LOAD_OPTIONS: KeyedLoadOptions<StopEventBoard> = {
  refreshMs: STOP_EVENT_BOARD_REFRESH_MS,
  getFailureKind: (board) => getBoardsFailureKind([board]),
};

/**
 * This board's last live reading, shown while a new key (another order, a learned filter) has not
 * answered. Dropped when `boardKey` (the stop, or the stop and part) changes. Failed refreshes are
 * already covered by `refreshFailedAt`.
 */
function useLastLiveBoard(
  boardKey: string | undefined,
  loaded: StopEventBoard | null,
): StopEventBoard | null {
  const [lastLive, setLastLive] = useState<{ key: string | undefined; board: StopEventBoard }>();
  if (loaded?.dataStatus === "live" && lastLive?.board !== loaded)
    setLastLive({ key: boardKey, board: loaded });
  else if (lastLive && lastLive.key !== boardKey) setLastLive(undefined);
  return lastLive && lastLive.key === boardKey ? lastLive.board : null;
}

/** The board a view shows, and how many readings of it have answered. */
export type StopEventBoardReading = {
  board: StopEventBoard | null;
  /** Readings answered, failures included; a pull to refresh settles on any answer. */
  readingCount: number;
};

/**
 * Loads and refreshes one stop's board, keeping the last good board while reloading. `covered` tops
 * up short directions in one filtered request, only while the line order is on screen (an hourly
 * line can have no row at a busy post). Each variant has its own key, so switching keeps the board
 * in hand until the other answers.
 */
export function useStopEventBoard(
  stopId: string | undefined,
  variant: StopEventBoardVariant = "plain",
  /** Bumped by a pull to refresh: re-reads now and forgives the backoff. */
  reloadNonce?: number,
  /** One part's stop point, read alone. */
  stopPointId?: string,
): StopEventBoardReading {
  // Keyed per variant, so a new order asks now and answers never cross. Counted before resolving to
  // `null`, so an empty answer still counts.
  const loaded = useKeyedLoad(
    stopId ? `${stopId}|${stopPointId ?? ""}|${variant}` : null,
    (_key, _isEntryRead, isReload) =>
      transitSource.getStopEventBoard(stopId!, {
        ...stopEventBoardRequestByVariant[variant],
        ...(stopPointId ? { stopPointId } : {}),
        ...(isReload ? { maxAgeMs: 0 } : {}),
      }),
    { ...SINGLE_BOARD_LOAD_OPTIONS, reloadNonce },
  );
  // Another part's board is not this one's to hold.
  const lastLive = useLastLiveBoard(stopId && `${stopId}|${stopPointId ?? ""}`, loaded ?? null);
  const board = useLiveBoard(loaded ?? lastLive);
  const [counted, setCounted] = useState<{
    loaded: StopEventBoard | undefined | null;
    readingCount: number;
  }>({ loaded: null, readingCount: 0 });
  const readingCount = counted.loaded === loaded ? counted.readingCount : counted.readingCount + 1;
  if (counted.loaded !== loaded) setCounted({ loaded, readingCount });
  return useMemo(() => ({ board, readingCount }), [board, readingCount]);
}

/**
 * A rare detailed reading, only to learn how this stop's visible journeys relate. A successful
 * reading survives later failures for the visit: going offline does not make routes false.
 */
export function useStopTopologyBoard(stopId: string | undefined): StopEventBoard | null {
  const loaded =
    useKeyedLoad(
      stopId ?? null,
      (key) => transitSource.getStopEventBoard(key, STOP_TOPOLOGY_REQUEST),
      {
        refreshMs: STOP_TOPOLOGY_REFRESH_MS,
        getFailureKind: (board) => getBoardsFailureKind([board]),
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
  lineRefs: readonly string[],
): StopEventBoard | null {
  const key = stopId ? `${stopId}|${createSortedKey(lineRefs)}` : null;
  const loaded =
    useKeyedLoad(
      key,
      () => transitSource.getStopEventBoard(stopId!, lineRefs.length > 0 ? { lineRefs } : {}),
      SINGLE_BOARD_LOAD_OPTIONS,
    ) ?? null;
  // Held across a change of ids: the first reading is what names them.
  const lastLive = useLastLiveBoard(stopId, loaded);
  return useLiveBoard(loaded ?? lastLive);
}
