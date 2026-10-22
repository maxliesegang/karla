import type { StopEvent, StopEventBoard, DatedJourneyCalls } from "../data/transit-types";

/**
 * Dated journey identity, and picking one reading per dated journey. A *journey* is the timetable
 * entry, reused every day; a *dated journey* is one dated instance on the road; a *vehicle* is the
 * mark drawn for a dated journey.
 */

/**
 * The key a mark follows: one dated journey. Not interchangeable with `getJourneyRecordKey`
 * (the provider's address, which shares evidence and requests) or `getBoardRowKey` (one board's
 * rows for a dated journey).
 */
export const getDatedJourneyMarkKey = (stopEvent: StopEvent): string =>
  stopEvent.datedJourneyId ?? stopEvent.journeyRef ?? stopEvent.id;

/**
 * Whether two board entries describe the same dated journey. Boards state different subsets of a
 * journey's identifiers, so any identifier the two agree on settles it.
 */
export function isSameDatedJourney(left: StopEvent, right: StopEvent | undefined): boolean {
  if (!right) return false;
  return (
    left.id === right.id ||
    Boolean(left.datedJourneyId && left.datedJourneyId === right.datedJourneyId) ||
    Boolean(left.journeyRef && left.journeyRef === right.journeyRef)
  );
}

/**
 * When the feed last said anything about this copy: the later of row and sequence. Unstamped
 * (fixtures) loses every contest.
 */
export const getStopEventReadInstant = (stopEvent: StopEvent): number | undefined =>
  stopEvent.readAt && Math.max(stopEvent.readAt.rowReadAt, stopEvent.readAt.sequenceReadAt ?? 0);

/**
 * Whether one sequence reading should displace another: fresher, then fuller
 * (`isBetterDatedJourneyReading`).
 */
export function isBetterSequence(reading: DatedJourneyCalls, best: DatedJourneyCalls): boolean {
  const readAt = reading.readAt ?? 0;
  const bestReadAt = best.readAt ?? 0;
  if (readAt !== bestReadAt) return readAt > bestReadAt;
  return reading.calls.length > best.calls.length;
}

/**
 * A row with only its stop's facts: a board's calls are that board's observation, not the dated
 * journey's.
 */
export const withoutDatedJourneyCalls = ({ readAt, ...stopEvent }: StopEvent): StopEvent => ({
  ...stopEvent,
  calls: undefined,
  ...(readAt ? { readAt: { rowReadAt: readAt.rowReadAt } } : {}),
});

/**
 * When the calls were read: the clock for deciding whether to re-read them, as opposed to
 * `getStopEventReadInstant`, which ranks copies.
 */
export const getSequenceReadInstant = (stopEvent: StopEvent): number | undefined =>
  stopEvent.readAt?.sequenceReadAt;

/**
 * The best copy of one dated journey across boards on different cadences (30 s to 20 min). Every
 * board carries whole sequences, so freshness decides before length.
 */
export function findBestDatedJourneyReading(
  boards: readonly StopEventBoard[],
  findStopEvent: (stopEvents: readonly StopEvent[]) => StopEvent | undefined,
): StopEvent | undefined {
  let best: StopEvent | undefined;
  for (const board of boards) {
    const stopEvent = findStopEvent(board.stopEvents);
    if (stopEvent && (!best || isBetterDatedJourneyReading(stopEvent, best))) best = stopEvent;
  }
  return best;
}

/**
 * Whether one reading should displace another: calls before none, then fresher, then fuller. The
 * one rule for every contest between copies of a dated journey.
 */
export function isBetterDatedJourneyReading(reading: StopEvent, best: StopEvent): boolean {
  const callCount = reading.calls?.length ?? 0;
  const bestCallCount = best.calls?.length ?? 0;
  if (callCount > 0 !== bestCallCount > 0) return callCount > 0;
  const readAt = getStopEventReadInstant(reading) ?? 0;
  const bestReadAt = getStopEventReadInstant(best) ?? 0;
  if (readAt !== bestReadAt) return readAt > bestReadAt;
  return callCount > bestCallCount;
}

/** One reading per key, the best by `isBetter`. */
function keepOnePerKey(
  stopEvents: Iterable<StopEvent>,
  getKey: (stopEvent: StopEvent) => string | undefined,
  isBetter: (reading: StopEvent, best: StopEvent) => boolean,
): StopEvent[] {
  const byKey = new Map<string, StopEvent>();
  const unkeyed: StopEvent[] = [];

  for (const stopEvent of stopEvents) {
    const key = getKey(stopEvent);
    if (!key) {
      unkeyed.push(stopEvent);
      continue;
    }
    const existing = byKey.get(key);
    if (!existing || isBetter(stopEvent, existing)) byKey.set(key, stopEvent);
  }

  return [...byKey.values(), ...unkeyed];
}

/** Which reading covers more of the route. */
const isFullerReading = (reading: StopEvent, best: StopEvent): boolean =>
  (reading.calls?.length ?? 0) > (best.calls?.length ?? 0);

/**
 * One entry per timetable journey. Ranked by route coverage, not age, since these are read for
 * where the journey goes.
 */
export function getDistinctTimetableJourneys(stopEvents: readonly StopEvent[]): StopEvent[] {
  return keepOnePerKey(
    stopEvents.filter((stopEvent) => stopEvent.calls?.length),
    (stopEvent) => stopEvent.journeyRef ?? stopEvent.id,
    isFullerReading,
  );
}

/**
 * One entry per timetable journey across live boards, so one board cannot outvote another with the
 * same vehicles.
 */
export function getBoardTimetableJourneys(boards: readonly StopEventBoard[]): StopEvent[] {
  return getDistinctTimetableJourneys(
    boards.filter((board) => board.dataStatus === "live").flatMap((board) => board.stopEvents),
  );
}

/**
 * One reading per running vehicle, ranked like every contest between copies, so a slow board's copy
 * does not draw a mark minutes behind. Entries without provider identity stand alone.
 */
export function getDistinctDatedJourneys(stopEvents: readonly StopEvent[]): StopEvent[] {
  return keepOnePerKey(
    stopEvents,
    (stopEvent) => stopEvent.datedJourneyId ?? stopEvent.journeyRef,
    isBetterDatedJourneyReading,
  );
}
