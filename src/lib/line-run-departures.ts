import type { Departure } from "../data/transit-types";
import { findFinalCallInstant } from "./trip-calls";
import { getRunMarkKey, getSequenceReadInstant } from "./trips";

/**
 * How long a finished run's mark is kept past its final call; must stay inside
 * `RUN_ENDED_GRACE_MS`.
 */
export const RUN_MARK_RETENTION_GRACE_MS = 2 * 60_000;
/**
 * A run is first drawn only from calls read this recently, so a cached board does not place it
 * before its own re-read (`LINE_RUN_READING_MAX_AGE_MS`) lands.
 */
export const RUN_FIRST_PLACEMENT_MAX_AGE_MS = 90_000;
/** Bounds the followed set against an unexpectedly large board. */
const FOLLOWED_RUN_CAPACITY = 256;

/**
 * A run a line view follows, by row id only: the reading is fetched by id (`findRun`) and its
 * expiry read off it at that moment. Not keyed by mark key, which can be refined when the sequence
 * lands.
 */
export type FollowedRun = {
  rowId: string;
  /** When a board last named this run; the cap keeps the most recent. */
  observedAt: number;
};

/** The final expected call, plus the grace a marker is held for. */
function getRunRetentionExpiry(departure: Departure): number | undefined {
  const finalInstant = findFinalCallInstant(departure.tripCalls);
  return finalInstant === undefined ? undefined : finalInstant + RUN_MARK_RETENTION_GRACE_MS;
}

/** Still worth drawing: known, not cancelled, not past its final call. */
const isStillRunning = (run: Departure | undefined, feedNow: number): boolean =>
  run !== undefined && run.status !== "cancelled" && (getRunRetentionExpiry(run) ?? 0) > feedNow;

/**
 * Adds the latest board observations to the followed runs. A board drops a run once it passes, but
 * its calls still describe the rest of the run until the final call.
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

/** Whether two followed sets name the same runs. */
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
 * The current board entries plus still-running vehicles the boards stopped listing. Current entries
 * win. Followed runs resolve through `findRun` and match by their draw-time mark key; a run the
 * source can no longer name was evicted and leaves the plan.
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
    // A current entry is shown even without a trustworthy expiry; only following it on needs one.
    ...current,
    ...unlisted,
  ];
}

/**
 * The runs a drawing may place: those already drawn, and new ones read recently. `now` is the
 * device clock, as read stamps are.
 */
export function selectPlaceableRuns(
  runs: readonly Departure[],
  now: number,
  drawnMarkKeys: ReadonlySet<string>,
): Departure[] {
  return runs.filter((run) => {
    const readAt = getSequenceReadInstant(run);
    return (
      readAt === undefined ||
      now - readAt <= RUN_FIRST_PLACEMENT_MAX_AGE_MS ||
      drawnMarkKeys.has(getRunMarkKey(run))
    );
  });
}
