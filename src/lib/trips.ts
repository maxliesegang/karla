import type { Departure, DepartureBoard, RunSequence } from "../data/transit-types";

/**
 * Run identity, and picking one reading per run. A *trip* is the timetable entry, reused every
 * day; a *run* is one dated instance on the road; a *vehicle* is the mark drawn for a run.
 */

/**
 * The key a mark follows: one dated run. Not interchangeable with `getRunRecordKey` (the provider's
 * address, which shares evidence and requests) or `getBoardRowKey` (one board's rows for a run).
 */
export const getRunMarkKey = (departure: Departure): string =>
  departure.tripInstanceId ?? departure.tripId ?? departure.id;

/**
 * Whether two board entries describe the same run. Boards state different subsets of a trip's
 * identifiers, so any identifier the two agree on settles it.
 */
export function isSameRun(left: Departure, right: Departure | undefined): boolean {
  if (!right) return false;
  return (
    left.id === right.id ||
    Boolean(left.tripInstanceId && left.tripInstanceId === right.tripInstanceId) ||
    Boolean(left.tripId && left.tripId === right.tripId)
  );
}

/**
 * When the feed last said anything about this copy: the later of row and sequence. Unstamped
 * (fixtures) loses every contest.
 */
export const getDepartureReadInstant = (departure: Departure): number | undefined =>
  departure.readAt && Math.max(departure.readAt.rowReadAt, departure.readAt.sequenceReadAt ?? 0);

/**
 * Whether one sequence reading should displace another: fresher, then fuller
 * (`isBetterRunReading`).
 */
export function isBetterSequence(reading: RunSequence, best: RunSequence): boolean {
  const readAt = reading.readAt ?? 0;
  const bestReadAt = best.readAt ?? 0;
  if (readAt !== bestReadAt) return readAt > bestReadAt;
  return reading.tripCalls.length > best.tripCalls.length;
}

/**
 * When the calls were read: the clock for deciding whether to re-read them, as opposed to
 * `getDepartureReadInstant`, which ranks copies.
 */
export const getSequenceReadInstant = (departure: Departure): number | undefined =>
  departure.readAt?.sequenceReadAt;

/**
 * The best copy of one run across boards on different cadences (30 s to 20 min). Every board
 * carries whole sequences, so freshness decides before length.
 */
export function findBestRunReading(
  boards: readonly DepartureBoard[],
  findDeparture: (departures: readonly Departure[]) => Departure | undefined,
): Departure | undefined {
  let best: Departure | undefined;
  for (const board of boards) {
    const departure = findDeparture(board.departures);
    if (departure && (!best || isBetterRunReading(departure, best))) best = departure;
  }
  return best;
}

/**
 * Whether one reading should displace another: calls before none, then fresher, then fuller. The
 * one rule for every contest between copies of a run.
 */
export function isBetterRunReading(reading: Departure, best: Departure): boolean {
  const callCount = reading.tripCalls?.length ?? 0;
  const bestCallCount = best.tripCalls?.length ?? 0;
  if (callCount > 0 !== bestCallCount > 0) return callCount > 0;
  const readAt = getDepartureReadInstant(reading) ?? 0;
  const bestReadAt = getDepartureReadInstant(best) ?? 0;
  if (readAt !== bestReadAt) return readAt > bestReadAt;
  return callCount > bestCallCount;
}

/** One reading per key, the best by `isBetter`. */
function keepOnePerKey(
  departures: Iterable<Departure>,
  getKey: (departure: Departure) => string | undefined,
  isBetter: (reading: Departure, best: Departure) => boolean,
): Departure[] {
  const byKey = new Map<string, Departure>();
  const unkeyed: Departure[] = [];

  for (const departure of departures) {
    const key = getKey(departure);
    if (!key) {
      unkeyed.push(departure);
      continue;
    }
    const existing = byKey.get(key);
    if (!existing || isBetter(departure, existing)) byKey.set(key, departure);
  }

  return [...byKey.values(), ...unkeyed];
}

/** Which reading covers more of the route. */
const isFullerReading = (reading: Departure, best: Departure): boolean =>
  (reading.tripCalls?.length ?? 0) > (best.tripCalls?.length ?? 0);

/**
 * One entry per timetable trip. Ranked by route coverage, not age, since these are read for where
 * the trip goes.
 */
export function getDistinctTimetableTrips(departures: readonly Departure[]): Departure[] {
  return keepOnePerKey(
    departures.filter((departure) => departure.tripCalls?.length),
    (departure) => departure.tripId ?? departure.id,
    isFullerReading,
  );
}

/**
 * One entry per timetable trip across live boards, so one board cannot outvote another with the
 * same vehicles.
 */
export function getBoardTimetableTrips(boards: readonly DepartureBoard[]): Departure[] {
  return getDistinctTimetableTrips(
    boards.filter((board) => board.dataStatus === "live").flatMap((board) => board.departures),
  );
}

/**
 * One reading per running vehicle, ranked like every contest between copies, so a slow board's copy
 * does not draw a mark minutes behind. Entries without provider identity stand alone.
 */
export function getDistinctRuns(departures: readonly Departure[]): Departure[] {
  return keepOnePerKey(
    departures,
    (departure) => departure.tripInstanceId ?? departure.tripId,
    isBetterRunReading,
  );
}
