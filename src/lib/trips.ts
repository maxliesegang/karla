import type { Departure, DepartureBoard, TripReading } from "../data/transit-types";

/**
 * Trip identity, and picking one entry per trip.
 *
 * The same vehicle appears on every board it is about to call at, so the boards a view reads
 * describe far fewer trips than they hold departures. Which entry to keep is always the same
 * question — the one that saw most of the trip describes most of the network — and which entries
 * are the same trip is the question that differs: a timetable trip is reused on later operating
 * dates, a dated running instance is not.
 */

/** The identity a *vehicle* is followed by: one dated run, distinct from tomorrow's same trip. */
export const getVehicleTripKey = (departure: Departure): string =>
  departure.tripInstanceId ?? departure.tripId ?? departure.id;

/**
 * Whether two board entries describe the same running vehicle. Boards state different subsets of a
 * trip's identifiers, so any identifier the two agree on settles it.
 */
export function isSameVehicleTrip(left: Departure, right: Departure | undefined): boolean {
  if (!right) return false;
  return (
    left.id === right.id ||
    Boolean(left.tripInstanceId && left.tripInstanceId === right.tripInstanceId) ||
    Boolean(left.tripId && left.tripId === right.tripId)
  );
}

/**
 * The best copy of one trip across boards read on different clocks, dated by the board it was on.
 *
 * "Best" is not "longest". The boards a view holds are read on very different cadences — a stop's
 * own trips every thirty seconds, the sampled boards along a line every ninety, the network
 * observation posts every twenty minutes — and every one of them carries the *whole* calling
 * sequence of the trips it lists. Chosen by sequence length alone they all tie, and a tie broken by
 * position in the array goes to whichever board the caller happened to put first. That is how a
 * ride came to publish half-hour-old deviations while a thirty-second reading of the same vehicle
 * sat unused beside it: the times a rider reads on board are these calls and the deviations beside
 * them, so which reading wins is a question about freshness before it is one about completeness.
 *
 * So a reading that carries the sequence beats one that does not — a plain board's row states no
 * calls at all and can complete nothing — and between two that carry it the fresher board wins.
 */
export function findBestTripReading(
  boards: readonly DepartureBoard[],
  findTrip: (departures: readonly Departure[]) => Departure | undefined,
): TripReading | undefined {
  let best: TripReading | undefined;
  for (const board of boards) {
    const trip = findTrip(board.departures);
    if (!trip) continue;
    const reading = { trip, receivedAt: board.receivedAt };
    if (!best || isBetterTripReading(reading, best)) best = reading;
  }
  return best;
}

/**
 * Whether one reading of a trip should displace another: calls before no calls, then the fresher
 * reading, and only then the fuller sequence. The same order settles every contest between two
 * accounts of one vehicle, whichever board — or one-trip request — each of them came from.
 */
export function isBetterTripReading(reading: TripReading, best: TripReading): boolean {
  const callCount = reading.trip.tripCalls?.length ?? 0;
  const bestCallCount = best.trip.tripCalls?.length ?? 0;
  if (callCount > 0 !== bestCallCount > 0) return callCount > 0;
  if (reading.receivedAt !== best.receivedAt) return reading.receivedAt > best.receivedAt;
  return callCount > bestCallCount;
}

/** One entry per key, keeping the best reading of it: freshest where that is known, then fullest. */
function getLongestTripPerKey(
  departures: Iterable<Departure>,
  getKey: (departure: Departure) => string | undefined,
  readAt?: (departure: Departure) => number,
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
    if (!existing || isBetterVehicleReading(departure, existing, readAt)) {
      byKey.set(key, departure);
    }
  }

  return [...byKey.values(), ...unkeyed];
}

/**
 * Whether one board's copy of a vehicle should displace another's.
 *
 * Every board carries the whole sequence, so the copies tie on completeness and the contest is
 * about age: a line's trips are read off the Zentrum and reach posts on five- and twenty-minute
 * cadences *as well as* off the boards along the line on their own faster ones, and the copies
 * arrive in whatever order the boards are held in. Letting the first copy win let a five-minute-old
 * reading outvote a thirty-second-old one — a mark drawn minutes behind its vehicle, catching up in
 * a jump whenever the slow board refreshed. So the freshest copy wins, exactly the order
 * `findBestTripReading` reads one trip's copies by; between equals the fuller sequence, as before.
 */
function isBetterVehicleReading(
  candidate: Departure,
  existing: Departure,
  readAt: ((departure: Departure) => number) | undefined,
): boolean {
  if (readAt) {
    const candidateAt = readAt(candidate);
    const existingAt = readAt(existing);
    if (candidateAt !== existingAt) return candidateAt > existingAt;
  }
  return (candidate.tripCalls?.length ?? 0) > (existing.tripCalls?.length ?? 0);
}

/**
 * One entry per *timetable* trip across several boards: twelve departures on line 3 walk the same
 * chain of stops twelve times, and deduplicating first keeps one board from outvoting another when
 * the same vehicle appears on both. Only live boards and only entries carrying a trip contribute.
 */
export function getDistinctTimetableTrips(boards: readonly DepartureBoard[]): Departure[] {
  const withTripCalls = boards
    .filter((board) => board.dataStatus === "live")
    .flatMap((board) => board.departures)
    .filter((departure) => departure.tripCalls?.length);
  return getLongestTripPerKey(withTripCalls, (departure) => departure.tripId ?? departure.id);
}

/**
 * One mark per running vehicle. Entries sharing a dated provider trip identity collapse to the one
 * best reading of it — the freshest board's where the caller can say when each was read, else the
 * one describing most of the trip. Entries without a provider identity stand on their own.
 */
export function getDistinctVehicleTrips(
  departures: readonly Departure[],
  readAt?: (departure: Departure) => number,
): Departure[] {
  return getLongestTripPerKey(
    departures,
    (departure) => departure.tripInstanceId ?? departure.tripId,
    readAt,
  );
}
