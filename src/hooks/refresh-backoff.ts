/**
 * How the refresh cadence remembers failure.
 *
 * Two kinds of failure are kept apart, because they accuse different things. A resolved
 * "unavailable" answer is the feed speaking: the request arrived, the operator's data did not, and
 * asking again soon spends a phone's battery and the operator's patience on an answer it already
 * gave. A rejected request is the connection speaking: on a phone that is one tunnel, one lift,
 * one weak cell, and the cadence has to recover as soon as the radio does. So a transient streak
 * reaches its ceiling in a couple of steps and stays under a minute and a half, where an
 * unavailable feed earns the full five minutes.
 */

export type LoadFailureKind =
  /** The feed answered and said it has nothing usable. */
  | "unavailable"
  /** The request never arrived. */
  | "transient";

/** The cadence an unavailable feed slows to, however long it stays down. */
export const MAX_UNAVAILABLE_BACKOFF_MS = 5 * 60_000;
/** The ceiling a flaky connection earns, reached within a couple of steps. */
export const MAX_TRANSIENT_BACKOFF_MS = 90_000;

export type FailureStreak = { kind: LoadFailureKind; count: number };

/**
 * One more failure on the streak, or a new streak when the kind changes: the earlier evidence has
 * aged by the time a different kind of failure appears.
 */
export function extendFailureStreak(
  streak: FailureStreak | undefined,
  kind: LoadFailureKind,
): FailureStreak {
  return streak?.kind === kind ? { kind, count: streak.count + 1 } : { kind, count: 1 };
}

/** The delay before the next refresh while a failure streak stands. */
export function getBackoffDelayMs(refreshMs: number, streak: FailureStreak): number {
  const ceiling =
    streak.kind === "transient" ? MAX_TRANSIENT_BACKOFF_MS : MAX_UNAVAILABLE_BACKOFF_MS;
  return Math.min(refreshMs * 2 ** streak.count, ceiling);
}

/** The events a page's way back is heard through. */
export type ResumeEventType = "visibilitychange" | "pageshow" | "focus" | "online";

/**
 * Whether one resume event is evidence the page, or the connection, was actually away — which is
 * what makes a standing failure streak stale evidence worth forgiving.
 *
 * A visibility change is such evidence in both directions: going away is why the readings stopped,
 * and the same event announces coming back (a document that reads "hidden" while the returning
 * event is delivered is why the state is read a tick later, not here). A restored document and a
 * radio that just came back say the same thing. A bare window `focus` does not: it fires when a
 * desktop window is clicked back into, the page visible and polling the whole time, so forgiving on
 * it would hand every mounted board an immediate re-read on every alt-tab — exactly the cadence the
 * streak exists to hold back. Such a resume still reschedules; it does so on the cadence it earned.
 */
export function isAwayEvidence(eventType: ResumeEventType): boolean {
  return eventType !== "focus";
}
