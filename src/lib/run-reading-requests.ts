/** Which runs a view asks for, and how stale an answer each of them may be. */

/** One run to read and the tolerance it is asked under. */
export type RunReadingRequest = { rowId: string; maxAgeMs: number };

/** One batch's answers, keeping which runs failed. */
export type RunReadingBatchResult<T> = {
  readings: readonly T[];
  failedRowIds: readonly string[];
};

/**
 * The runs a view reads, with tolerances stated once each: the chosen run's and everyone else's.
 */
export type RunReadingPlan = {
  rowIds: readonly string[];
  maxAgeMs: number;
  /** The chosen run, read on its own tolerance. */
  selectedRowId?: string;
  selectedMaxAgeMs?: number;
};

/**
 * Each run under its own tolerance; an entry read asks for fresh answers. Never collapsed to the
 * tightest, or the chosen run would drag every run onto its cadence.
 */
export function getRunReadingRequests(
  { rowIds, maxAgeMs, selectedRowId, selectedMaxAgeMs }: RunReadingPlan,
  isEntryRead = false,
): RunReadingRequest[] {
  return rowIds.map((rowId) => ({
    rowId,
    maxAgeMs: isEntryRead
      ? 0
      : rowId === selectedRowId && selectedMaxAgeMs !== undefined
        ? selectedMaxAgeMs
        : maxAgeMs,
  }));
}

/**
 * Reads every run independently; one success does not hide failed neighbours or reset the backoff.
 */
export async function readRunBatch<T>(
  requests: readonly RunReadingRequest[],
  readRun: (rowId: string, maxAgeMs: number) => Promise<T | undefined>,
): Promise<RunReadingBatchResult<T>> {
  const answers = await Promise.all(
    requests.map(async (request) => ({
      rowId: request.rowId,
      reading: await readRun(request.rowId, request.maxAgeMs).catch(() => undefined),
    })),
  );
  return {
    readings: answers.flatMap(({ reading }) => (reading === undefined ? [] : [reading])),
    failedRowIds: answers.flatMap(({ rowId, reading }) => (reading === undefined ? [rowId] : [])),
  };
}
