import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
  extendFailureStreak,
  getBackoffDelayMs,
  isAwayEvidence,
  isVisibleResumeEvent,
  type FailureStreak,
  type LoadFailureKind,
  type ResumeEventType,
} from "./refresh-backoff";

type LoadedValue<T> = { key: string; value: T | undefined };

/**
 * Reads the resource `key` names. `isEntryRead` is true for a mounted caller's first read, where a
 * stale answer costs most; a loader may then ask for a fresh one.
 */
export type KeyedLoad<T> = (key: string, isEntryRead: boolean) => Promise<T>;

export type KeyedLoadOptions<T> = {
  refreshMs?: number;
  /**
   * What kind of failure a resolved value is, for resources that resolve to a failed state rather
   * than reject. A rejection is always `transient`.
   */
  getFailureKind?: (value: T) => LoadFailureKind | undefined;
  /**
   * Bumping it re-runs the load for the same key; the last value stays and the backoff is forgiven.
   */
  reloadNonce?: number;
};

/**
 * Loads a keyed resource and exposes only a value for the current key. `null`: nothing resolved
 * yet; `undefined` is a valid resolved "nothing". The latest `load` and `getFailureKind` are always
 * used.
 *
 * Refreshes chain timeouts after each settled load, so a slow source never queues. Hidden pages
 * stop polling. Returning is detected via `visibilitychange`, `pageshow`, `focus` and `online`, one
 * tick after the event (WebKit can report "hidden" during it, and resumed home-screen apps skip
 * it). A real absence forgives the backoff; a mere refocus does not (`isAwayEvidence`).
 */
export function useKeyedLoad<T>(
  key: string | null,
  load: KeyedLoad<T>,
  { refreshMs, getFailureKind, reloadNonce }: KeyedLoadOptions<T> = {},
): T | undefined | null {
  const [loaded, setLoaded] = useState<LoadedValue<T> | null>(null);
  const hasEntryRead = useRef(false);
  const read = useEffectEvent((key: string) => {
    const isEntryRead = !hasEntryRead.current;
    hasEntryRead.current = true;
    return load(key, isEntryRead);
  });
  const findFailureKind = useEffectEvent((value: T) => getFailureKind?.(value));

  useEffect(() => {
    if (key === null) return;

    let active = true;
    let timer = 0;
    let resumeTimer = 0;
    let failureStreak: FailureStreak | undefined;
    let lastLoadStartedAt = 0;
    // Only the newest request publishes: a request Safari suspended can land after the fresh one.
    let loadSequence = 0;
    // Set when the page goes away, consumed on return, so the backoff is forgiven once.
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

    const settle = (
      sequence: number,
      value: T | undefined,
      failureKind: LoadFailureKind | undefined,
    ) => {
      if (!active || sequence !== loadSequence) return;
      failureStreak = failureKind ? extendFailureStreak(failureStreak, failureKind) : undefined;
      setLoaded({ key, value });
      scheduleNext();
    };

    const refresh = () => {
      const sequence = ++loadSequence;
      lastLoadStartedAt = Date.now();
      read(key).then(
        (value) => settle(sequence, value, findFailureKind(value)),
        () => settle(sequence, undefined, "transient"),
      );
    };

    const resumeRefreshing = (event: Event) => {
      if (!active || refreshMs === undefined) return;
      const eventType = event.type as ResumeEventType;
      if (isAwayEvidence(eventType)) hasBeenAway = true;
      // Read one tick later, when the document's state matches the event.
      window.clearTimeout(resumeTimer);
      resumeTimer = window.setTimeout(() => {
        if (!active || !isVisibleResumeEvent(eventType, document.visibilityState)) return;
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
  }, [key, refreshMs, reloadNonce]);

  return loaded?.key === key ? loaded.value : null;
}
