import type { Departure } from "../data/transit-types";
import { findFinalCallInstant } from "./trip-calls";
import { getRunMarkKey } from "./trips";

/**
 * How long a finished run's mark is kept past its final call. One of four nested lifetimes; it must
 * stay inside the store's `RUN_ENDED_GRACE_MS` (docs/adr/0002-run-key-without-date.md).
 */
export const RUN_MARK_RETENTION_GRACE_MS = 2 * 60_000;
/** The set followed is bounded even if a provider returns an unexpectedly large board. */
export const FOLLOWED_RUN_CAPACITY = 256;

/**
 * A run a line view is still following: its id, never a copy of its reading.
 *
 * The reading is fetched by id whenever it is needed (`findRun`), so there is one of it — and so is
 * how long the run is kept: its expiry is read off the run as it stands at that moment, since every
 * re-read may move its final call. Only a board naming a run changes this entry.
 *
 * Named by the row id, and never by a mark key: the mark key can be refined when the run's
 * sequence lands (`getRunMarkKey`), and is read off the reading at the moment it is compared.
 */
export type FollowedRun = {
  rowId: string;
  /** When a board last named this run, which is what the cap spends itself in favour of. */
  observedAt: number;
};

/** The final expected call, plus the grace a marker is held for. */
export function getRunRetentionExpiry(departure: Departure): number | undefined {
  const finalInstant = findFinalCallInstant(departure.tripCalls);
  return finalInstant === undefined ? undefined : finalInstant + RUN_MARK_RETENTION_GRACE_MS;
}

/** Whether a run is still worth drawing: known, not cancelled, and not past its final call. */
const isStillRunning = (run: Departure | undefined, feedNow: number): boolean =>
  run !== undefined && run.status !== "cancelled" && (getRunRetentionExpiry(run) ?? 0) > feedNow;

/**
 * Adds the latest board observations to the bounded set of runs being followed.
 *
 * A departure board stops listing a run once it has passed that stop. Its complete call sequence
 * still describes the rest of the run, so it remains worth drawing until the final expected call.
 */
export function updateFollowedRuns(
  previous: readonly FollowedRun[],
  observedDepartures: readonly Departure[],
  feedNow: number,
  findRun: (rowId: string) => Departure | undefined,
  capacity = FOLLOWED_RUN_CAPACITY,
): FollowedRun[] {
  const followedByRowId = new Map(
    previous
      .filter((followed) => isStillRunning(findRun(followed.rowId), feedNow))
      .map((followed) => [followed.rowId, followed]),
  );
  for (const departure of observedDepartures) {
    if (!isStillRunning(departure, feedNow)) {
      if (departure.status === "cancelled") followedByRowId.delete(departure.id);
      continue;
    }
    followedByRowId.set(departure.id, {
      rowId: departure.id,
      observedAt: departure.readAt?.rowReadAt ?? feedNow,
    });
  }
  return [...followedByRowId.values()]
    .sort((left, right) => right.observedAt - left.observedAt)
    .slice(0, capacity);
}

/** Whether two sets followed name the same runs, so state need not move. */
export function areFollowedRunsEqual(
  left: readonly FollowedRun[],
  right: readonly FollowedRun[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.rowId === right[index].rowId && entry.observedAt === right[index].observedAt,
    )
  );
}

/**
 * The current board entries plus still-running vehicles the boards have stopped listing.
 *
 * Current entries win over followed ones because a row on a board in hand is this refresh's
 * statement about where the vehicle is. A followed run is resolved through `findRun` and judged by
 * the mark key it carries at draw time, so a run whose dated identity was refined after it was
 * followed is still recognised as the one a board row stands for, and one the reading says is
 * cancelled is not drawn from an older statement. A run the source can no longer name has been
 * evicted rather than finished, so it simply leaves the plan.
 */
export function getLineRunDepartures(
  followed: readonly FollowedRun[],
  observedDepartures: readonly Departure[],
  feedNow: number,
  findRun: (rowId: string) => Departure | undefined,
): Departure[] {
  const current = observedDepartures.filter((departure) => departure.status !== "cancelled");
  const claimedKeys = new Set(current.map(getRunMarkKey));
  const unlisted: Departure[] = [];
  for (const entry of followed) {
    const run = findRun(entry.rowId);
    if (!run || !isStillRunning(run, feedNow)) continue;
    const markKey = getRunMarkKey(run);
    if (claimedKeys.has(markKey)) continue;
    claimedKeys.add(markKey);
    unlisted.push(run);
  }
  return [
    // A current entry may still have enough timed calls to place a mark even when its final call is
    // incomplete. Show it now; only following it on requires a trustworthy expiry.
    ...current,
    ...unlisted,
  ];
}
