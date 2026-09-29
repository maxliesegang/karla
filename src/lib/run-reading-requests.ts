/**
 * Which runs a view asks for, and how stale an answer each of them may be.
 *
 * The two are one decision and one key: a view's set of runs and its tolerances change together, so
 * the loader is re-keyed by both and the key is the whole statement of what was asked for.
 */

/** One run to read, and the tolerance this view is asking it under. */
export type RunReadingRequest = { rowId: string; maxAgeMs: number };

/** The answers to one batch, preserving which runs failed instead of filtering that fact away. */
export type RunReadingBatchResult<T> = {
  readings: readonly T[];
  failedRowIds: readonly string[];
};

/**
 * The key is JSON because row ids may contain punctuation from provider names.
 *
 * The tolerances are stated once each rather than once per id: a set of forty runs has two of them
 * at most — the one the rider chose and every other — and a key that repeated a number per row
 * would be forty times the length for nothing.
 */
export type RunReadingKey = {
  rowIds: readonly string[];
  maxAgeMs: number;
  /** The one run a rider chose, which is read on a tolerance of its own. */
  selectedRowId?: string;
  selectedMaxAgeMs?: number;
};

export const createRunReadingKey = (key: RunReadingKey): string => JSON.stringify(key);

/**
 * The runs a key names, each under the tolerance that key states for it.
 *
 * Read per run and never collapsed across them. Taking the tightest tolerance in the set and
 * applying it to all of them is how the one run a rider chose came to re-read every other run on
 * the line with it — a whole line's sequences on the board's cadence rather than their own, which
 * is the bandwidth the tolerance exists to spend.
 */
export function getRunReadingRequests(key: string, entryMaxAgeMs?: number): RunReadingRequest[] {
  const { rowIds, maxAgeMs, selectedRowId, selectedMaxAgeMs } = JSON.parse(key) as RunReadingKey;
  return rowIds.map((rowId) => ({
    rowId,
    maxAgeMs:
      entryMaxAgeMs ??
      (rowId === selectedRowId && selectedMaxAgeMs !== undefined ? selectedMaxAgeMs : maxAgeMs),
  }));
}

/**
 * Reads every run independently while retaining partial failure as part of the batch result.
 *
 * A caller may still show the successful readings, but one success cannot turn all of its failed
 * neighbours into a successful refresh and reset the batch's backoff.
 */
export async function readRunBatch<T>(
  key: string,
  isEntryRead: boolean,
  readRun: (rowId: string, maxAgeMs: number) => Promise<T | undefined>,
): Promise<RunReadingBatchResult<T>> {
  const answers = await Promise.all(
    getRunReadingRequests(key, isEntryRead ? 0 : undefined).map(async (request) => ({
      rowId: request.rowId,
      reading: await readRun(request.rowId, request.maxAgeMs).catch(() => undefined),
    })),
  );
  return {
    readings: answers.flatMap(({ reading }) => (reading === undefined ? [] : [reading])),
    failedRowIds: answers.flatMap(({ rowId, reading }) => (reading === undefined ? [rowId] : [])),
  };
}
