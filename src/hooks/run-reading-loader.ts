import { useMemo } from "react";
import { transitSource } from "../data/transit-source";
import type { Departure } from "../data/transit-types";
import { toSortedIds } from "../lib/collections";
import {
  createRunReadingKey,
  readRunBatch,
  type RunReadingBatchResult,
} from "../lib/run-reading-requests";
import { DEPARTURE_BOARD_REFRESH_MS } from "./departure-board";
import { createFreshEntryLoad, useKeyedLoad, type KeyedLoadOptions } from "./keyed-load";
import { useRuns } from "./run-reading-store";

/** How stale a run's calls may be before the marks placed from them are re-read. */
export const LINE_RUN_READING_MAX_AGE_MS = 60_000;

/** The runs the key names, each read on the tolerance the key states for it (`lib/run-reading-requests`). */
const loadRunReadings = (key: string, isEntryRead: boolean) =>
  // A view's first read looks past the source's cache, so its first marks are not already stale.
  readRunBatch(key, isEntryRead, (rowId, maxAgeMs) => transitSource.getRun(rowId, maxAgeMs));

export type RunReadingOptions = {
  /** The one run a rider chose, which is worth re-reading on every board refresh. */
  selectedRowId?: string;
  refreshMs?: number;
};

/**
 * Complete calls for the named runs, one provider request per run. This asks; the answers land in
 * the source's store and are read back from it by id (`useRuns`).
 */
export function useRunReadingsByRowId(
  /** Memoize this: it decides the load key and the identity of everything read from the result. */
  rowIds: readonly string[],
  { selectedRowId, refreshMs = DEPARTURE_BOARD_REFRESH_MS }: RunReadingOptions = {},
): readonly Departure[] {
  const sortedRowIds = useMemo(() => toSortedIds(rowIds), [rowIds]);
  // Each run under its own tolerance (`getRunReadingRequests`).
  const key = useMemo(
    () =>
      sortedRowIds.length > 0
        ? createRunReadingKey({
            rowIds: sortedRowIds,
            maxAgeMs: LINE_RUN_READING_MAX_AGE_MS,
            ...(selectedRowId ? { selectedRowId, selectedMaxAgeMs: refreshMs } : {}),
          })
        : null,
    [refreshMs, selectedRowId, sortedRowIds],
  );
  const loadOptions = useMemo<KeyedLoadOptions<RunReadingBatchResult<Departure>>>(
    () => ({ refreshMs, isFailure: (result) => result.failedRowIds.length > 0 }),
    [refreshMs],
  );
  const load = useMemo(() => createFreshEntryLoad(loadRunReadings), []);
  useKeyedLoad(key, load, loadOptions);
  // Read back in the order asked for, not the key's sorted order.
  const runs = useRuns(rowIds);
  // Only runs whose calls have been read; a row still waiting stands on its board meanwhile.
  return useMemo(() => runs.filter((run) => run.tripCalls?.length), [runs]);
}

/** The departure rows' ids are only an adapter: the run-reading path is the same one everywhere. */
export function useRunReadings(
  departures: readonly Departure[],
  options: RunReadingOptions = {},
): readonly Departure[] {
  const rowIds = useMemo(() => departures.map(({ id }) => id), [departures]);
  return useRunReadingsByRowId(rowIds, options);
}
