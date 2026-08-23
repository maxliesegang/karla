import { useEffect, useState } from "react";
import {
  extendFailureStreak,
  getBackoffDelayMs,
  isAwayEvidence,
  type FailureStreak,
  type LoadFailureKind,
  type ResumeEventType,
} from "./refresh-backoff";

type LoadedValue<T> = { key: string; value: T | undefined };

export type KeyedLoadOptions<T> = {
  refreshMs?: number;
  /**
   * Whether a resolved value is a failure. Some resources resolve to an explicit unavailable state
   * instead of rejecting, so the refresh lifecycle cannot infer failure from the promise alone.
   * The two kinds of failure back off to different ceilings: an answer the feed did give earns the
   * slower one, where a rejection may be one lost packet on a phone.
   */
  isFailure?: (value: T) => boolean;
  /**
   * Bumping this re-runs the load for the same key: a caller's explicit "ask again" after a read
   * that failed. Whatever the previous load settled on stays visible until the new one answers,
   * and the failure streak the old attempts had earned is forgiven.
   */
  reloadNonce?: number;
};

/**
 * Loads a keyed resource and only exposes a value that belongs to the current key.
 *
 * `null` means nothing has resolved for this key yet. A resolved value may itself be `undefined`,
 * which is how a load says "asked, and there is nothing".
 *
 * Refreshing is a chain of timeouts rather than an interval: each one is scheduled after the last
 * load settled, so a slow source cannot queue requests behind itself. Hidden pages stop polling.
 * A page coming back is heard through every event a browser actually delivers on the way back —
 * `visibilitychange`, `pageshow`, `focus`, `online` — read one tick after the event, because
 * WebKit has delivered the visibility event while the document still read "hidden", and a resumed
 * home-screen app has skipped it entirely. A page that was really away also forgives the backoff:
 * whatever the cadence had slowed to, the reason it slowed may be over. A window merely clicked
 * back into keeps the cadence it earned (`isAwayEvidence`).
 */
export function useKeyedLoad<T>(
  key: string | null,
  load: (key: string) => Promise<T>,
  { refreshMs, isFailure, reloadNonce }: KeyedLoadOptions<T> = {},
): T | undefined | null {
  const [loaded, setLoaded] = useState<LoadedValue<T> | null>(null);

  useEffect(() => {
    if (key === null) return;

    let active = true;
    let timer = 0;
    let resumeTimer = 0;
    let failureStreak: FailureStreak | undefined;
    let lastLoadStartedAt = 0;
    // Set by the event that took the page away and consumed by the one that brings it back, so a
    // return is forgiven once rather than on every focus for as long as the streak stands.
    let hasBeenAway = false;

    const getRefreshDelayMs = () =>
      refreshMs === undefined || !failureStreak
        ? (refreshMs ?? 0)
        : getBackoffDelayMs(refreshMs, failureStreak);

    const scheduleNext = (delayMs = getRefreshDelayMs()) => {
      window.clearTimeout(timer);
      if (!active || refreshMs === undefined || document.visibilityState === "hidden") return;
      timer = window.setTimeout(refresh, Math.max(0, delayMs));
    };

    const settle = (value: T | undefined, failureKind: LoadFailureKind | undefined) => {
      if (!active) return;
      failureStreak = failureKind ? extendFailureStreak(failureStreak, failureKind) : undefined;
      setLoaded({ key, value });
      scheduleNext();
    };

    const refresh = () => {
      lastLoadStartedAt = Date.now();
      load(key).then(
        (value) => settle(value, isFailure?.(value) ? "unavailable" : undefined),
        () => settle(undefined, "transient"),
      );
    };

    const resumeRefreshing = (event: Event) => {
      if (!active || refreshMs === undefined) return;
      if (isAwayEvidence(event.type as ResumeEventType)) hasBeenAway = true;
      // The state an event announces and the state the document reports while it is delivered do
      // not always agree, so the due reading happens one tick after the event rather than in it —
      // which is also where a page on its way out is told from one on its way back.
      window.clearTimeout(resumeTimer);
      resumeTimer = window.setTimeout(() => {
        if (!active || document.visibilityState === "hidden") return;
        if (hasBeenAway) failureStreak = undefined;
        hasBeenAway = false;
        const dueInMs = lastLoadStartedAt + getRefreshDelayMs() - Date.now();
        if (dueInMs <= 0) {
          window.clearTimeout(timer);
          refresh();
          return;
        }
        scheduleNext(dueInMs);
      });
    };

    refresh();
    window.addEventListener("visibilitychange", resumeRefreshing);
    window.addEventListener("pageshow", resumeRefreshing);
    window.addEventListener("focus", resumeRefreshing);
    window.addEventListener("online", resumeRefreshing);

    return () => {
      active = false;
      window.clearTimeout(timer);
      window.clearTimeout(resumeTimer);
      window.removeEventListener("visibilitychange", resumeRefreshing);
      window.removeEventListener("pageshow", resumeRefreshing);
      window.removeEventListener("focus", resumeRefreshing);
      window.removeEventListener("online", resumeRefreshing);
    };
  }, [key, load, refreshMs, isFailure, reloadNonce]);

  return loaded?.key === key ? loaded.value : null;
}
