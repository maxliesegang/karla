import { useMemo } from "react";
import { transitSource } from "../data/transit-source";
import type { Departure } from "../data/transit-types";
import { toSortedIds } from "../lib/collections";
import {
  getRunReadingRequests,
  readRunBatch,
  type RunReadingBatchResult,
} from "../lib/run-reading-requests";
import { DEPARTURE_BOARD_REFRESH_MS } from "./departure-board";
import { useKeyedLoad, type KeyedLoadOptions } from "./keyed-load";
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
    refreshOnEntry = true,
  }: RunReadingOptions = {},
): readonly Departure[] {
  const sortedRowIds = useMemo(() => toSortedIds(rowIds), [rowIds]);
  // Each run under its own tolerance (`getRunReadingRequests`).
  const key = sortedRowIds.length > 0 ? JSON.stringify([sortedRowIds, selectedRowId]) : null;
  const loadOptions = useMemo<KeyedLoadOptions<RunReadingBatchResult<Departure>>>(
    () => ({ refreshMs, isFailure: (result) => result.failedRowIds.length > 0 }),
    [refreshMs],
  );
  useKeyedLoad(
    key,
    (_key, isEntryRead) =>
      readRunBatch(
        getRunReadingRequests(
          {
            rowIds: sortedRowIds,
            maxAgeMs: LINE_RUN_READING_MAX_AGE_MS,
            ...(selectedRowId ? { selectedRowId, selectedMaxAgeMs: refreshMs } : {}),
          },
          // A view's first read looks past the source's cache, so its first marks are not stale.
          isEntryRead && refreshOnEntry,
        ),
        (rowId, maxAgeMs) => transitSource.getRun(rowId, maxAgeMs),
      ),
    loadOptions,
  );
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
