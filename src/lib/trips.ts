import type { Departure, DepartureBoard, RunSequence } from "../data/transit-types";

/**
 * Run identity, and picking one reading per run.
 *
 * The same vehicle appears on every board it is about to call at, so the boards a view reads
 * describe far fewer runs than they hold departures. Which reading to keep is one question and
 * which readings describe one run is another: a timetable trip is reused on later operating dates,
 * a dated run is not.
 *
 * The word matters here, because three things wear it. A *trip* is the timetable entry, reused
 * every operating day. A *run* is one dated instance of it out on the road, which is what a mark
 * follows and what a request asks about. A *vehicle* is the mark drawn for a run. This module is
 * about runs.
 */

/**
 * The identity a *mark* is followed by: one dated instance, distinct from tomorrow's same trip.
 *
 * One of three keys a run is addressed by, and the only one drawn from the departure alone. The
 * other two are not interchangeable with it and never with each other: `getRunRecordKey`
 * (`data/run-reading-store.ts`) is the provider's address for a run and is what its evidence and
 * its requests are shared under; `getBoardRowKey` (`data/departure-runs.ts`) is what collapses one
 * board's two rows for one run and answers nothing where the feed numbered none.
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
 * When the feed last said anything at all about this copy of a run.
 *
 * The later of the two halves, because either of them is the feed speaking: a row re-read beside an
 * old sequence and a sequence re-read beside an old row are both news. A row with no calls behind
 * it states one half and is as old as that half. Nothing where the departure carries no stamp,
 * which is a fixture rather than anything the source published — an unknown age loses every contest
 * it is in, which is the only safe way for it to lose.
 */
export const getDepartureReadInstant = (departure: Departure): number | undefined =>
  departure.readAt && Math.max(departure.readAt.rowReadAt, departure.readAt.sequenceReadAt ?? 0);

/**
 * Whether one reading of a run's *calls* should displace another: the fresher, then the fuller.
 *
 * The same order `isBetterRunReading` settles a contest between two departures by, minus its first
 * clause: a `RunSequence` always carries calls, so "calls before no calls" can never separate two
 * of them. There is one rule for which reading of a run wins and this is it at the one place the
 * winner is actually kept (`data/run-reading-store.ts`).
 */
export function isBetterSequence(reading: RunSequence, best: RunSequence): boolean {
  const readAt = reading.readAt ?? 0;
  const bestReadAt = best.readAt ?? 0;
  if (readAt !== bestReadAt) return readAt > bestReadAt;
  return reading.tripCalls.length > best.tripCalls.length;
}

/**
 * When the calling sequence of this copy was read, which is the only clock a tolerance may ask.
 *
 * How stale a reading is is not one question. `getDepartureReadInstant` answers "when did the feed last say
 * anything about this copy", which is what ranks two copies against each other; a caller deciding
 * whether to re-read the *calls* is asking about the calls alone. The two agree wherever a sequence
 * is read no earlier than the row carrying it, so asking the wrong one costs nothing today and
 * silently stops re-reading a run the moment that stops being true.
 */
export const getSequenceReadInstant = (departure: Departure): number | undefined =>
  departure.readAt?.sequenceReadAt;

/**
 * The best copy of one run across boards read on different clocks.
 *
 * "Best" is not "longest". The boards a view holds are read on very different cadences — a stop's
 * own trips every thirty seconds, the sampled boards along a line every ninety, the network
 * observation posts every twenty minutes — and every one of them carries the *whole* calling
 * sequence of the runs it lists. Chosen by sequence length alone they all tie, and a tie broken by
 * position in the array goes to whichever board the caller happened to put first. That is how a
 * ride came to publish half-hour-old deviations while a thirty-second reading of the same vehicle
 * sat unused beside it: the times a rider reads on board are these calls and the deviations beside
 * them, so which reading wins is a question about freshness before it is one about completeness.
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
 * Whether one reading of a run should displace another: calls before no calls, then the fresher
 * reading, and only then the fuller sequence. The same order settles every contest between two
 * accounts of one run, whichever board — or single-run request — each of them came from, and it is
 * the only rule that settles one: a view that ranked readings for itself would be a second answer
 * to a question that has one.
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

/** One reading per key, keeping the best of them by `isBetter`. */
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

/** Which of two readings describes more of the route, which is a question about shape, not age. */
const isFullerReading = (reading: Departure, best: Departure): boolean =>
  (reading.tripCalls?.length ?? 0) > (best.tripCalls?.length ?? 0);

/**
 * One entry per *timetable* trip across the runs given.
 *
 * The same trip seen as a board row and as a retained reading is one trip, not two, and two dated
 * runs are two trips even when they share a line. Ranked by how much of the route each reading saw
 * and not by age, because what is being read off these is where the trip goes; the freshest
 * deviations on it are nobody's question here.
 */
export function getDistinctTimetableTrips(departures: readonly Departure[]): Departure[] {
  return keepOnePerKey(
    departures.filter((departure) => departure.tripCalls?.length),
    (departure) => departure.tripId ?? departure.id,
    isFullerReading,
  );
}

/**
 * One entry per *timetable* trip across several boards: twelve departures on line 3 walk the same
 * chain of stops twelve times, and deduplicating first keeps one board from outvoting another when
 * the same vehicle appears on both. Only live boards and only entries carrying a trip contribute.
 */
export function getBoardTimetableTrips(boards: readonly DepartureBoard[]): Departure[] {
  return getDistinctTimetableTrips(
    boards.filter((board) => board.dataStatus === "live").flatMap((board) => board.departures),
  );
}

/**
 * One reading per running vehicle, which is one mark.
 *
 * The copies are ranked the way every contest between readings of a run is ranked. It matters most
 * here: the observation posts along a line answer far more slowly than the boards on the line
 * itself and the same run is usually on both, so a mark taken from whichever copy the caller held
 * first was drawn minutes behind its vehicle and caught up in a jump whenever the slow board
 * refreshed. Entries without a provider identity stand on their own.
 */
export function getDistinctRuns(departures: readonly Departure[]): Departure[] {
  return keepOnePerKey(
    departures,
    (departure) => departure.tripInstanceId ?? departure.tripId,
    isBetterRunReading,
  );
}
