/**
 * Failure streaks for the refresh cadence. An "unavailable" answer (nothing usable) backs off to
 * five minutes; a lost request (the connection) is retried within seconds and tops out at ninety,
 * so it recovers as soon as the radio does.
 */

export type LoadFailureKind =
  /** The feed answered and said it has nothing usable. */
  | "unavailable"
  /** The request never arrived. */
  | "transient";

/** The cadence an unavailable feed slows to, however long it stays down. */
export const MAX_UNAVAILABLE_BACKOFF_MS = 5 * 60_000;
/** The ceiling a flaky connection earns, reached within a few steps. */
export const MAX_TRANSIENT_BACKOFF_MS = 90_000;
/** How soon a first lost request is retried, at most; each further loss triples the wait. */
export const FIRST_TRANSIENT_RETRY_MS = 5_000;

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
  if (streak.kind === "transient") {
    const firstRetryMs = Math.min(refreshMs, FIRST_TRANSIENT_RETRY_MS);
    return Math.min(firstRetryMs * 3 ** (streak.count - 1), MAX_TRANSIENT_BACKOFF_MS);
  }
  return Math.min(refreshMs * 2 ** streak.count, MAX_UNAVAILABLE_BACKOFF_MS);
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
