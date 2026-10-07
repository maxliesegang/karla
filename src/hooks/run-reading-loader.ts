import { useEffect, useMemo, useRef } from "react";
import { transitSource } from "../data/transit-source";
import type { Departure } from "../data/transit-types";
import { toSortedIds } from "../lib/collections";
import { getRunReadingRequests } from "../lib/run-reading-requests";
import { DEPARTURE_BOARD_REFRESH_MS } from "./departure-board";
import { RunReadingPoller } from "./run-reading-poller";
import { isAwayEvidence, isVisibleResumeEvent, type ResumeEventType } from "./refresh-backoff";
import { useRuns } from "./run-reading-store";

/**
 * How stale a run's calls may be before the marks placed from them are re-read: a little over one
 * feed revision, which comes about every thirty-five seconds for a vehicle under way.
 */
export const LINE_RUN_READING_MAX_AGE_MS = 60_000;

export type RunReadingOptions = {
  /** The chosen run, re-read on every board refresh. */
  selectedRowId?: string;
  refreshMs?: number;
  maxAgeMs?: number;
  refreshOnEntry?: boolean;
};

/**
 * Requests complete calls for the named runs, one request per run; answers are read via `useRuns`.
 */
export function useRunReadingsByRowId(
  /** Memoize: it decides the load key. */
  rowIds: readonly string[],
  {
    selectedRowId,
    refreshMs = DEPARTURE_BOARD_REFRESH_MS,
    maxAgeMs = LINE_RUN_READING_MAX_AGE_MS,
    refreshOnEntry = true,
  }: RunReadingOptions = {},
): readonly Departure[] {
  const sortedRowIds = useMemo(() => toSortedIds(rowIds), [rowIds]);
  const requests = useMemo(
    () =>
      getRunReadingRequests({
        rowIds: sortedRowIds,
        maxAgeMs,
        ...(selectedRowId ? { selectedRowId, selectedMaxAgeMs: refreshMs } : {}),
      }),
    [sortedRowIds, maxAgeMs, selectedRowId, refreshMs],
  );
  const pollerRef = useRef<RunReadingPoller | null>(null);
  useEffect(() => {
    const poller = new RunReadingPoller(
      (rowId, age) => transitSource.getRun(rowId, age),
      refreshMs,
      refreshOnEntry,
    );
    pollerRef.current = poller;
    let resumeTimer = 0;
    let hasBeenAway = false;
    const resume = (event: Event) => {
      const type = event.type as ResumeEventType;
      if (document.visibilityState === "hidden" && type === "visibilitychange") {
        hasBeenAway = true;
        poller.pause();
        return;
      }
      hasBeenAway ||= isAwayEvidence(type);
      window.clearTimeout(resumeTimer);
      resumeTimer = window.setTimeout(() => {
        if (!isVisibleResumeEvent(type, document.visibilityState)) return;
        poller.resume(hasBeenAway);
        hasBeenAway = false;
      });
    };
    for (const event of ["visibilitychange", "pageshow", "focus", "online"])
      window.addEventListener(event, resume);
    return () => {
      poller.stop();
      pollerRef.current = null;
      window.clearTimeout(resumeTimer);
      for (const event of ["visibilitychange", "pageshow", "focus", "online"])
        window.removeEventListener(event, resume);
    };
  }, [refreshMs, refreshOnEntry]);
  useEffect(() => pollerRef.current?.update(requests), [requests, refreshMs, refreshOnEntry]);
  // Read back in the order asked for, not the key's sorted order.
  const runs = useRuns(rowIds);
  // Only runs with calls; others stand on their board row meanwhile.
  return useMemo(() => runs.filter((run) => run.tripCalls?.length), [runs]);
}

/** Row-based adapter over `useRunReadingsByRowId`. */
export function useRunReadings(
  departures: readonly Departure[],
  options: RunReadingOptions = {},
): readonly Departure[] {
  const rowIds = useMemo(() => departures.map(({ id }) => id), [departures]);
  return useRunReadingsByRowId(rowIds, options);
}
