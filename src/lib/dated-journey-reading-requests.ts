/** Which dated journeys a view asks for, and how stale an answer each of them may be. */

/** One dated journey to read and the tolerance it is asked under. */
export type DatedJourneyReadingRequest = { rowId: string; maxAgeMs: number };

/** One batch's answers, keeping which dated journeys failed. */
export type DatedJourneyReadingBatchResult<T> = {
  readings: readonly T[];
  failedRowIds: readonly string[];
};

/**
 * The dated journeys a view reads, with tolerances stated once each: the chosen dated journey's and
 * everyone else's.
 */
export type DatedJourneyReadingPlan = {
  rowIds: readonly string[];
  maxAgeMs: number;
  /** The chosen dated journey, read on its own tolerance. */
  selectedRowId?: string;
  selectedMaxAgeMs?: number;
};

/**
 * Each dated journey under its own tolerance; an entry read asks for fresh answers. Never collapsed
 * to the tightest, or the chosen dated journey would drag every dated journey onto its cadence.
 */
export function getDatedJourneyReadingRequests(
  { rowIds, maxAgeMs, selectedRowId, selectedMaxAgeMs }: DatedJourneyReadingPlan,
  isEntryRead = false,
): DatedJourneyReadingRequest[] {
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
 * Reads every dated journey independently; one success does not hide failed neighbours or reset the
 * backoff.
 */
export async function readDatedJourneyBatch<T>(
  requests: readonly DatedJourneyReadingRequest[],
  readDatedJourney: (rowId: string, maxAgeMs: number) => Promise<T | undefined>,
): Promise<DatedJourneyReadingBatchResult<T>> {
  const answers = await Promise.all(
    requests.map(async (request) => ({
      rowId: request.rowId,
      reading: await readDatedJourney(request.rowId, request.maxAgeMs).catch(() => undefined),
    })),
  );
  return {
    readings: answers.flatMap(({ reading }) => (reading === undefined ? [] : [reading])),
    failedRowIds: answers.flatMap(({ rowId, reading }) => (reading === undefined ? [rowId] : [])),
  };
}
