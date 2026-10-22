import { useEffect, useMemo, useRef } from "react";
import { transitSource } from "../data/transit-source";
import type { StopEvent } from "../data/transit-types";
import { toSortedIds } from "../lib/collections";
import { getMergeDepartureInstants } from "../lib/merge-stop-events";
import { getDatedJourneyReadingRequests } from "../lib/dated-journey-reading-requests";
import { STOP_EVENT_BOARD_REFRESH_MS } from "./stop-event-board";
import { DatedJourneyReadingPoller } from "./dated-journey-reading-poller";
import { isAwayEvidence, isVisibleResumeEvent, type ResumeEventType } from "./refresh-backoff";
import { useDatedJourneys } from "./dated-journey-reading-store";

/**
 * How stale a dated journey's calls may be before the marks placed from them are re-read: a little
 * over one feed revision, which comes about every thirty-five seconds for a vehicle under way.
 */
export const LINE_DATED_JOURNEY_READING_MAX_AGE_MS = 60_000;

export type DatedJourneyReadingOptions = {
  /** The chosen dated journey, re-read on every board refresh. */
  selectedRowId?: string;
  refreshMs?: number;
  maxAgeMs?: number;
  refreshOnEntry?: boolean;
  /**
   * Re-read each dated journey shortly before it leaves for a merge, given the feed's clock minus
   * the device's.
   */
  readsBeforeMerges?: { feedOffsetMs: number };
};

/**
 * Requests complete calls for the named dated journeys, one request each; answers are read via
 * `useDatedJourneys`.
 */
export function useDatedJourneyReadingsByRowId(
  /** Memoize: it decides the load key. */
  rowIds: readonly string[],
  {
    selectedRowId,
    refreshMs = STOP_EVENT_BOARD_REFRESH_MS,
    maxAgeMs = LINE_DATED_JOURNEY_READING_MAX_AGE_MS,
    refreshOnEntry = true,
    readsBeforeMerges,
  }: DatedJourneyReadingOptions = {},
): readonly StopEvent[] {
  const sortedRowIds = useMemo(() => toSortedIds(rowIds), [rowIds]);
  const requests = useMemo(
    () =>
      getDatedJourneyReadingRequests({
        rowIds: sortedRowIds,
        maxAgeMs,
        ...(selectedRowId ? { selectedRowId, selectedMaxAgeMs: refreshMs } : {}),
      }),
    [sortedRowIds, maxAgeMs, selectedRowId, refreshMs],
  );
  const pollerRef = useRef<DatedJourneyReadingPoller | null>(null);
  useEffect(() => {
    const poller = new DatedJourneyReadingPoller(
      (rowId, age) => transitSource.getDatedJourney(rowId, age),
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
  const datedJourneys = useDatedJourneys(rowIds);
  const feedOffsetMs = readsBeforeMerges?.feedOffsetMs;
  useEffect(() => {
    if (feedOffsetMs === undefined) return;
    const instants = getMergeDepartureInstants(
      rowIds.flatMap((rowId) => {
        const datedJourney = transitSource.findDatedJourney(rowId);
        return datedJourney ? [[rowId, datedJourney] as const] : [];
      }),
    );
    pollerRef.current?.setCheckpoints(
      new Map(
        [...instants].map(([rowId, feedInstants]) => [
          rowId,
          feedInstants.map((instant) => instant - feedOffsetMs),
        ]),
      ),
    );
    // `datedJourneys` changes whenever a reading lands.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [datedJourneys, feedOffsetMs, refreshMs, refreshOnEntry]);
  // Only dated journeys with calls; others stand on their board row meanwhile.
  return useMemo(
    () => datedJourneys.filter((datedJourney) => datedJourney.calls?.length),
    [datedJourneys],
  );
}

/** Reads the named dated journeys now, whatever their age; settles once every read has answered. */
export async function readDatedJourneysNow(rowIds: readonly string[]): Promise<void> {
  await Promise.allSettled(rowIds.map((rowId) => transitSource.getDatedJourney(rowId, 0)));
}

/** Row-based adapter over `useDatedJourneyReadingsByRowId`. */
export function useDatedJourneyReadings(
  stopEvents: readonly StopEvent[],
  options: DatedJourneyReadingOptions = {},
): readonly StopEvent[] {
  const rowIds = useMemo(() => stopEvents.map(({ id }) => id), [stopEvents]);
  return useDatedJourneyReadingsByRowId(rowIds, options);
}
