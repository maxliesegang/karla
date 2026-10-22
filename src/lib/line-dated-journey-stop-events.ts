import type { StopEvent } from "../data/transit-types";
import { findFinalCallInstant } from "./calls";
import {
  getDatedJourneyMarkKey,
  getSequenceReadInstant,
  withoutDatedJourneyCalls,
} from "./journeys";

/**
 * How long a finished dated journey's mark is kept past its final call; must stay inside
 * `DATED_JOURNEY_ENDED_GRACE_MS`.
 */
export const DATED_JOURNEY_MARK_RETENTION_GRACE_MS = 2 * 60_000;
/**
 * A dated journey is first drawn only from calls read this recently, so a cached journey reading
 * does not place it before its own re-read (`LINE_DATED_JOURNEY_READING_MAX_AGE_MS`) lands.
 */
export const DATED_JOURNEY_FIRST_PLACEMENT_MAX_AGE_MS = 90_000;
/** Bounds the followed set against an unexpectedly large board. */
const FOLLOWED_DATED_JOURNEY_CAPACITY = 256;

/**
 * A dated journey a line view follows, by row id only: the reading is fetched by id
 * (`findDatedJourney`) and its expiry read off it at that moment. Not keyed by mark key, which can
 * be refined when the sequence lands.
 */
export type FollowedDatedJourney = {
  rowId: string;
  /** When a board last named this dated journey; the cap keeps the most recent. */
  observedAt: number;
};

/** The final expected call, plus the grace a marker is held for. */
function getDatedJourneyRetentionExpiry(stopEvent: StopEvent): number | undefined {
  const finalInstant = findFinalCallInstant(stopEvent.calls);
  return finalInstant === undefined
    ? undefined
    : finalInstant + DATED_JOURNEY_MARK_RETENTION_GRACE_MS;
}

/** Still worth drawing: known, not cancelled, not past its final call. */
const isStillRunning = (datedJourney: StopEvent | undefined, feedNow: number): boolean =>
  datedJourney !== undefined &&
  datedJourney.status !== "cancelled" &&
  (getDatedJourneyRetentionExpiry(datedJourney) ?? 0) > feedNow;

/**
 * Adds the latest board observations to the followed dated journeys. A board drops a dated journey
 * once it passes, but its calls still describe the rest of the dated journey until the final call.
 */
export function updateFollowedDatedJourneys(
  previous: readonly FollowedDatedJourney[],
  observedStopEvents: readonly StopEvent[],
  feedNow: number,
  findDatedJourney: (rowId: string) => StopEvent | undefined,
  capacity = FOLLOWED_DATED_JOURNEY_CAPACITY,
): FollowedDatedJourney[] {
  const followedByRowId = new Map(
    previous
      .filter((followed) => isStillRunning(findDatedJourney(followed.rowId), feedNow))
      .map((followed) => [followed.rowId, followed]),
  );
  for (const stopEvent of observedStopEvents) {
    if (!isStillRunning(stopEvent, feedNow)) {
      if (stopEvent.status === "cancelled") followedByRowId.delete(stopEvent.id);
      continue;
    }
    followedByRowId.set(stopEvent.id, {
      rowId: stopEvent.id,
      observedAt: stopEvent.readAt?.rowReadAt ?? feedNow,
    });
  }
  return [...followedByRowId.values()]
    .sort((left, right) => right.observedAt - left.observedAt)
    .slice(0, capacity);
}

/** Whether two followed sets name the same dated journeys. */
export function areFollowedDatedJourneysEqual(
  left: readonly FollowedDatedJourney[],
  right: readonly FollowedDatedJourney[],
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
 * Listed and retained dated journeys read their latest calls from the source. Retained dated
 * journeys match by their current mark key; an evicted dated journey leaves the plan.
 */
export function getLineDatedJourneyStopEvents(
  followed: readonly FollowedDatedJourney[],
  observedStopEvents: readonly StopEvent[],
  feedNow: number,
  findDatedJourney: (rowId: string) => StopEvent | undefined,
): StopEvent[] {
  const current = observedStopEvents
    // A row the store no longer holds still stands, but its board's calls never place it.
    .map((stopEvent) => findDatedJourney(stopEvent.id) ?? withoutDatedJourneyCalls(stopEvent))
    .filter((stopEvent) => stopEvent.status !== "cancelled");
  const claimedKeys = new Set(current.map(getDatedJourneyMarkKey));
  const unlisted: StopEvent[] = [];
  for (const entry of followed) {
    const datedJourney = findDatedJourney(entry.rowId);
    if (!datedJourney || !isStillRunning(datedJourney, feedNow)) continue;
    const markKey = getDatedJourneyMarkKey(datedJourney);
    if (claimedKeys.has(markKey)) continue;
    claimedKeys.add(markKey);
    unlisted.push(datedJourney);
  }
  return [
    // A current entry is shown even without a trustworthy expiry; only following it on needs one.
    ...current,
    ...unlisted,
  ];
}

/**
 * The dated journeys a drawing may place: those already drawn, and new ones read recently. `now` is
 * the device clock, as read stamps are.
 */
export function selectPlaceableDatedJourneys(
  datedJourneys: readonly StopEvent[],
  now: number,
  drawnMarkKeys: ReadonlySet<string>,
): StopEvent[] {
  return datedJourneys.filter((datedJourney) => {
    const readAt = getSequenceReadInstant(datedJourney);
    return (
      readAt === undefined ||
      now - readAt <= DATED_JOURNEY_FIRST_PLACEMENT_MAX_AGE_MS ||
      drawnMarkKeys.has(getDatedJourneyMarkKey(datedJourney))
    );
  });
}
