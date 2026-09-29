/** Which runs a view asks for, and how stale an answer each of them may be. */

/** One run to read, and the tolerance this view is asking it under. */
export type RunReadingRequest = { rowId: string; maxAgeMs: number };

/** The answers to one batch, preserving which runs failed instead of filtering that fact away. */
export type RunReadingBatchResult<T> = {
  readings: readonly T[];
  failedRowIds: readonly string[];
};

/**
 * The runs a view reads, with their tolerances stated once each rather than once per run: a set of
 * forty runs has two of them at most — the one the rider chose and every other.
 */
export type RunReadingPlan = {
  rowIds: readonly string[];
  maxAgeMs: number;
  /** The one run a rider chose, which is read on a tolerance of its own. */
  selectedRowId?: string;
  selectedMaxAgeMs?: number;
};

/**
 * The runs a plan names, each under the tolerance the plan states for it. An entry read asks every
 * run for a fresh answer.
 *
 * Read per run and never collapsed across them. Taking the tightest tolerance in the set and
 * applying it to all of them is how the one run a rider chose came to re-read every other run on
 * the line with it — a whole line's sequences on the board's cadence rather than their own, which
 * is the bandwidth the tolerance exists to spend.
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
 * Reads every run independently while retaining partial failure as part of the batch result.
 *
 * A caller may still show the successful readings, but one success cannot turn all of its failed
 * neighbours into a successful refresh and reset the batch's backoff.
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
