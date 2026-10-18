/** Shares board requests and retains dated boards without mixing feed sessions. */
import type { KvvFeedSession } from "./kvv-feed-selection";
import { FeedChangedError } from "./kvv-feed-errors";
import { ReadingCache } from "./reading-cache";
import { SharedRequests } from "./request-sharing";
import type { DepartureBoard } from "./transit-types";

export const DEPARTURE_BOARD_CACHE_CAPACITY = 256;
/** Topology and idle observation reads reuse boards for up to thirty minutes. */
const CACHE_MAX_AGE_MS = 30 * 60_000;
/** How long the last live board stands in for failed refreshes. */
const RETAINED_BOARD_LIMIT_MS = 10 * 60_000;

export function unavailableDepartureBoard(stopId: string, errorMessage: string): DepartureBoard {
  return {
    stopId,
    dataStatus: "unavailable",
    receivedAt: Date.now(),
    departures: [],
    errorMessage,
  };
}

export class DepartureBoardReadings {
  private readonly cache = new ReadingCache<DepartureBoard>(
    DEPARTURE_BOARD_CACHE_CAPACITY,
    CACHE_MAX_AGE_MS,
  );
  private readonly requests = new SharedRequests<DepartureBoard>();
  private readonly sessions = new WeakMap<DepartureBoard, KvvFeedSession>();

  track(board: DepartureBoard, session: KvvFeedSession): DepartureBoard {
    this.sessions.set(board, session);
    return board;
  }

  isCurrent(board: DepartureBoard): boolean {
    return this.sessions.get(board)?.isCurrent ?? false;
  }

  get(
    key: string,
    {
      session,
      maxAgeMs,
      reusableKeys = [key],
    }: {
      session: KvvFeedSession;
      maxAgeMs: number;
      reusableKeys?: readonly string[];
    },
    load: () => Promise<DepartureBoard>,
  ): Promise<DepartureBoard> {
    const now = Date.now();
    const cached = reusableKeys
      .map((key) => this.cache.get(key))
      .find((board) => board && this.isCurrent(board) && now - board.receivedAt < maxAgeMs);
    if (cached) return Promise.resolve(cached);

    const pending = this.requests.find(...reusableKeys.map((key) => `${session.id}:${key}`));
    if (pending) return pending;
    return this.requests.share(`${session.id}:${key}`, async () =>
      this.retain(key, await load(), session),
    );
  }

  private retain(
    key: string,
    fetched: DepartureBoard,
    requestedSession: KvvFeedSession,
  ): DepartureBoard {
    if (fetched.dataStatus === "live" && this.isCurrent(fetched)) {
      this.cache.set(key, fetched, fetched.receivedAt);
      return fetched;
    }
    const lastLive = this.cache.get(key);
    if (!requestedSession.isCurrent && lastLive && this.isCurrent(lastLive)) return lastLive;

    const failedAt = Date.now();
    const kept = [lastLive, fetched].find(
      (board) =>
        board?.dataStatus === "live" && failedAt - board.receivedAt <= RETAINED_BOARD_LIMIT_MS,
    );
    if (kept) {
      const retained = { ...kept, refreshFailedAt: failedAt };
      const session = this.sessions.get(kept);
      return session ? this.track(retained, session) : retained;
    }
    return fetched.dataStatus === "unavailable"
      ? fetched
      : unavailableDepartureBoard(fetched.stopId, new FeedChangedError().message);
  }
}
