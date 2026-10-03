/**
 * Failure streaks for the refresh cadence. A resolved "unavailable" answer (the feed spoke) backs
 * off to five minutes; a rejected request (the connection) tops out under ninety seconds, so it
 * recovers as soon as the radio does.
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

/** One more failure, or a new streak when the kind changes. */
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
 * Whether a resume event means the page is visible even if WebKit still reports it hidden:
 * `pageshow` and `focus` do (a restored iOS home-screen app may deliver only those).
 */
export function isVisibleResumeEvent(
  eventType: ResumeEventType,
  visibilityState: "hidden" | "visible",
): boolean {
  return visibilityState === "visible" || eventType === "pageshow" || eventType === "focus";
}

/**
 * Whether a resume event shows the page or connection was really away, so the failure streak is
 * forgiven: visibility changes, restores and `online` do; a bare `focus` (a desktop alt-tab) does
 * not, and only reschedules on the earned cadence.
 */
export function isAwayEvidence(eventType: ResumeEventType): boolean {
  return eventType !== "focus";
}
