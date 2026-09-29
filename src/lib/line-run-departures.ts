import type { Departure } from "../data/transit-types";
import { findFinalCallInstant } from "./trip-calls";
import { getDepartureReadInstant, getRunMarkKey } from "./trips";

/**
 * A finished run is kept briefly so a clock correction at its final call does not churn state.
 *
 * One of four nested lifetimes for the same run, and it must stay inside the grace the evidence is
 * held for: a mark still being drawn resolves through `findRun` on every frame, so a mark that
 * outlived its record would simply leave the plan. `RUN_ENDED_GRACE_MS` states the ordering.
 */
export const RUN_MARK_RETENTION_GRACE_MS = 2 * 60_000;
/** The set followed is bounded even if a provider returns an unexpectedly large board. */
export const FOLLOWED_RUN_CAPACITY = 256;

/**
 * A run a line view is still following, named rather than copied.
 *
 * What is kept is which run to keep drawing and until when — never the reading itself. A copy taken
 * when the boards last listed the run would go on being drawn from that moment however much has
 * been read since, so the reading is fetched by id at the moment it is drawn, and there is one of
 * it.
 *
 * Named by the row id, and never by a mark key. The mark key a run is drawn under can be refined
 * when its calling sequence lands (`getRunMarkKey`), so an identity frozen at follow time would
 * drift away from the one the run is compared under — the same run followed twice, and a
 * suppression test answering the wrong name. Row ids do not move; the mark key is read off the
 * reading at the moment it is compared (`getLineRunDepartures`).
 */
export type FollowedRun = {
  rowId: string;
  /** When this run was last named by a board, which is what the cap spends itself in favour of. */
  observedAt: number;
  expiresAt: number;
};

/** The final expected call, plus the grace a marker is held for. */
export function getRunRetentionExpiry(departure: Departure): number | undefined {
  const finalInstant = findFinalCallInstant(departure.tripCalls);
  return finalInstant === undefined ? undefined : finalInstant + RUN_MARK_RETENTION_GRACE_MS;
}

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
  capacity = FOLLOWED_RUN_CAPACITY,
): FollowedRun[] {
  const followedByRowId = new Map(
    previous
      .filter((followed) => followed.expiresAt > feedNow)
      .map((followed) => [followed.rowId, followed]),
  );

  for (const departure of observedDepartures) {
    if (departure.status === "cancelled") {
      followedByRowId.delete(departure.id);
      continue;
    }

    const expiresAt = getRunRetentionExpiry(departure);
    if (expiresAt === undefined || expiresAt <= feedNow) continue;
    followedByRowId.set(departure.id, {
      rowId: departure.id,
      observedAt: getDepartureReadInstant(departure) ?? feedNow,
      expiresAt,
    });
  }

  return [...followedByRowId.values()]
    .sort((left, right) => right.observedAt - left.observedAt || left.expiresAt - right.expiresAt)
    .slice(0, capacity);
}

/** Whether two sets followed name the same runs to the same ends, so state need not move. */
export function areFollowedRunsEqual(
  left: readonly FollowedRun[],
  right: readonly FollowedRun[],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const other = right[index];
      return (
        entry.rowId === other.rowId &&
        entry.observedAt === other.observedAt &&
        entry.expiresAt === other.expiresAt
      );
    })
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
  const resolvedObservedDepartures = observedDepartures.map(
    (departure) => findRun(departure.id) ?? departure,
  );
  const current = resolvedObservedDepartures.filter(
    (departure) => departure.status !== "cancelled",
  );
  const claimedKeys = new Set(current.map(getRunMarkKey));
  const unlisted: Departure[] = [];
  for (const entry of followed) {
    if (entry.expiresAt <= feedNow) continue;
    const run = findRun(entry.rowId);
    if (!run || run.status === "cancelled") continue;
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
