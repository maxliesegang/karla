/** Shares board requests and retains dated boards through failed refreshes. */
import { ReadingCache } from "./reading-cache";
import { SharedRequests } from "./request-sharing";
import type { StopEventBoard } from "./transit-types";

export const STOP_EVENT_BOARD_CACHE_CAPACITY = 256;
/** Topology and idle observation reads reuse boards for up to thirty minutes. */
const CACHE_MAX_AGE_MS = 30 * 60_000;
/** How long the last live board stands in for failed refreshes. */
const RETAINED_BOARD_LIMIT_MS = 10 * 60_000;

export function unavailableStopEventBoard(stopId: string, errorMessage: string): StopEventBoard {
  return {
    stopId,
    dataStatus: "unavailable",
    receivedAt: Date.now(),
    stopEvents: [],
    errorMessage,
  };
}

export class StopEventBoardReadings {
  private readonly cache = new ReadingCache<StopEventBoard>(
    STOP_EVENT_BOARD_CACHE_CAPACITY,
    CACHE_MAX_AGE_MS,
  );
  private readonly requests = new SharedRequests<StopEventBoard>();

  get(
    key: string,
    { maxAgeMs, reusableKeys = [key] }: { maxAgeMs: number; reusableKeys?: readonly string[] },
    load: () => Promise<StopEventBoard>,
  ): Promise<StopEventBoard> {
    const now = Date.now();
    const cached = reusableKeys
      .map((key) => this.cache.get(key))
      .find((board) => board && now - board.receivedAt < maxAgeMs);
    if (cached) return Promise.resolve(cached);

    return (
      this.requests.find(...reusableKeys) ??
      this.requests.share(key, async () => this.retain(key, await load()))
    );
  }

  /** A live board is kept; a failed refresh shows the last live one while it is recent enough. */
  private retain(key: string, fetched: StopEventBoard): StopEventBoard {
    if (fetched.dataStatus === "live") {
      this.cache.set(key, fetched, fetched.receivedAt);
      return fetched;
    }
    const lastLive = this.cache.get(key);
    const failedAt = Date.now();
    if (
      lastLive?.dataStatus === "live" &&
      failedAt - lastLive.receivedAt <= RETAINED_BOARD_LIMIT_MS
    ) {
      return { ...lastLive, refreshFailedAt: failedAt };
    }
    return fetched;
  }
}
